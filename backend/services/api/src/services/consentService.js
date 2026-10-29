const AccessGrant = require('../models/AccessGrant');
const { forbidden } = require('../utils/errors');
const ledgerService = require('./ledgerService');
const notificationService = require('./notificationService');

/** True when the doctor holds an approved, unexpired grant for this patient. */
async function hasActiveGrant(doctorId, patientId, now = new Date()) {
  const grant = await AccessGrant.exists({
    doctorId, patientId, status: 'active', expiresAt: { $gt: now },
  });
  return Boolean(grant);
}

/** Ids of every patient who currently allows this doctor in. */
async function activePatientIdsForDoctor(doctorId, now = new Date()) {
  const grants = await AccessGrant.find({ doctorId, status: 'active', expiresAt: { $gt: now } }).select('patientId').lean();
  return grants.map((g) => g.patientId.toString());
}

/**
 * The consent gate used by records, files, prescriptions and vitals.
 *   patient  -> only their own data
 *   doctor   -> needs an active grant, OR a break-glass request (audited, and
 *               the patient is told immediately)
 *   admin    -> only via break-glass (admins run the system, they do not treat patients)
 * Throws 403 when access is not allowed.
 */
async function assertCanAccessPatient(req, patientId, { purpose = 'view medical data' } = {}) {
  const { userId, role } = req.user;
  const pid = String(patientId);

  if (role === 'patient') {
    if (userId === pid) return { via: 'owner' };
    throw forbidden('Patients can only access their own data.', 'NOT_OWNER');
  }

  if (role === 'doctor' && await hasActiveGrant(userId, pid)) {
    return { via: 'consent' };
  }

  if (req.policy?.breakGlass) {
    await ledgerService.append({
      chain: 'records',
      entityType: 'patient',
      entityId: pid,
      action: 'BREAK_GLASS_ACCESS',
      actorId: userId,
      actorRole: role,
      meta: { reason: req.policy.breakGlassReason, purpose, path: req.originalUrl },
    });
    await notificationService.notify(pid, {
      type: 'danger',
      title: 'Emergency access to your records',
      message: `A ${role} accessed your records under emergency (break-glass) access. Reason given: "${req.policy.breakGlassReason}". This access is logged in the ledger.`,
      page: 'permissions',
    });
    await notificationService.notifyRole('admin', {
      type: 'warning',
      title: 'Break-glass access used',
      message: `A ${role} used emergency access to a patient's records. Review it in Access Control.`,
      page: 'access',
    });
    return { via: 'break_glass' };
  }

  throw forbidden('No active consent from this patient. Request access, or use emergency access if this is an emergency.', 'CONSENT_REQUIRED');
}

module.exports = { hasActiveGrant, activePatientIdsForDoctor, assertCanAccessPatient };
