const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : String(value ?? '')).digest('hex');

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

module.exports = { sha256, canonicalJSON, hashObject };
