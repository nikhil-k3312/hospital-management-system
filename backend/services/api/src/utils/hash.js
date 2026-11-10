const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : String(value ?? '')).digest('hex');

/**
 * Keyed hash for values with a small search space, such as IP addresses and network
 * prefixes (Problem 3). A plain SHA-256 of an IPv4 address can be reversed by trying all
 * 2^32 addresses; without IP_HASH_SECRET an HMAC cannot.
 */
let warned = false;
function ipHashKey() {
  const config = require('../config/config'); // required lazily: config does not depend on this file
  if (config.privacy.ipHashSecret) return config.privacy.ipHashSecret;
  // Development fallback only (production refuses to start without IP_HASH_SECRET).
  if (!warned && !config.isTest) {
    warned = true;
    require('./logger').warn('IP_HASH_SECRET is not set: using a key derived from JWT_SECRET (development only)');
  }
  return sha256(`medichain-ip-hash:${config.jwt.secret || ''}`);
}

const hmac = (value) => crypto.createHmac('sha256', ipHashKey()).update(String(value ?? '')).digest('hex');

/** Keyed hash of an IP address, after "::ffff:1.2.3.4" -> "1.2.3.4", so every part of the system
 *  produces the same value for the same client (review issue 12). */
const ipHash = (ip) => {
  const s = String(ip || '');
  return hmac(s.startsWith('::ffff:') && /^\d+\.\d+\.\d+\.\d+$/.test(s.slice(7)) ? s.slice(7) : s);
};

/**
 * Deterministic JSON: object keys are sorted at every level, so the same data
 * always produces the same string (and therefore the same hash) no matter in
 * which order the fields were assigned.
 */
function canonicalJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return JSON.stringify(value.toHexString()); // ObjectId
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hashObject = (value) => sha256(canonicalJSON(value));

module.exports = { sha256, hmac, ipHash, canonicalJSON, hashObject };
