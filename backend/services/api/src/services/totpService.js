const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Time-based one-time passwords (TOTP, RFC 6238 on top of HOTP, RFC 4226) for the
 * high-risk tier (Problem 2). Works with Google Authenticator, Microsoft Authenticator,
 * FreeOTP and similar apps: HMAC-SHA1, 6 digits, 30-second steps.
 *
 * Implemented with Node's crypto module, so no extra dependency is needed.
 *   - The shared secret is stored encrypted (AES-256-GCM, key TOTP_ENC_KEY).
 *   - One step of clock drift either way is accepted.
 *   - The last accepted step is stored per user, so a code can be used only once
 *     (and never an older one), which stops replay of an observed code.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1;
const SECRET_BYTES = 20; // 160 bits, as recommended by RFC 4226
const ISSUER = 'MediChain';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('INVALID_BASE32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP(K, C) = Truncate(HMAC-SHA1(K, C)) mod 10^d (RFC 4226 section 5.3). */
function hotp(secretBuffer, counter, digits = DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secretBuffer).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

const stepAt = (timeMs = Date.now()) => Math.floor(timeMs / 1000 / STEP_SECONDS);

/** The code an authenticator app shows at the given time (used by tests and the experiments). */
function codeAt(base32Secret, timeMs = Date.now()) {
  return hotp(base32Decode(base32Secret), stepAt(timeMs));
}

/**
 * Checks a code. Returns { ok: true, step } for a code inside the drift window whose step is
 * newer than lastStep, otherwise { ok: false, reason }.
 */
function check(base32Secret, code, { lastStep = -1, timeMs = Date.now() } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return { ok: false, reason: 'format' };
  const secret = base32Decode(base32Secret);
  const now = stepAt(timeMs);
  const given = Buffer.from(String(code));
  for (let delta = -DRIFT_STEPS; delta <= DRIFT_STEPS; delta += 1) {
    const step = now + delta;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, given)) {
      if (step <= lastStep) return { ok: false, reason: 'reused' };
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'wrong' };
}

/* ------------------------------------------------------------- secret storage */

let warnedKey = false;
function encryptionKey() {
  if (config.security.totpEncryptionKey) return Buffer.from(config.security.totpEncryptionKey, 'hex');
  // Development fallback only: production refuses to start without TOTP_ENC_KEY.
  if (!warnedKey && !config.isTest) {
    warnedKey = true;
    logger.warn('TOTP_ENC_KEY is not set: using a key derived from JWT_SECRET (development only)');
  }
  return crypto.createHash('sha256').update(`medichain-totp:${config.jwt.secret || ''}`).digest();
}

/** "iv.tag.ciphertext" in hex. */
function encryptSecret(base32Secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(base32Secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('hex')).join('.');
}

function decryptSecret(stored) {
  const [iv, tag, data] = String(stored).split('.').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function newSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** otpauth:// link that authenticator apps import (also what the QR code contains). */
function otpauthUri(base32Secret, accountName) {
  const label = encodeURIComponent(`${ISSUER}:${accountName}`);
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** QR code as a data URL when the optional "qrcode" package is installed, otherwise null. */
async function qrDataUrl(uri) {
  try {
    // eslint-disable-next-line global-require
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  } catch (error) {
    return null; // the page then shows the key for manual entry
  }
}

/**
 * Verifies a user's code and, if correct, records the step so it cannot be used again.
 * `user` is a Mongoose document with totpSecretEnc / totpLastStep.
 */
async function verifyForUser(user, code, secretField = 'totpSecretEnc') {
  if (!user[secretField]) return { ok: false, reason: 'not_enrolled' };
  const result = check(decryptSecret(user[secretField]), code, { lastStep: user.totpLastStep ?? -1 });
  if (!result.ok) return result;
  // Atomic: only one request can consume a given step (two parallel uses of one code fail).
  const User = user.constructor;
  const updated = await User.updateOne(
    { _id: user._id, $or: [{ totpLastStep: { $lt: result.step } }, { totpLastStep: null }, { totpLastStep: { $exists: false } }] },
    { $set: { totpLastStep: result.step } },
  );
  if (updated.modifiedCount !== 1) return { ok: false, reason: 'reused' };
  user.totpLastStep = result.step;
  return result;
}

module.exports = {
  STEP_SECONDS, DIGITS, DRIFT_STEPS,
  base32Encode, base32Decode, hotp, codeAt, check, stepAt,
  encryptSecret, decryptSecret, newSecret, otpauthUri, qrDataUrl, verifyForUser,
};
