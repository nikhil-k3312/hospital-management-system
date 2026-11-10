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

/**
 * Browser family + operating system of a user-agent string, e.g. "Chrome|Windows" (Problem 4,
 * review issue 7). Binding a device to the exact user-agent forgot it at every browser update
 * (about monthly). An unrecognised user-agent is kept whole. The cookie itself (random, HttpOnly)
 * remains the real possession factor; the family check only stops a cookie copied into a
 * clearly different browser.
 */
function uaFamily(ua = '') {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) && /Version\//.test(s) ? 'Safari' : null;
  const os = /Windows NT/.test(s) ? 'Windows' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : null;
  return browser && os ? `${browser}|${os}` : s;
}

function isFresh(device, now = Date.now()) {
  return now - new Date(device.lastSeenAt).getTime() < config.devices.trustDays * 24 * 60 * 60 * 1000;
}

/**
 * Called after a successful full login: issue and store a device token.
 * `via` records how the browser was proven (Problem 2): 'bootstrap' = the very first login,
 * 'totp' = a login with the authenticator app, 'otp' = password + emailed code only. Only
 * 'bootstrap' and 'totp' browsers may set up an authenticator app, because a password + mailbox
 * attacker can make his own browser an 'otp' one.
 */
async function trust(req, res, user, via = 'otp') {
  const token = crypto.randomBytes(32).toString('hex');
  const device = { tokenHash: sha256(token), userAgentHash: sha256(uaFamily(req.get('user-agent'))), via, createdAt: new Date(), lastSeenAt: new Date() };
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
  // A cookie copied into a different browser (family or OS) no longer matches. Devices stored
  // before this change kept the exact user-agent hash, which is still accepted.
  const ua = req.get('user-agent') || '';
  if (!isFresh(device) || ![sha256(uaFamily(ua)), sha256(ua)].includes(device.userAgentHash)) return null;

  await User.updateOne({ _id: user._id, 'trustedDevices.tokenHash': tokenHash }, { $set: { 'trustedDevices.$.lastSeenAt': new Date() } });
  return { user, device: { via: device.via || 'otp' } }; // devices from before Problem 2 count as 'otp'
}

/** Forgets every device (used after a password change). */
async function forgetAll(res, userId) {
  await User.updateOne({ _id: userId }, { $set: { trustedDevices: [] } });
  res.clearCookie(DEVICE_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

module.exports = { trust, recognise, forgetAll, uaFamily, DEVICE_COOKIE };
