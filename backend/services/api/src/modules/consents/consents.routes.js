const express = require('express');
const AccessGrant = require('../../models/AccessGrant');
const User = require('../../models/User');
const HospitalSettings = require('../../models/HospitalSettings');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, conflict } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');

const router = express.Router();
router.use(authenticate);

const idParam = { params: Joi.object({ id: objectId().required() }) };

async function ledger(grant, action, req) {
  const entry = await ledgerService.recordEvent({
    entityType: 'consent', entity: grant, action, actor: req.user,
  });
  grant.ledgerEntryId = entry._id.toString();
  await grant.save();
}

const present = (g, now = new Date()) => ({ ...g.toObject(), status: g.effectiveStatus(now) });

/** GET /api/consents: patients see who can access them; doctors see whom they can access. */
router.get('/', requireRole('patient', 'doctor', { allowUnapproved: true }), asyncHandler(async (req, res) => {
  const filter = req.user.role === 'patient' ? { patientId: req.user.userId } : { doctorId: req.user.userId };
  const grants = await AccessGrant.find(filter)
    .populate('patientId', 'fullName email')
    .populate('doctorId', 'fullName doctorProfile.specialization')
    .sort({ updatedAt: -1 });
  res.json({ success: true, data: grants.map((g) => present(g)) });
}));

/** POST /api/consents/request: a doctor asks a patient for access. */
router.post('/request', requireRole('doctor'),
  validate({ body: Joi.object({ patientId: objectId().required(), purpose: Joi.string().trim().min(5).max(300).required() }) }),
  asyncHandler(async (req, res) => {
    const patient = await User.findOne({ _id: req.body.patientId, role: 'patient', isActive: true });
    if (!patient) throw notFound('Patient not found');

    const existing = await AccessGrant.findOne({
      patientId: patient._id, doctorId: req.user.userId,
      $or: [{ status: 'requested' }, { status: 'active', expiresAt: { $gt: new Date() } }],
    });
    if (existing) throw conflict(existing.status === 'requested' ? 'A request is already waiting for the patient' : 'You already have active access', 'CONSENT_EXISTS');

    const grant = await AccessGrant.create({
      patientId: patient._id, doctorId: req.user.userId, status: 'requested', purpose: req.body.purpose, requestedBy: 'doctor',
    });
    await ledger(grant, 'REQUEST_ACCESS', req);

    const doctor = await User.findById(req.user.userId);
    await notificationService.notify(patient._id, {
      type: 'warning', title: 'Access request',
      message: `Dr. ${doctor.fullName} is requesting access to your medical records: "${req.body.purpose}"`, page: 'permissions',
    });
    res.status(201).json({ success: true, message: 'Access request sent to the patient', data: present(grant) });
  }));

/** POST /api/consents/grant: a patient grants a doctor access without being asked. */
router.post('/grant', requireRole('patient'),
  validate({ body: Joi.object({
    doctorId: objectId().required(),
    durationDays: Joi.number().integer().min(1).max(365),
    purpose: Joi.string().trim().max(300).allow('').default('Granted by patient'),
  }) }),
  asyncHandler(async (req, res) => {
    const doctor = await User.findOne({ _id: req.body.doctorId, role: 'doctor', approvalStatus: 'approved', isActive: true });
    if (!doctor) throw notFound('Doctor not found');
    const settings = await HospitalSettings.getSingleton();
    const days = req.body.durationDays || settings.defaultConsentDays;

    // Replace any pending request or existing active grant with this one.
    await AccessGrant.updateMany(
      { patientId: req.user.userId, doctorId: doctor._id, status: { $in: ['requested', 'active'] } },
      { $set: { status: 'revoked', revokedAt: new Date() } }
    );
    const now = new Date();
    const grant = await AccessGrant.create({
      patientId: req.user.userId, doctorId: doctor._id, status: 'active', purpose: req.body.purpose,
      requestedBy: 'patient', grantedAt: now, expiresAt: new Date(now.getTime() + days * 86400000),
    });
    await ledger(grant, 'GRANT_ACCESS', req);
    await notificationService.notify(doctor._id, {
      type: 'success', title: 'Access granted',
      message: `A patient granted you access to their records for ${days} days.`, page: 'patients',
    });
    res.status(201).json({ success: true, message: `Access granted for ${days} days`, data: present(grant) });
  }));

async function loadPatientGrant(req) {
  const grant = await AccessGrant.findOne({ _id: req.params.id, patientId: req.user.userId });
  if (!grant) throw notFound('Consent not found');
  return grant;
}

/** POST /api/consents/:id/approve: the patient approves a doctor's request. */
router.post('/:id/approve', requireRole('patient'),
  validate({ ...idParam, body: Joi.object({ durationDays: Joi.number().integer().min(1).max(365) }) }),
  asyncHandler(async (req, res) => {
    const grant = await loadPatientGrant(req);
    if (grant.status !== 'requested') throw conflict(`This request is already ${grant.status}`, 'INVALID_TRANSITION');
    const settings = await HospitalSettings.getSingleton();
    const days = req.body?.durationDays || settings.defaultConsentDays;
    grant.status = 'active';
    grant.grantedAt = new Date();
    grant.expiresAt = new Date(Date.now() + days * 86400000);
    await ledger(grant, 'GRANT_ACCESS', req);
    await notificationService.notify(grant.doctorId, {
      type: 'success', title: 'Access request approved', message: `Your access request was approved for ${days} days.`, page: 'patients',
    });
    res.json({ success: true, message: `Access approved for ${days} days`, data: present(grant) });
  }));

/** POST /api/consents/:id/deny */
router.post('/:id/deny', requireRole('patient'), validate(idParam), asyncHandler(async (req, res) => {
  const grant = await loadPatientGrant(req);
  if (grant.status !== 'requested') throw conflict(`This request is already ${grant.status}`, 'INVALID_TRANSITION');
  grant.status = 'denied';
  await ledger(grant, 'DENY_ACCESS', req);
  await notificationService.notify(grant.doctorId, {
    type: 'danger', title: 'Access request denied', message: 'A patient denied your access request.', page: 'patients',
  });
  res.json({ success: true, message: 'Request denied', data: present(grant) });
}));

/** POST /api/consents/:id/revoke: takes effect on the doctor's very next request. */
router.post('/:id/revoke', requireRole('patient'), validate(idParam), asyncHandler(async (req, res) => {
  const grant = await loadPatientGrant(req);
  if (grant.status !== 'active') throw conflict('Only active access can be revoked', 'INVALID_TRANSITION');
  grant.status = 'revoked';
  grant.revokedAt = new Date();
  await ledger(grant, 'REVOKE_ACCESS', req);
  await notificationService.notify(grant.doctorId, {
    type: 'warning', title: 'Access revoked', message: 'A patient revoked your access to their records.', page: 'patients',
  });
  res.json({ success: true, message: 'Access revoked', data: present(grant) });
}));

module.exports = router;
