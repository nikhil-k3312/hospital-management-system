const User = require('../../models/User');
const otpService = require('../../services/otpService');
const emailService = require('../../services/emailService');
const tokenService = require('../../services/tokenService');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');
const deviceService = require('../../services/deviceService');
const routingService = require('../../services/routingService');
const contextService = require('../../services/contextService');
const totpService = require('../../services/totpService');
const roleService = require('../../services/roleService');
const redisClient = require('../../db/redis');
const crypto = require('crypto');
const { sha256, hmac } = require('../../utils/hash');
const { invalidateSession } = require('../../middleware/auth');
const { BREAK_GLASS_ROLES } = require('../../services/trustService');
const config = require('../../config/config');
const logger = require('../../utils/logger');
const { AppError, badRequest, unauthorized, forbidden, tooMany, conflict } = require('../../utils/errors');

const badRequestCode = (message, code) => new AppError(400, message, code);

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

const nowSeconds = () => Math.floor(Date.now() / 1000);
const uaHashOf = (req) => sha256(req.get('user-agent') || '');

/**
 * Issues a token pair, stores the refresh token's hashed id, sets the cookie.
 *   emergency = { until (epoch seconds), reason } makes it a short emergency session
 *   session   = { authTime, amr } of the sign-in; a new sign-in passes none (authTime = now),
 *               a refresh passes the values of the old token so they never reset (Problem 7)
 * The refresh token is bound to the network and browser of this request (Problem 8).
 */
async function issueSession(req, res, user, { emergency = null, authTime, amr } = {}) {
  const options = {
    authTime: authTime || nowSeconds(),
    amr: amr || ['pwd'],
    netHash: contextService.networkHash(req.ip),
    uaHash: uaHashOf(req),
  };
  if (emergency) Object.assign(options, { emergencyUntil: emergency.until, emergencyReason: emergency.reason });
  const access = tokenService.generateAccessToken(user, options);
  const refresh = await tokenService.generateRefreshToken(user, options);
  await User.updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { $each: [refresh.jtiHash], $slice: -5 } } }
  );
  res.cookie(REFRESH_COOKIE, refresh.token, { ...cookieOptions(), maxAge: refresh.ttl * 1000 });
  return access;
}

/** Session values a refresh carries forward unchanged. */
const sessionOf = (decoded) => ({
  authTime: decoded.authTime,
  amr: decoded.amr,
  emergency: decoded.emergencyUntil ? { until: decoded.emergencyUntil, reason: decoded.emergencyReason } : null,
});

/**
 * Problem 8: a refresh token may be used only from the network and browser it was issued to,
 * and only within the maximum session length (Problem 7, D2). Returns the reason it may not
 * be used, or null.
 */
function bindingProblem(req, decoded) {
  if (!decoded.netHash || !decoded.uaHash || !decoded.authTime) return 'unbound_token';
  if (decoded.uaHash !== uaHashOf(req)) return 'browser_changed';
  if (decoded.netHash !== contextService.networkHash(req.ip)) return 'network_changed';
  if (nowSeconds() >= tokenService.sessionEnd(decoded.authTime)) return 'max_session_age';
  return null;
}

/** Revokes a refresh token that may no longer be used and writes the decision to the access ledger. */
async function refuseRefresh(req, res, decoded, reason) {
  await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
  await User.updateOne({ _id: decoded.userId }, { $pull: { refreshTokens: tokenService.hashJTI(decoded.jti) } });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  await ledgerService.append({
    chain: 'access', entityType: 'session_refresh', entityId: decoded.userId, action: 'DENY', actorId: decoded.userId,
    meta: { reason, ipHash: hmac(contextService.normaliseIp(req.ip)), userAgentHash: uaHashOf(req) },
  }).catch((error) => logger.error(`Refresh audit failed: ${error.message}`));
}

/** What the login page needs to know about the authenticator app. */
const totpInfo = (user) => ({ enabled: Boolean(user.totpEnabled), required: config.security.totpRequiredRoles.includes(user.role) });

/**
 * Emergency sign-in is for administrators and doctors whose licence an administrator has
 * verified (Problem 9). With the on-chain registry (Problem 26) the role must also be held there.
 */
async function emergencyEligible(user) {
  const eligible = user.role === 'admin' || (user.role === 'doctor' && user.approvalStatus === 'approved');
  if (!eligible || !BREAK_GLASS_ROLES.includes(user.role)) return false;
  try {
    return await roleService.hasRole(user._id, user.role);
  } catch (error) {
    return false; // registry unreachable and no cached answer: fail closed
  }
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

  // Problem 1: this two-step flow is the bootstrap for the very first login only. Checked after
  // the password, so strangers cannot learn which accounts have signed in before.
  if (user.loginCount > 0) throw forbidden('Please sign in through the normal sign-in page.', 'USE_DYNAMIC_LOGIN');

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
  // Problem 1: bootstrap flow for the first login only (see requestOtp).
  if (user.loginCount > 0) throw forbidden('Please sign in through the normal sign-in page.', 'USE_DYNAMIC_LOGIN');

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

  const access = await issueSession(req, res, user, { amr: ['pwd', 'otp'] });
  // The full password + code login makes this browser a trusted device for next time.
  await deviceService.trust(req, res, user);
  const landing = firstLogin ? routingService.homeFor(user) : await routingService.resolveLanding(user);
  logger.info(`Login: ${email} (${user.role})${firstLogin ? ' [first login]' : ''}`);

  res.json({
    success: true,
    message: 'Login successful',
    // totp tells the page to offer (or, for staff, require) the authenticator set-up next
    data: { user: user.toJSON(), token: access.token, expiresIn: access.expiresIn, landing, firstLogin, totp: totpInfo(user) },
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
      thresholds: assessment.thresholds,
      gate: assessment.gate || undefined,
      profile: assessment.profile,
      emergencyReason: emergencyReason || undefined,
    },
  }).catch((error) => logger.error(`Login audit failed: ${error.message}`));
}

/** Public part of an assessment: what the login page shows the user. */
const publicAssessment = (a) => ({ score: a.score, risk: a.risk, tier: a.tier, factors: a.factors, breakdown: a.breakdown, thresholds: a.thresholds, gate: a.gate });

/**
 * Signs the user in after the dynamic login: session, trusted device, known network, landing page.
 * An emergency sign-in gets a short session and does not make this browser or network trusted,
 * because the third factor that would have proved them was skipped.
 */
async function completeDynamicLogin(req, res, user, assessment, deviceKnown, emergency = null, amr = ['pwd']) {
  user.failedLoginAttempts = 0;
  user.accountLockedUntil = null;
  user.lastLogin = new Date();
  user.loginCount += 1;
  if (!emergency) contextService.rememberNetwork(user, assessment);
  await user.save({ validateBeforeSave: false });
  await invalidateSession(user._id);
  const access = await issueSession(req, res, user, { emergency, amr: deviceKnown ? [...amr, 'device'] : amr });
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
    emergency: emergencyInfo(emergency), totp: totpInfo(user),
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
      const problem = decoded.userId === user._id.toString() ? bindingProblem(req, decoded) : 'other_user';
      if (problem && problem !== 'other_user') await refuseRefresh(req, res, decoded, problem); // Problem 8
      if (!problem) {
        await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
        await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: tokenService.hashJTI(decoded.jti) } });
        // resuming keeps the original sign-in time and, for an emergency session, its end time
        const session = sessionOf(decoded);
        const access = await issueSession(req, res, user, session);
        const emergency = session.emergency;
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

  const needsTotp = assessment.factors.includes('totp');
  const needsQuestion = assessment.factors.includes('security_question'); // baseline B2 only
  const emergencyAllowed = (needsTotp || needsQuestion) && await emergencyEligible(user);
  // Problem 2: without an enrolled authenticator, a high-risk sign-in cannot be completed with
  // password + emailed code. Patients and agents are refused; approved doctors and admins may use
  // the emergency path only. (Enrolment never happens here: an attacker holding the password and
  // the mailbox could otherwise enrol their own authenticator.)
  const emergencyOnly = needsTotp && !user.totpEnabled;
  if (emergencyOnly && !emergencyAllowed) {
    await auditContext(req, user, assessment, 'deny', 'totp_not_enrolled');
    throw forbidden('This sign-in looks unusual and needs your authenticator app, which is not set up yet. Sign in from your usual device or network, or contact the hospital.', 'TOTP_NOT_ENROLLED');
  }

  await sendCode();
  const challengeId = crypto.randomBytes(24).toString('hex');
  await redisClient.setEx(challengeKey(challengeId), CHALLENGE_TTL_SECONDS, JSON.stringify({
    userId: user._id.toString(), factors: assessment.factors, deviceKnown, assessment, emergencyOnly,
  }));
  await auditContext(req, user, assessment, 'challenge', emergencyOnly ? 'high_risk_emergency_only' : `${assessment.risk}_risk_step_up`);

  let message = 'Enter the code sent to your email to finish signing in';
  if (needsTotp) message = emergencyOnly
    ? 'Unusual sign-in and no authenticator app set up: emergency sign-in only'
    : 'Unusual sign-in: enter the emailed code and the code from your authenticator app';
  if (needsQuestion) message = 'Unusual sign-in: enter the emailed code and answer your security question';

  res.json({
    success: true,
    message,
    data: {
      mode: 'challenge', challengeId, email: user.email, expiresInMinutes: config.otp.expiryMinutes,
      totpRequired: needsTotp && !emergencyOnly,
      securityQuestion: needsQuestion ? user.securityQuestion : null,
      // approved doctors and admins may replace the third factor with an emergency reason
      emergencyAllowed,
      emergencyOnly,
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
  const amr = ['pwd', 'otp'];
  const thirdFactor = challenge.factors.includes('totp') || challenge.factors.includes('security_question');

  if (thirdFactor && req.body.emergencyReason) {
    // Re-checked here: approval or the on-chain role may have changed since the challenge.
    if (!(await emergencyEligible(user))) {
      await auditContext(req, user, challenge.assessment, 'deny', 'emergency_not_allowed', req.body.emergencyReason);
      throw forbidden('Emergency sign-in is available to administrators and verified doctors only.', 'EMERGENCY_NOT_ALLOWED');
    }
    emergency = { until: Math.floor(Date.now() / 1000) + config.security.emergencySessionMinutes * 60, reason: req.body.emergencyReason };
    amr.push('emergency');
  } else if (challenge.factors.includes('totp')) {
    if (challenge.emergencyOnly) return fail('No authenticator app is set up: only emergency sign-in is possible', 'EMERGENCY_REASON_REQUIRED');
    const totp = await totpService.verifyForUser(user, req.body.totp);
    if (!totp.ok) {
      return fail(totp.reason === 'reused' ? 'This authenticator code was already used. Wait for the next one.' : 'The authenticator code is not correct',
        totp.reason === 'reused' ? 'TOTP_REUSED' : 'INVALID_TOTP');
    }
    amr.push('totp');
  } else if (challenge.factors.includes('security_question')) { // baseline B2 only
    if (!(await user.compareSecurityAnswer(req.body.securityAnswer))) {
      return fail('The security answer is not correct', 'INVALID_SECURITY_ANSWER');
    }
    amr.push('sq');
  } else if (req.body.emergencyReason) {
    throw badRequestCode('Emergency sign-in is only offered for high-risk sign-ins', 'EMERGENCY_NOT_OFFERED');
  }

  await redisClient.del(challengeKey(req.body.challengeId));
  await otpService.clearAttempts(user.email);
  res.json({
    success: true,
    message: emergency ? 'Emergency sign-in: this session is audited and ends automatically' : 'Login successful',
    data: await completeDynamicLogin(req, res, user, challenge.assessment, challenge.deviceKnown, emergency, amr),
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

  // Problem 8: another network or browser, or a session past its maximum length, must sign in again.
  const problem = bindingProblem(req, decoded);
  if (problem) {
    await refuseRefresh(req, res, decoded, problem);
    const text = {
      network_changed: 'Your network changed. Please sign in again.',
      browser_changed: 'This session belongs to another browser. Please sign in again.',
      max_session_age: `Sessions last at most ${config.security.maxSessionHours} hours. Please sign in again.`,
    }[problem] || 'Please sign in again.';
    return res.status(401).json({ success: false, message: text, code: 'REAUTH_REQUIRED', reason: problem });
  }

  await tokenService.revokeRefreshToken(decoded.userId, decoded.jti);
  await User.updateOne({ _id: user._id }, { $pull: { refreshTokens: tokenService.hashJTI(decoded.jti) } });
  // The sign-in time and an emergency session's end time are carried forward: rotation never extends them.
  const session = sessionOf(decoded);
  const access = await issueSession(req, res, user, session);

  res.json({
    success: true,
    message: 'Session refreshed',
    data: { user: user.toJSON(), token: access.token, expiresIn: access.expiresIn, emergency: emergencyInfo(session.emergency), totp: totpInfo(user) },
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

/* ------------------------------------------------------------------ authenticator app (TOTP) */

/**
 * Enrolment is allowed only inside a trusted session (Problem 2): not an emergency session,
 * and only shortly after a sign-in (TOTP_SETUP_FRESH_MINUTES). Replacing an existing
 * authenticator also needs a current code from it.
 */
function assertEnrolmentAllowed(req) {
  if (req.user.emergency) throw forbidden('An authenticator app cannot be set up during an emergency session.', 'TOTP_SETUP_NOT_ALLOWED');
  const age = nowSeconds() - (req.user.authTime || req.user.iat);
  if (age > config.security.totpSetupFreshMinutes * 60) {
    throw forbidden(`For your safety, sign in again (within ${config.security.totpSetupFreshMinutes} minutes) to set up the authenticator app.`, 'TOTP_SETUP_NOT_FRESH');
  }
}

/** GET /api/auth/totp/status */
async function totpStatus(req, res) {
  const user = await User.findById(req.user.userId);
  res.json({ success: true, data: totpInfo(user) });
}

/** POST /api/auth/totp/setup { currentCode? }: creates a new secret (not active until confirmed). */
async function totpSetup(req, res) {
  assertEnrolmentAllowed(req);
  const user = await User.findById(req.user.userId);
  if (user.totpEnabled) {
    const check = await totpService.verifyForUser(user, req.body.currentCode);
    if (!check.ok) throw forbidden('Enter a current code from your existing authenticator app to replace it.', 'TOTP_CODE_REQUIRED');
  }
  const secret = totpService.newSecret();
  user.totpPendingEnc = totpService.encryptSecret(secret);
  await user.save({ validateBeforeSave: false });
  const uri = totpService.otpauthUri(secret, user.email);
  res.json({ success: true, message: 'Add this key to your authenticator app, then enter the 6-digit code it shows', data: { secret, otpauthUri: uri, qr: await totpService.qrDataUrl(uri) } });
}

/** POST /api/auth/totp/confirm { code }: the first code proves the app holds the secret. */
async function totpConfirm(req, res) {
  assertEnrolmentAllowed(req);
  const user = await User.findById(req.user.userId);
  if (!user.totpPendingEnc) throw badRequestCode('Start the set-up first.', 'TOTP_NO_PENDING_SETUP');
  const result = totpService.check(totpService.decryptSecret(user.totpPendingEnc), req.body.code);
  if (!result.ok) throw badRequestCode('That code is not correct. Check the time on your phone and try the next code.', 'INVALID_TOTP');
  const replaced = user.totpEnabled;
  user.totpSecretEnc = user.totpPendingEnc;
  user.totpPendingEnc = '';
  user.totpEnabled = true;
  user.totpLastStep = result.step;
  user.totpEnabledAt = new Date();
  await user.save({ validateBeforeSave: false });
  await invalidateSession(user._id);
  await ledgerService.append({
    chain: 'records', entityType: 'user', entityId: user._id, action: replaced ? 'TOTP_REPLACED' : 'TOTP_ENROLLED',
    actorId: user._id, actorRole: user.role, payload: { totpEnabled: true, at: user.totpEnabledAt },
  });
  res.json({ success: true, message: 'Authenticator app set up', data: totpInfo(user) });
}

module.exports = {
  register, requestOtp, verifyOtp, route, dynamicLogin, verifyChallenge, refreshToken, logout, changePassword,
  totpStatus, totpSetup, totpConfirm, REFRESH_COOKIE,
};
