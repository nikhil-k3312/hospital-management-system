const crypto = require('crypto');
const { ethers } = require('ethers');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Anchors fingerprints of medical data in the HealthRecordRegistry contract.
 * Only hashes go on-chain: the record or file hash, and an HMAC of the patient id.
 * Names, diagnoses, files and even plain patient ids never leave the hospital's systems.
 */
const ABI = [
  'function anchor(bytes32 key, bytes32 dataHash, bytes32 patientRef, uint8 kind)',
  'function verify(bytes32 key, bytes32 dataHash) view returns (bool)',
  'function getAnchor(bytes32 key) view returns (tuple(bytes32 dataHash, bytes32 patientRef, uint64 anchoredAt, address hospital, uint8 kind))',
  'function anchorsOf(bytes32 patientRef) view returns (bytes32[])',
];

const KIND = { record: 1, file: 2, ledger: 3 };

class BlockchainService {
  constructor(cfg = config.chain) {
    this.cfg = cfg;
    this.contract = null;
  }

  get enabled() {
    return Boolean(this.cfg.rpcUrl && this.cfg.contractAddress && this.cfg.privateKey && this.cfg.patientRefSecret);
  }

  registry() {
    if (!this.contract) {
      const provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
      // The API is the only writer for its hospital key, so it can count nonces itself;
      // asking the node each time races when two anchors are sent back to back.
      this.signer = new ethers.NonceManager(new ethers.Wallet(this.cfg.privateKey, provider));
      this.contract = new ethers.Contract(this.cfg.contractAddress, ABI, this.signer);
    }
    return this.contract;
  }

  /** Lookup id for one version of one entity, e.g. "record:<id>:3". */
  static keyFor(entityType, entityId, version) {
    return ethers.keccak256(ethers.toUtf8Bytes(`${entityType}:${entityId}:${version}`));
  }

  /** Pseudonymous patient reference: without PATIENT_REF_SECRET it cannot be linked to a patient. */
  patientRef(patientId) {
    if (!patientId) return ethers.ZeroHash;
    return `0x${crypto.createHmac('sha256', this.cfg.patientRefSecret).update(String(patientId)).digest('hex')}`;
  }

  static toBytes32(hexHash) {
    return hexHash.startsWith('0x') ? hexHash : `0x${hexHash}`;
  }

  /**
   * Writes one anchor and waits for it to be mined.
   * Returns { status: 'anchored', key, txHash, blockNumber } or, when the chain
   * is switched off or unreachable, { status: 'disabled' | 'pending', key } so the
   * caller keeps working and scripts/anchor-pending.js can retry later.
   */
  async anchor({ entityType, entityId, version, dataHash, patientId }) {
    const key = BlockchainService.keyFor(entityType, entityId, version);
    if (!this.enabled) return { status: 'disabled', key };
    try {
      const tx = await this.registry().anchor(key, BlockchainService.toBytes32(dataHash), this.patientRef(patientId), KIND[entityType]);
      const receipt = await tx.wait();
      return { status: 'anchored', key, txHash: receipt.hash, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (String(error.message).includes('already anchored')) return { status: 'anchored', key, txHash: null };
      if (this.signer) this.signer.reset(); // re-read the nonce from the node next time
      logger.warn(`Blockchain anchor failed for ${entityType} ${entityId} v${version}: ${error.shortMessage || error.message}`);
      return { status: 'pending', key };
    }
  }

  /** Compares a freshly computed hash with what the chain holds for that key. */
  async verify({ entityType, entityId, version, dataHash }) {
    const key = BlockchainService.keyFor(entityType, entityId, version);
    if (!this.enabled) return { checked: false, reason: 'chain_disabled', key };
    try {
      const anchor = await this.registry().getAnchor(key);
      if (anchor.anchoredAt === 0n) return { checked: true, anchored: false, matches: false, key };
      return {
        checked: true,
        anchored: true,
        matches: anchor.dataHash === BlockchainService.toBytes32(dataHash),
        anchoredAt: new Date(Number(anchor.anchoredAt) * 1000).toISOString(),
        hospital: anchor.hospital,
        key,
      };
    } catch (error) {
      return { checked: false, reason: 'chain_unreachable', key };
    }
  }
}

module.exports = new BlockchainService();
module.exports.BlockchainService = BlockchainService;
module.exports.KIND = KIND;
