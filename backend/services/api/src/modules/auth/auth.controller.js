const User = require('../../models/User');
const otpService = require('../../services/otpService');
const emailService = require('../../services/emailService');
const tokenService = require('../../services/tokenService');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');
const { invalidateSession } = require('../../middleware/auth');
const config = require('../../config/config');
const logger = require('../../utils/logger');
const { badRequest, unauthorized, forbidden, tooMany, conflict } = require('../../utils/errors');

const REFRESH_COOKIE = 'refreshToken';

// Plain functions instead of class methods: Express calls handlers without an
// object, so there is no `this` to lose (the old logout/lockout bug).

const cookieOptions = () => ({
  httpOnly: true, // JavaScript in the page cannot read it (XSS)
  secure: config.isProduction, // HTTPS-only in production; plain http://localhost works in dev
  sameSite: 'strict', // never sent on cross-site requests (CSRF)
  path: '/api/auth', // only sent to the auth endpoints that need it
  maxAge: config.jwt.refreshExpiryDays * 24 * 60 * 60 * 1000,
});

/**
 * Same response for "no such user" and "wrong password", so the login form
 * cannot be used to discover which emails are registered.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

async function recordFailedAttempt(user) {
  const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginAttempts: 1 } }, { new: true });
  if (updated.failedLoginAttempts >= config.security.maxFailedLogins) {
    updated.accountLockedUntil = new Date(Date.now() + config.security.lockMinutes * 60 * 1000);
    await updated.save({ validateBeforeSave: false });
    logger.warn(`Account locked after ${updated.failedLoginAttempts} failed attempts: ${user.email}`);
  }
  await invalidateSession(user._id); // trust score reflects the failure immediately
  return updated.failedLoginAttempts;
}

/** Issues a token pair, stores the refresh token's hashed id, sets the cookie. */
async function issueSession(res, user) {
  const access = tokenService.generateAccessToken(user);
  const refresh = await tokenService.generateRefreshToken(user);
  await User.updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { $each: [refresh.jtiHash], $slice: -5 } } }
  );
  res.cookie(REFRESH_COOKIE, refresh.token, cookieOptions());
  return access;
}

/** POST /api/auth/register: patients, doctors and insurance agents self-register. */
async function register(req, res) {
  const { email, password, fullName, role, phone, dateOfBirth, gender, address } = req.body;

  if (await User.exists({ email })) {
    throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  }

  const needsApproval = User.ROLES_NEEDING_APPROVAL.includes(role);
  const user = new User({
    email,
    fullName,
    passwordHash: password, // hashed by the pre-save hook
    role,
    phone,
    dateOfBirth: dateOfBirth || null,
    gender: gender || '',
    address,
    approvalStatus: needsApproval ? 'pending' : 'approved',
  });

  if (role === 'patient') {
    user.patientProfile = {
      bloodType: req.body.bloodType || '',
      emergencyContact: req.body.emergencyContact || '',
      insuranceProvider: req.body.insuranceProvider || '',
      policyNumber: req.body.policyNumber || '',
    };
  } else if (role === 'doctor') {
    user.doctorProfile.specialization = req.body.specialization;
    user.doctorProfile.licenseNumber = req.body.licenseNumber;
    user.doctorProfile.department = req.body.department || req.body.specialization;
  } else if (role === 'insurance_agent') {
    user.agentProfile = { company: req.body.company, employeeId: req.body.employeeId || '' };
  }

  await user.save();
  await ledgerService.append({
    chain: 'records', entityType: 'user', entityId: user._id, action: 'REGISTER',
    actorId: user._id, actorRole: role, payload: { email: user.email, role, ledgerAddress: user.ledgerAddress },
  });

  if (needsApproval) {
    await notificationService.notifyRole('admin', {
      type: 'warning',
      title: 'New account awaiting verification',
      message: `${fullName} registered as ${role === 'doctor' ? 'a doctor' : 'an insurance agent'} and needs verification.`,
      page: 'verification',
    });
  }

  emailService.sendWelcome(email, fullName, role, needsApproval); // fire-and-forget by design
  logger.info(`Registered ${email} as ${role}`);

  res.status(201).json({
    success: true,
    message: needsApproval
      ? 'Account created. An administrator must verify your credentials before clinical features unlock.'
      : 'Account created. You can now log in.',
    data: { user: user.toJSON() },
  });
}

/** POST /api/auth/login/request-otp: step 1, check the password and email a code. */
async function requestOtp(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email });

  if (!user) throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  if (user.isAccountLocked()) {
    throw forbidden('Account is locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
  }
  if (!user.isActive) throw forbidden('Account is deactivated. Contact the hospital administrator.', 'ACCOUNT_DEACTIVATED');

  if (!(await user.comparePassword(password))) {
    const failed = await recordFailedAttempt(user);
    return res.status(401).json({
      success: false,
      message: INVALID_CREDENTIALS,
      code: 'INVALID_CREDENTIALS',
      attemptsRemaining: Math.max(0, config.security.maxFailedLogins - failed),
    });
  }

  if (await otpService.getAttempts(email) >= config.otp.maxAttempts) {
    throw tooMany('Too many OTP requests. Try again in 15 minutes.');
  }

  const otp = otpService.generateOTP();
  await otpService.storeOTP(email, otp);
  await emailService.sendOTP(email, otp, user.fullName);
  await otpService.incrementAttempts(email);

  res.json({
    success: true,
    message: 'A login code was sent to your email',
    data: { email, expiresInMinutes: config.otp.expiryMinutes },
  });
}

/** POST /api/auth/login/verify-otp: step 2, exchange a correct code for tokens. */
async function verifyOtp(req, res) {
  const { email, otp } = req.body;
  const user = await User.findOne({ email });
  if (!user) throw unauthorized('Invalid or expired code', 'INVALID_OTP');
  if (user.isAccountLocked()) throw forbidden('Account is locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
  if (!user.isActive) throw forbidden('Account is deactivated. Contact the hospital administrator.', 'ACCOUNT_DEACTIVATED');

  const attempts = await otpService.getAttempts(email);
  if (attempts >= config.otp.maxAttempts) throw tooMany('Too many OTP attempts. Try again in 15 minutes.');

  const result = await otpService.verifyOTP(email, otp);
  if (!result.success) {
    const otpAttempts = await otpService.incrementAttempts(email);
    const failed = await recordFailedAttempt(user);
    return res.status(401).json({
      success: false,
      message: result.message,
      code: 'INVALID_OTP',
      attemptsRemaining: Math.max(0, Math.min(config.security.maxFailedLogins - failed, config.otp.maxAttempts - otpAttempts)),
    });
  }

  await otpService.clearAttempts(email);
  user.failedLoginAttempts = 0;
  user.accountLockedUntil = null;
  user.lastLogin = new Date();
  user.isVerified = true;
  await user.save({ validateBeforeSave: false });
  await invalidateSession(user._id);

  const access = await issueSession(res, user);
  logger.info(`Login: ${email} (${user.role})`);

  res.json({
    success: true,
    message: 'Login successful',
    data: { user: user.toJSON(), token: access.token, expiresIn: access.expiresIn },
  });
}

/**
 * POST /api/auth/refresh-token: refresh-token ROTATION. Each refresh token
 * works exactly once: it is revoked and replaced by a new one. A stolen token
 * therefore stops working as soon as either party uses it.
 */
async function refreshToken(req, res) {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (!presented) throw unauthorized('No session. Please log in.', 'NO_REFRESH_TOKEN');

  let decoded;
  try {
    decoded = await tokenService.verifyRefreshToken(presented);
  } catch (error) {
    if (error.message === 'REDIS_UNAVAILABLE') throw error;
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw unauthorized('Session expired. Please log in again.', 'INVALID_REFRESH_TOKEN');
  }

  const user = await User.findById(decoded.userId);
  if (!user || !user.isActive) {
    await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
    throw unauthorized('Account deactivated', 'ACCOUNT_DEACTIVATED');
  }

  await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
  await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: tokenService.hashJTI(decoded.jti) } });
  const access = await issueSession(res, user);

  res.json({
    success: true,
    message: 'Session refreshed',
    data: { user: user.toJSON(), token: access.token, expiresIn: access.expiresIn },
  });
}

/** POST /api/auth/logout: kill both tokens now, not when they expire. */
async function logout(req, res) {
  await tokenService.blacklistAccessToken(req.user);

  const presented = req.cookies?.[REFRESH_COOKIE];
  if (presented) {
    try {
      const decoded = await tokenService.verifyRefreshToken(presented);
      await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
      await User.updateOne({ _id: decoded.userId }, { $pull: { refreshTokens: tokenService.hashJTI(decoded.jti) } });
    } catch (error) {
      if (error.message === 'REDIS_UNAVAILABLE') throw error;
      logger.warn(`Refresh token not revoked during logout: ${error.message}`);
    }
  }

  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ success: true, message: 'Logged out successfully' });
}

/** POST /api/auth/change-password: also signs out every other session. */
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user.userId);

  if (!(await user.comparePassword(currentPassword))) {
    const failed = await recordFailedAttempt(user);
    return res.status(401).json({
      success: false,
      message: 'Current password is incorrect',
      attemptsRemaining: Math.max(0, config.security.maxFailedLogins - failed),
    });
  }
  if (currentPassword === newPassword) throw badRequest('The new password must be different');

  user.passwordHash = newPassword;
  user.failedLoginAttempts = 0;
  user.accountLockedUntil = null;
  user.refreshTokens = [];
  await user.save();
  await tokenService.revokeAllRefreshTokens(user._id.toString());
  await tokenService.blacklistAccessToken(req.user);
  await invalidateSession(user._id);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });

  res.json({ success: true, message: 'Password changed. Please log in again on all devices.' });
}

module.exports = { register, requestOtp, verifyOtp, refreshToken, logout, changePassword, REFRESH_COOKIE };
