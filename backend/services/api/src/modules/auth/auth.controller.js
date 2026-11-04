const User = require('../../models/User');
const otpService = require('../../services/otpService');
const emailService = require('../../services/emailService');
const tokenService = require('../../services/tokenService');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');
const deviceService = require('../../services/deviceService');
const routingService = require('../../services/routingService');
const contextService = require('../../services/contextService');
const redisClient = require('../../db/redis');
const crypto = require('crypto');
const { sha256 } = require('../../utils/hash');
const { invalidateSession } = require('../../middleware/auth');
const { BREAK_GLASS_ROLES } = require('../../services/trustService');
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

/**
 * Issues a token pair, stores the refresh token's hashed id, sets the cookie.
 * emergency = { until (epoch seconds), reason } makes it a short emergency session.
 */
async function issueSession(res, user, emergency = null) {
  const options = emergency ? { emergencyUntil: emergency.until, emergencyReason: emergency.reason } : {};
  const access = tokenService.generateAccessToken(user, options);
  const refresh = await tokenService.generateRefreshToken(user, options);
  await User.updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { $each: [refresh.jtiHash], $slice: -5 } } }
  );
  res.cookie(REFRESH_COOKIE, refresh.token, emergency ? { ...cookieOptions(), maxAge: refresh.ttl * 1000 } : cookieOptions());
  return access;
}

/** What the pages need to know about an emergency session (null for a normal one). */
const emergencyInfo = (emergency) => (emergency ? { until: new Date(emergency.until * 1000).toISOString(), reason: emergency.reason } : null);

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
    securityQuestion: req.body.securityQuestion || '',
    securityAnswerHash: req.body.securityAnswer || '', // hashed by the pre-save hook
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
  const firstLogin = user.loginCount === 0;
  user.failedLoginAttempts = 0;
  user.accountLockedUntil = null;
  user.lastLogin = new Date();
  user.isVerified = true;
  user.loginCount += 1;
  contextService.rememberNetwork(user, contextService.assess({ req, user, deviceKnown: false }));
  await user.save({ validateBeforeSave: false });
  await invalidateSession(user._id);

  const access = await issueSession(res, user);
  // The full password + code login makes this browser a trusted device for next time.
  await deviceService.trust(req, res, user);
  const landing = firstLogin ? routingService.homeFor(user) : await routingService.resolveLanding(user);
  logger.info(`Login: ${email} (${user.role})${firstLogin ? ' [first login]' : ''}`);

  res.json({
    success: true,
    message: 'Login successful',
    data: { user: user.toJSON(), token: access.token, expiresIn: access.expiresIn, landing, firstLogin },
  });
}

/** Masks an email for display on a shared screen: s****@example.com */
function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name.charAt(0)}${'*'.repeat(Math.max(1, name.length - 1))}@${domain}`;
}

const CHALLENGE_TTL_SECONDS = 10 * 60;
const challengeKey = (id) => `login:challenge:${id}`;

/** Writes the dynamic-login decision to the "access" chain of the ledger (no raw IP or coordinates). */
function auditContext(req, user, assessment, decision, reason, emergencyReason) {
  return ledgerService.append({
    chain: 'access',
    entityType: 'login_context',
    entityId: user._id,
    action: decision === 'allow' ? 'ALLOW' : decision === 'deny' ? 'DENY' : 'CHALLENGE',
    actorId: user._id,
    actorRole: user.role,
    meta: {
      reason,
      trustScore: assessment.score,
      risk: assessment.risk,
      factors: assessment.factors,
      location: assessment.breakdown.location.category,
      distanceKm: assessment.breakdown.location.distanceKm,
      device: assessment.breakdown.device.category,
      time: assessment.breakdown.time.category,
      network: assessment.breakdown.network.category,
      behaviour: assessment.breakdown.behaviour?.category,
      ipHash: assessment.ipHash,
      userAgentHash: sha256(req.get('user-agent') || ''),
      emergencyReason: emergencyReason || undefined,
    },
  }).catch((error) => logger.error(`Login audit failed: ${error.message}`));
}

/** Public part of an assessment: what the login page shows the user. */
const publicAssessment = (a) => ({ score: a.score, risk: a.risk, tier: a.tier, factors: a.factors, breakdown: a.breakdown });

/**
 * Signs the user in after the dynamic login: session, trusted device, known network, landing page.
 * An emergency sign-in gets a short session and does not make this browser or network trusted,
 * because the security question that would have proved them was skipped.
 */
async function completeDynamicLogin(req, res, user, assessment, deviceKnown, emergency = null) {
  user.failedLoginAttempts = 0;
  user.accountLockedUntil = null;
  user.lastLogin = new Date();
  user.loginCount += 1;
  if (!emergency) contextService.rememberNetwork(user, assessment);
  await user.save({ validateBeforeSave: false });
  await invalidateSession(user._id);
  const access = await issueSession(res, user, emergency);
  if (!deviceKnown && !emergency) await deviceService.trust(req, res, user); // the extra factors just proved this browser
  const landing = await routingService.resolveLanding(user);
  if (emergency) {
    await auditContext(req, user, assessment, 'allow', 'emergency_login', emergency.reason);
    await notificationService.notifyRole('admin', {
      type: 'warning',
      title: 'Emergency sign-in used',
      message: `${user.fullName} (${user.role}) signed in with emergency access at trust score ${assessment.score}. Reason: "${emergency.reason}". Review it in Access Control.`,
      page: 'access',
    });
    logger.warn(`Emergency login: ${user.email} score ${assessment.score}`);
  } else {
    await auditContext(req, user, assessment, 'allow', 'dynamic_login_success');
    logger.info(`Dynamic login: ${user.email} score ${assessment.score} (${assessment.risk} risk)`);
  }
  return {
    mode: 'redirect', landing, token: access.token, user: user.toJSON(), assessment: publicAssessment(assessment),
    emergency: emergencyInfo(emergency),
  };
}

/**
 * POST /api/auth/route: called by the login page as soon as it loads.
 *   unknown browser                          -> { mode: 'login' }      normal sign-in / sign-up page
 *   trusted browser, live session, low risk  -> { mode: 'redirect' }   straight to the computed landing page
 *   trusted browser otherwise                -> { mode: 'returning' }  "welcome back" + the factors this context needs
 */
async function route(req, res) {
  const known = await deviceService.recognise(req);
  if (!known) return res.json({ success: true, data: { mode: 'login' } });
  const { user } = known;
  const assessment = contextService.assess({ req, user, deviceKnown: true, gps: req.body.context?.gps });

  const presented = req.cookies?.[REFRESH_COOKIE];
  if (presented && assessment.risk === 'low') {
    try {
      const decoded = await tokenService.verifyRefreshToken(presented);
      if (decoded.userId === user._id.toString()) {
        await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
        await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: tokenService.hashJTI(decoded.jti) } });
        // resuming an emergency session keeps its original end time
        const emergency = decoded.emergencyUntil ? { until: decoded.emergencyUntil, reason: decoded.emergencyReason } : null;
        const access = await issueSession(res, user, emergency);
        const landing = await routingService.resolveLanding(user);
        await auditContext(req, user, assessment, 'allow', 'session_resumed_low_risk');
        return res.json({ success: true, data: { mode: 'redirect', landing, token: access.token, user: user.toJSON(), assessment: publicAssessment(assessment), emergency: emergencyInfo(emergency) } });
      }
    } catch (error) {
      if (error.message === 'REDIS_UNAVAILABLE') throw error;
      // expired or revoked session: fall through to the returning-user form
    }
  }

  res.json({
    success: true,
    data: {
      mode: 'returning', firstName: user.fullName.split(' ')[0], emailHint: maskEmail(user.email), role: user.role,
      assessment: publicAssessment(assessment),
    },
  });
}

/**
 * POST /api/auth/login/dynamic: every login after the first one.
 *   1. identify the account (trusted-browser cookie, or the email typed in) and check the password
 *   2. first login after registration -> the normal flow: emailed code via /login/verify-otp
 *   3. otherwise score the context: low risk signs in now; medium and high risk get a
 *      challenge (emailed code, plus the security question at high risk)
 */
async function dynamicLogin(req, res) {
  const known = await deviceService.recognise(req);
  let user = req.body.email ? await User.findOne({ email: req.body.email }) : known?.user;
  if (!user) throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  if (user.isAccountLocked()) throw forbidden('Account is locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
  if (!user.isActive) throw forbidden('Account is deactivated. Contact the hospital administrator.', 'ACCOUNT_DEACTIVATED');

  if (!(await user.comparePassword(req.body.password))) {
    const failed = await recordFailedAttempt(user);
    return res.status(401).json({
      success: false, message: INVALID_CREDENTIALS, code: 'INVALID_CREDENTIALS',
      attemptsRemaining: Math.max(0, config.security.maxFailedLogins - failed),
    });
  }
  if (await otpService.getAttempts(user.email) >= config.otp.maxAttempts) throw tooMany('Too many OTP requests. Try again in 15 minutes.');

  const sendCode = async () => {
    const otp = otpService.generateOTP();
    await otpService.storeOTP(user.email, otp);
    await emailService.sendOTP(user.email, otp, user.fullName);
    await otpService.incrementAttempts(user.email);
  };

  // First login after registration: the normal sign-in, password then emailed code.
  if (user.loginCount === 0) {
    await sendCode();
    return res.json({ success: true, message: 'A login code was sent to your email', data: { mode: 'otp', email: user.email, expiresInMinutes: config.otp.expiryMinutes } });
  }

  const deviceKnown = Boolean(known && known.user._id.equals(user._id));
  user = await User.findById(user._id); // fresh copy (recordFailedAttempt may have run earlier)
  const assessment = contextService.assess({ req, user, deviceKnown, gps: req.body.context?.gps });

  if (assessment.risk === 'low') {
    return res.json({ success: true, message: 'Welcome back', data: await completeDynamicLogin(req, res, user, assessment, deviceKnown) });
  }

  await sendCode();
  const challengeId = crypto.randomBytes(24).toString('hex');
  await redisClient.setEx(challengeKey(challengeId), CHALLENGE_TTL_SECONDS, JSON.stringify({
    userId: user._id.toString(), factors: assessment.factors, deviceKnown, assessment,
  }));
  await auditContext(req, user, assessment, 'challenge', `${assessment.risk}_risk_step_up`);

  res.json({
    success: true,
    message: assessment.factors.includes('security_question')
      ? 'Unusual sign-in: enter the emailed code and answer your security question'
      : 'Enter the code sent to your email to finish signing in',
    data: {
      mode: 'challenge', challengeId, email: user.email, expiresInMinutes: config.otp.expiryMinutes,
      securityQuestion: assessment.factors.includes('security_question') ? user.securityQuestion : null,
      // doctors and admins may replace the security question with an emergency reason
      emergencyAllowed: assessment.factors.includes('security_question') && BREAK_GLASS_ROLES.includes(user.role),
      assessment: publicAssessment(assessment),
    },
  });
}

/**
 * POST /api/auth/login/challenge: the extra factors the context assessment asked for.
 * Emergency sign-in (break-glass at login): a doctor or admin facing the security
 * question may give a clinical reason instead. The emailed code is still required,
 * the session lasts EMERGENCY_SESSION_MINUTES, and the use is audited and reported.
 */
async function verifyChallenge(req, res) {
  const raw = await redisClient.get(challengeKey(req.body.challengeId));
  if (!raw) throw unauthorized('This sign-in attempt has expired. Start again.', 'CHALLENGE_EXPIRED');
  const challenge = JSON.parse(raw);
  const user = await User.findById(challenge.userId);
  if (!user || !user.isActive) throw unauthorized('Account unavailable', 'ACCOUNT_DEACTIVATED');
  if (user.isAccountLocked()) throw forbidden('Account is locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');

  const fail = async (message, code) => {
    const failed = await recordFailedAttempt(user);
    await auditContext(req, user, challenge.assessment, 'deny', code.toLowerCase());
    return res.status(401).json({ success: false, message, code, attemptsRemaining: Math.max(0, config.security.maxFailedLogins - failed) });
  };

  const otpResult = await otpService.verifyOTP(user.email, req.body.otp);
  if (!otpResult.success) {
    await otpService.incrementAttempts(user.email);
    return fail(otpResult.message, 'INVALID_OTP');
  }
  let emergency = null;
  if (challenge.factors.includes('security_question')) {
    if (req.body.emergencyReason) {
      if (!BREAK_GLASS_ROLES.includes(user.role)) {
        await auditContext(req, user, challenge.assessment, 'deny', 'emergency_not_allowed', req.body.emergencyReason);
        throw forbidden('Emergency sign-in is available to doctors and administrators only.', 'EMERGENCY_NOT_ALLOWED');
      }
      emergency = { until: Math.floor(Date.now() / 1000) + config.security.emergencySessionMinutes * 60, reason: req.body.emergencyReason };
    } else if (!(await user.compareSecurityAnswer(req.body.securityAnswer))) {
      return fail('The security answer is not correct', 'INVALID_SECURITY_ANSWER');
    }
  }

  await redisClient.del(challengeKey(req.body.challengeId));
  await otpService.clearAttempts(user.email);
  res.json({
    success: true,
    message: emergency ? 'Emergency sign-in: this session is audited and ends automatically' : 'Login successful',
    data: await completeDynamicLogin(req, res, user, challenge.assessment, challenge.deviceKnown, emergency),
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
  // An emergency session keeps its original end time: rotation never extends it.
  const emergency = decoded.emergencyUntil ? { until: decoded.emergencyUntil, reason: decoded.emergencyReason } : null;
  const access = await issueSession(res, user, emergency);

  res.json({
    success: true,
    message: 'Session refreshed',
    data: { user: user.toJSON(), token: access.token, expiresIn: access.expiresIn, emergency: emergencyInfo(emergency) },
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
  await deviceService.forgetAll(res, user._id); // every browser goes back to the full login
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });

  res.json({ success: true, message: 'Password changed. Please log in again on all devices.' });
}

module.exports = { register, requestOtp, verifyOtp, route, dynamicLogin, verifyChallenge, refreshToken, logout, changePassword, REFRESH_COOKIE };
