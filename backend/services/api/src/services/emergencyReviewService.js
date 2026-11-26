const { ethers } = require('ethers');
const config = require('../config/config');
const logger = require('../utils/logger');
const { sha256 } = require('../utils/hash');
const EmergencyCase = require('../models/EmergencyCase');
const blockchainService = require('./blockchainService');
const { RoleService } = require('./roleService');

/**
 * Emergency sign-in reviews on the blockchain (decision D12, guide 26 Nov 2026).
 *
 * Every emergency sign-in opens a case in the EmergencyReview contract, written with the hospital's
 * key at the moment it happens. Administrators give their verdict ("justified" or "misuse") with
 * their OWN wallets; the server only builds the transaction and never holds an administrator key.
 * A case closes when k of the n administrators (same k and administrators as the RoleRegistry)
 * agree, so no single administrator can quietly close it.
 */
const ABI = [
  'function openCase(bytes32 caseId, bytes32 subject, bytes32 reasonHash)',
  'function review(bytes32 caseId, uint8 verdict)',
  'function getCase(bytes32 caseId) view returns (tuple(bytes32 subject, bytes32 reasonHash, uint64 openedAt, uint64 closedAt, uint8 justifiedVotes, uint8 misuseVotes, uint8 verdict, uint32 epoch))',
  'function caseCount() view returns (uint256)',
  'function governors() view returns (address)',
  'function recorder() view returns (address)',
];
const VERDICT = { justified: 1, misuse: 2 };
const VERDICT_NAME = { 0: null, 1: 'justified', 2: 'misuse' };
const GOVERNORS_ABI = ['function threshold() view returns (uint8)', 'function governorCount() view returns (uint8)', 'function governorEpoch() view returns (uint32)'];

const iface = new ethers.Interface(ABI);

class EmergencyReviewService {
  constructor(cfg = config.chain) {
    this.cfg = cfg;
  }

  get enabled() {
    return Boolean(blockchainService.enabled && this.cfg.emergencyReviewAddress);
  }

  writeContract() {
    return new ethers.Contract(this.cfg.emergencyReviewAddress, ABI, blockchainService.writer());
  }

  readContract() {
    if (!this.reader) {
      this.provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
      this.reader = new ethers.Contract(this.cfg.emergencyReviewAddress, ABI, this.provider);
    }
    return this.reader;
  }

  /**
   * Records an emergency sign-in. `entry` is the ledger entry of the sign-in (its hash is the case id,
   * so the on-chain case and the tamper-evident ledger point at each other). The case is saved at
   * once; the on-chain write runs in the background so the clinician is not kept waiting for a block.
   */
  async open({ user, entry, reason, trustScore }) {
    if (!entry || !entry.entryHash) throw new Error('emergency case needs the ledger entry of the sign-in');
    const salt = await RoleService.ensureSalt(user);
    const doc = await EmergencyCase.create({
      caseId: `0x${entry.entryHash}`,
      user: user._id,
      role: user.role,
      reason,
      reasonHash: `0x${sha256(reason)}`,
      subject: RoleService.subjectOf(user._id.toString(), salt),
      ledgerSeq: entry.seq,
      trustScore,
      openedAt: entry.timestamp || new Date(),
      chainStatus: this.enabled ? 'pending' : 'disabled',
    });
    const written = this.enabled ? this.record(doc) : Promise.resolve(doc);
    return { case: doc, written };
  }

  /** Writes one case to the contract; marks it recorded, or leaves it pending for a retry. */
  async record(doc) {
    try {
      const tx = await this.writeContract().openCase(doc.caseId, doc.subject, doc.reasonHash);
      const receipt = await tx.wait();
      Object.assign(doc, { chainStatus: 'recorded', txHash: receipt.hash, error: null });
    } catch (error) {
      const message = error.shortMessage || error.message;
      if (String(message).includes('case exists')) Object.assign(doc, { chainStatus: 'recorded', error: null });
      else {
        if (blockchainService.signer) blockchainService.signer.reset(); // re-read the nonce from the node next time
        Object.assign(doc, { chainStatus: 'pending', error: message });
        logger.warn(`Emergency case ${doc.caseId} not recorded on-chain yet: ${message}`);
      }
    }
    await doc.save();
    return doc;
  }

  /** Re-sends the cases that could not be written (chain down). Used by scripts/anchor-pending.js. */
  async retryPending() {
    if (!this.enabled) return { retried: 0, recorded: 0 };
    const pending = await EmergencyCase.find({ chainStatus: 'pending' });
    let recorded = 0;
    for (const doc of pending) {
      if ((await this.record(doc)).chainStatus === 'recorded') recorded += 1;
    }
    return { retried: pending.length, recorded };
  }

  /** Unsigned transaction for an administrator's wallet: their verdict on one case. */
  reviewTx(caseId, verdict) {
    return { to: this.cfg.emergencyReviewAddress, data: iface.encodeFunctionData('review', [caseId, VERDICT[verdict]]) };
  }

  async status() {
    if (!this.enabled) return { enabled: false };
    const c = this.readContract();
    const governors = new ethers.Contract(await c.governors(), GOVERNORS_ABI, this.provider);
    const [threshold, governorCount, epoch, network] = await Promise.all([
      governors.threshold(), governors.governorCount(), governors.governorEpoch(), this.provider.getNetwork()]);
    return {
      enabled: true, address: this.cfg.emergencyReviewAddress, chainId: Number(network.chainId),
      threshold: Number(threshold), governorCount: Number(governorCount), governorEpoch: Number(epoch),
    };
  }

  /** On-chain state of one case: { recorded, verdict, justifiedVotes, misuseVotes, closedAt, epoch }. */
  async onChain(caseId) {
    try {
      const c = await this.readContract().getCase(caseId);
      return {
        recorded: true, verdict: VERDICT_NAME[Number(c.verdict)], justifiedVotes: Number(c.justifiedVotes),
        misuseVotes: Number(c.misuseVotes), epoch: Number(c.epoch),
        closedAt: Number(c.closedAt) ? new Date(Number(c.closedAt) * 1000).toISOString() : null,
        reasonHash: c.reasonHash,
      };
    } catch (error) {
      return { recorded: false };
    }
  }
}

module.exports = new EmergencyReviewService();
module.exports.EmergencyReviewService = EmergencyReviewService;
module.exports.VERDICT = VERDICT;
