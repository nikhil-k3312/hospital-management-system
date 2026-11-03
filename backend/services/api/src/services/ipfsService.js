const crypto = require('crypto');
const config = require('../config/config');
const { sha256 } = require('../utils/hash');

/**
 * Stores medical files on IPFS through a Kubo node's HTTP API.
 *
 * IPFS is public by design: anyone holding a CID can fetch the bytes. So a file
 * is encrypted with AES-256-GCM BEFORE it leaves the API, and only ciphertext is
 * ever on IPFS. Layout of the stored blob:  iv (12 bytes) | auth tag (16) | ciphertext.
 * The CID and the plaintext SHA-256 stay in MongoDB; the SHA-256 is also
 * anchored on the blockchain.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

class IpfsService {
  constructor(cfg = config.ipfs) {
    this.cfg = cfg;
  }

  get enabled() {
    return Boolean(this.cfg.apiUrl && this.cfg.encryptionKey);
  }

  key() {
    return Buffer.from(this.cfg.encryptionKey, 'hex');
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob) {
    if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('IPFS_BLOB_TOO_SHORT');
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAuthTag(tag); // a changed byte anywhere makes final() throw
    return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  }

  async call(path, init) {
    let response;
    try {
      response = await fetch(`${this.cfg.apiUrl}${path}`, { method: 'POST', ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (error) {
      throw new Error('IPFS_UNAVAILABLE');
    }
    if (!response.ok) throw new Error(`IPFS_ERROR_${response.status}`);
    return response;
  }

  /** Adds bytes to IPFS, pinned so the node's garbage collector keeps them. Returns the CID. */
  async add(bytes) {
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'blob');
    const response = await this.call('/api/v0/add?pin=true&cid-version=1', { body: form });
    const { Hash } = await response.json();
    return Hash;
  }

  async cat(cid) {
    const response = await this.call(`/api/v0/cat?arg=${encodeURIComponent(cid)}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Encrypts and uploads a file. Returns what MongoDB keeps: CID, plaintext hash and sizes. */
  async storeFile(plain) {
    if (!this.enabled) throw new Error('IPFS_NOT_CONFIGURED');
    const encrypted = this.encrypt(plain);
    const cid = await this.add(encrypted);
    return { cid, sha256: sha256(plain), size: plain.length, encryptedSize: encrypted.length };
  }

  /**
   * Downloads, decrypts and checks a file against the hash recorded at upload.
   * Throws IPFS_HASH_MISMATCH rather than return bytes that are not the original.
   */
  async fetchFile(cid, expectedSha256) {
    if (!this.enabled) throw new Error('IPFS_NOT_CONFIGURED');
    const plain = this.decrypt(await this.cat(cid));
    if (expectedSha256 && sha256(plain) !== expectedSha256) throw new Error('IPFS_HASH_MISMATCH');
    return plain;
  }
}

module.exports = new IpfsService();
module.exports.IpfsService = IpfsService;
