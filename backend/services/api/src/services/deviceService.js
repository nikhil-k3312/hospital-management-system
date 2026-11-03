const crypto = require('crypto');
const User = require('../models/User');
const config = require('../config/config');
const { sha256 } = require('../utils/hash');

/**
 * Remembers browsers that completed the full first-time login (password + emailed code).
 * The browser keeps a random token in an HttpOnly cookie; the database keeps only its
 * SHA-256, so a database leak does not hand out working device tokens.
 */
const DEVICE_COOKIE = 'mcDevice';
const MAX_DEVICES = 5;

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.isProduction,
  sameSite: 'strict',
  path: '/api/auth', // sent only to the auth endpoints
  maxAge: config.devices.trustDays * 24 * 60 * 60 * 1000,
});

function isFresh(device, now = Date.now()) {
  return now - new Date(device.lastSeenAt).getTime() < config.devices.trustDays * 24 * 60 * 60 * 1000;
}

/** Called after a successful first-time (or full) login: issue and store a device token. */
async function trust(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const device = { tokenHash: sha256(token), userAgentHash: sha256(req.get('user-agent') || ''), createdAt: new Date(), lastSeenAt: new Date() };
  await User.updateOne({ _id: user._id }, { $push: { trustedDevices: { $each: [device], $slice: -MAX_DEVICES } } });
  res.cookie(DEVICE_COOKIE, token, cookieOptions());
}

/**
 * Identifies the returning user from the device cookie.
 * Returns { user } for a known, unexpired device used from the same browser, otherwise null.
 */
async function recognise(req) {
  const token = req.cookies?.[DEVICE_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const tokenHash = sha256(token);
  const user = await User.findOne({ 'trustedDevices.tokenHash': tokenHash });
  if (!user || !user.isActive) return null;

  const device = user.trustedDevices.find((d) => d.tokenHash === tokenHash);
  // A cookie copied to a different browser no longer matches the stored user-agent hash.
  if (!isFresh(device) || device.userAgentHash !== sha256(req.get('user-agent') || '')) return null;

  await User.updateOne({ _id: user._id, 'trustedDevices.tokenHash': tokenHash }, { $set: { 'trustedDevices.$.lastSeenAt': new Date() } });
  return { user };
}

/** Forgets every device (used after a password change). */
async function forgetAll(res, userId) {
  await User.updateOne({ _id: userId }, { $set: { trustedDevices: [] } });
  res.clearCookie(DEVICE_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

module.exports = { trust, recognise, forgetAll, DEVICE_COOKIE };
