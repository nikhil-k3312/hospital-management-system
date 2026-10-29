const crypto = require('crypto');
const config = require('../config/config');
const { ROLES_NEEDING_APPROVAL } = require('../models/User');

const BREAK_GLASS_ROLES = ['doctor', 'admin'];

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
    const sessionAgeSeconds = tokenPayload?.iat
      ? Math.max(0, Math.floor(Date.now() / 1000) - tokenPayload.iat)
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
      ip: req.ip,
    };
  }

  /**
   * RBAC first, then ABAC conditions. The first failing check wins.
   * A valid break-glass request (doctor/admin + reason header + route that
   * allows it) bypasses everything except authentication itself.
   */
  evaluatePolicy(req, allowedRoles, options = {}) {
    const role = req.user?.role;
    const trustScore = req.trustScore?.score ?? 0;
    const minTrustScore = options.minTrustScore ?? config.security.minTrustScore;
    const breakGlassReason = (req.get('x-break-glass-reason') || '').trim();
    const breakGlass = Boolean(options.allowBreakGlass && breakGlassReason.length >= 10 && BREAK_GLASS_ROLES.includes(role));

    if (breakGlass) {
      return { allowed: true, reason: 'break_glass_allowed', breakGlass: true, breakGlassReason };
    }
    if (!allowedRoles.includes(role)) {
      return { allowed: false, status: 403, reason: 'role_denied', message: `Access denied. This resource requires the ${allowedRoles.join(' or ')} role.` };
    }
    if (ROLES_NEEDING_APPROVAL.includes(role) && !options.allowUnapproved && req.sessionState?.approvalStatus !== 'approved') {
      return { allowed: false, status: 403, reason: 'approval_pending', message: 'Your account is awaiting administrator verification.' };
    }
    if (options.requireVerified && !req.sessionState?.isVerified) {
      return { allowed: false, status: 403, reason: 'verification_required', message: 'Access denied. Verified account required.' };
    }
    if (trustScore < minTrustScore) {
      return { allowed: false, status: 403, reason: 'low_trust_score', message: `Access denied. This resource needs a trust score of ${minTrustScore} (yours is ${trustScore}). Log in again to refresh your session.` };
    }
    if (options.timeWindow && !this.isWithinTimeWindow(new Date().getHours(), options.timeWindow)) {
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
