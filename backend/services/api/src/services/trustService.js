const crypto = require('crypto');
const config = require('../config/config');
const { ROLES_NEEDING_APPROVAL } = require('../models/User');
const { ipHash } = require('../utils/hash');

const BREAK_GLASS_ROLES = ['doctor', 'admin'];

/** Hour of day in the hospital time zone (same helper as the login score; required lazily to avoid a cycle). */
const localHour = (now = new Date()) => require('./contextService').localHour(now);

class TrustService {
  hashValue(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
  }

  /**
   * Scores a request 0-100. Starts at 100 and subtracts a penalty for each
   * signal that makes it more likely the token holder is not its owner.
   */
  calculateTrustScore(req, tokenPayload, sessionState = {}) {
    let score = 100;
    const reasons = [];
    const failedAttempts = Number(sessionState.failedLoginAttempts || 0);
    // Problem 7: the age of the session is measured from the sign-in itself (authTime), which
    // every refreshed token carries forward. The token's own iat resets every 15 minutes.
    const startedAt = tokenPayload?.authTime ?? tokenPayload?.iat;
    const sessionAgeSeconds = startedAt
      ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
      : null;
    const userAgent = req.get('user-agent') || '';

    if (!sessionState.isVerified) {
      score -= 15;
      reasons.push('user_not_verified');
    }
    if (failedAttempts > 0) {
      score -= Math.min(30, failedAttempts * 6);
      reasons.push('recent_failed_attempts');
    }
    if (!userAgent) {
      score -= 10;
      reasons.push('missing_user_agent');
    }
    if (sessionAgeSeconds !== null && sessionAgeSeconds > 60 * 60) {
      score -= 10;
      reasons.push('older_session');
    }
    if (sessionAgeSeconds !== null && sessionAgeSeconds > 6 * 60 * 60) {
      score -= 15;
      reasons.push('long_lived_session');
    }

    return {
      score: Math.max(0, Math.min(100, score)),
      reasons,
      minScore: config.security.minTrustScore,
      highSensitivityMinScore: config.security.highSensitivityTrustScore,
      sessionAgeSeconds,
      deviceFingerprint: this.hashValue(userAgent),
      ipHash: ipHash(req.ip),
    };
  }

  /**
   * RBAC first, then ABAC conditions. The first failing check wins.
   * A valid break-glass request (doctor/admin + reason header + route that allows it)
   * bypasses the role and trust conditions, but never the approval check: a doctor whose
   * licence has not been verified by an administrator cannot use break-glass (Problem 9).
   */
  evaluatePolicy(req, allowedRoles, options = {}) {
    const role = req.user?.role;
    const trustScore = req.trustScore?.score ?? 0;
    const minTrustScore = options.minTrustScore ?? config.security.minTrustScore;
    const breakGlassReason = (req.get('x-break-glass-reason') || '').trim();
    const breakGlass = Boolean(options.allowBreakGlass && breakGlassReason.length >= 10 && BREAK_GLASS_ROLES.includes(role));
    const unapproved = ROLES_NEEDING_APPROVAL.includes(role) && req.sessionState?.approvalStatus !== 'approved';

    const pending = { allowed: false, status: 403, reason: 'approval_pending', message: 'Your account is awaiting administrator verification.' };

    if (breakGlass) {
      if (unapproved) return pending; // approval is checked before break-glass (Problem 9)
      return { allowed: true, reason: 'break_glass_allowed', breakGlass: true, breakGlassReason };
    }
    if (!allowedRoles.includes(role)) {
      return { allowed: false, status: 403, reason: 'role_denied', message: `Access denied. This resource requires the ${allowedRoles.join(' or ')} role.` };
    }
    if (unapproved && !options.allowUnapproved) return pending;
    if (options.requireVerified && !req.sessionState?.isVerified) {
      return { allowed: false, status: 403, reason: 'verification_required', message: 'Access denied. Verified account required.' };
    }
    if (trustScore < minTrustScore) {
      return { allowed: false, status: 403, reason: 'low_trust_score', message: `Access denied. This resource needs a trust score of ${minTrustScore} (yours is ${trustScore}). Log in again to refresh your session.` };
    }
    // Problem 11: the hour is read in the hospital time zone, like the login score.
    if (options.timeWindow && !this.isWithinTimeWindow(localHour(), options.timeWindow)) {
      return { allowed: false, status: 403, reason: 'outside_time_window', message: 'Access denied outside the approved access window.' };
    }
    return { allowed: true, reason: 'policy_allowed', breakGlass: false };
  }

  /** [start, end) in local hours; start > end wraps midnight (e.g. [22, 6]). */
  isWithinTimeWindow(currentHour, [startHour, endHour]) {
    if (startHour === endHour) return true;
    if (startHour < endHour) return currentHour >= startHour && currentHour < endHour;
    return currentHour >= startHour || currentHour < endHour;
  }
}

module.exports = new TrustService();
module.exports.BREAK_GLASS_ROLES = BREAK_GLASS_ROLES;
