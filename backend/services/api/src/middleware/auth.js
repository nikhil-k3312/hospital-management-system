const tokenService = require('../services/tokenService');
const trustService = require('../services/trustService');
const auditService = require('../services/auditService');
const redisClient = require('../db/redis');
const User = require('../models/User');
const logger = require('../utils/logger');

const SESSION_CACHE_SECONDS = 5 * 60;
const sessionKey = (userId) => `session:active:${userId}`;

const deny = async (req, res, status, reason, message, extra = {}) => {
  await auditService.recordAccessDecision({ req, decision: 'deny', reason, ...extra });
  return res.status(status).json({ success: false, message, code: reason.toUpperCase(), ...extra.body });
};

/**
 * Loads the account state used for continuous verification. It is cached in
 * Redis for 5 minutes, so a deactivated or rejected user is cut off within 5
 * minutes even though their JWT is still valid, without querying MongoDB on
 * every request.
 */
async function loadSessionState(userId) {
  const cached = await redisClient.get(sessionKey(userId));
  if (cached) return JSON.parse(cached);

  const user = await User.findById(userId).select('isActive isVerified failedLoginAttempts approvalStatus').lean();
  if (!user) return null;
  const state = {
    isActive: user.isActive,
    isVerified: user.isVerified,
    failedLoginAttempts: user.failedLoginAttempts || 0,
    approvalStatus: user.approvalStatus,
  };
  await redisClient.setEx(sessionKey(userId), SESSION_CACHE_SECONDS, JSON.stringify(state));
  return state;
}

/** Drops the cached state so the next request reloads it from MongoDB. */
async function invalidateSession(userId) {
  try {
    await redisClient.del(sessionKey(String(userId)));
  } catch (error) {
    logger.error(`Session cache invalidation failed: ${error.message}`);
  }
}

/**
 * authenticate: runs before every protected route.
 *   1. read the Bearer token          4. compute the trust score
 *   2. verify signature/expiry/revoked 5. deny below MIN_TRUST_SCORE
 *   3. load (cached) account state     6. audit the decision
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !header.slice(7).trim()) {
    return deny(req, res, 401, 'missing_token', 'Access denied. No token provided. Please log in.');
  }

  let decoded;
  try {
    decoded = await tokenService.verifyAccessToken(header.slice(7).trim());
  } catch (error) {
    if (error.name === 'TokenExpiredError') return deny(req, res, 401, 'token_expired', 'Token expired. Please log in again.');
    if (error.message === 'TOKEN_REVOKED') return deny(req, res, 401, 'token_revoked', 'Token has been revoked. Please log in again.');
    if (error.message === 'REDIS_UNAVAILABLE') return deny(req, res, 503, 'redis_unavailable', 'Security service temporarily unavailable. Please try again.');
    return deny(req, res, 401, 'invalid_token', 'Invalid token. Please log in again.');
  }

  let sessionState;
  try {
    sessionState = await loadSessionState(decoded.userId);
  } catch (error) {
    logger.error(`Session state unavailable: ${error.message}`);
    return deny(req, res, 503, 'session_cache_unavailable', 'Security service temporarily unavailable. Please try again.', { userId: decoded.userId });
  }

  if (!sessionState || !sessionState.isActive) {
    return deny(req, res, 401, 'account_deactivated', 'Account deactivated. Contact the hospital administrator.', { userId: decoded.userId });
  }

  req.user = decoded; // { userId, email, role, jti, iat, exp }
  req.sessionState = sessionState;
  req.trustScore = trustService.calculateTrustScore(req, decoded, sessionState);

  if (req.trustScore.score < req.trustScore.minScore) {
    return deny(req, res, 403, 'low_trust_score', 'Access denied. Additional verification required: please log in again.', {
      userId: decoded.userId, trustScore: req.trustScore.score, body: { trustScore: req.trustScore.score },
    });
  }

  await auditService.recordAccessDecision({ req, userId: decoded.userId, decision: 'allow', reason: 'authenticated', trustScore: req.trustScore.score });
  return next();
}

/**
 * requireRole('doctor', 'admin', { minTrustScore: 70, allowBreakGlass: true })
 * RBAC + ABAC gate, used after authenticate. The policy result is stored on
 * req.policy so handlers know whether break-glass was used.
 */
function requireRole(...args) {
  const options = typeof args[args.length - 1] === 'object' ? args.pop() : {};
  const allowedRoles = args;

  return async (req, res, next) => {
    if (!req.user) {
      return deny(req, res, 401, 'not_authenticated', 'Not authenticated. Please log in first.');
    }
    const result = trustService.evaluatePolicy(req, allowedRoles, options);
    if (!result.allowed) {
      logger.warn(`Access denied for ${req.user.email}: ${result.reason}`);
      return deny(req, res, result.status, result.reason, result.message, {
        userId: req.user.userId,
        body: { requiredRole: allowedRoles, currentRole: req.user.role, trustScore: req.trustScore?.score },
      });
    }
    req.policy = result;
    if (result.breakGlass) {
      await auditService.recordAccessDecision({
        req, userId: req.user.userId, decision: 'allow', reason: result.reason, breakGlassReason: result.breakGlassReason,
      });
    }
    return next();
  };
}

module.exports = { authenticate, requireRole, invalidateSession, loadSessionState };
