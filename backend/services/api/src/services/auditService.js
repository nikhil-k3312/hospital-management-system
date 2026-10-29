const ledgerService = require('./ledgerService');
const logger = require('../utils/logger');
const { sha256 } = require('../utils/hash');

/**
 * Writes one zero-trust access decision (allow or deny) to the "access" chain
 * of the ledger. This is the MongoDB successor of the old JSONL file log: same
 * hash chaining, but concurrency-safe, queryable, and verifiable from the
 * admin dashboard.
 *
 * Errors are logged, never thrown: a failed audit write must not break the
 * request that triggered it.
 */
async function recordAccessDecision({ req, userId, decision, reason, trustScore, breakGlassReason, resource }) {
  try {
    await ledgerService.append({
      chain: 'access',
      entityType: 'access_decision',
      entityId: resource || `${req.method} ${req.originalUrl || req.path}`,
      action: decision === 'allow' ? 'ALLOW' : 'DENY',
      actorId: userId || req.user?.userId || null,
      actorRole: req.user?.role || null,
      meta: {
        reason,
        method: req.method,
        path: (req.originalUrl || req.path || '').split('?')[0],
        ip: req.ip,
        userAgentHash: sha256(req.get('user-agent') || ''),
        trustScore: trustScore ?? req.trustScore?.score ?? null,
        breakGlassReason: breakGlassReason || undefined,
      },
    });
  } catch (error) {
    logger.error(`Audit write failed: ${error.message}`);
  }
}

module.exports = { recordAccessDecision };
