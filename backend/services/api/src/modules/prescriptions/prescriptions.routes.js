const express = require('express');
const Prescription = require('../../models/Prescription');
const config = require('../../config/config');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, conflict } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');
const consentService = require('../../services/consentService');
const notificationService = require('../../services/notificationService');

const router = express.Router();
router.use(authenticate);

const populate = (q) => q.populate('patientId', 'fullName email').populate('doctorId', 'fullName doctorProfile.specialization');
const idParam = { params: Joi.object({ id: objectId().required() }) };

async function chain(rx, action, req, meta) {
  const entry = await ledgerService.recordEvent({ entityType: 'prescription', entity: rx, action, actor: req.user, meta });
  rx.ledgerEntryId = entry._id.toString();
  await rx.save();
}

/** POST /api/prescriptions: a doctor prescribes for a patient who consented. */
router.post('/', requireRole('doctor', { minTrustScore: config.security.highSensitivityTrustScore }),
  validate({ body: Joi.object({
    patientId: objectId().required(),
    medication: Joi.string().trim().min(2).max(120).required(),
    dosage: Joi.string().trim().max(60).required(),
    frequency: Joi.string().trim().max(120).required(),
    instructions: Joi.string().trim().max(1000).allow('').default(''),
    durationDays: Joi.number().integer().min(1).max(365).default(30),
    refillsAllowed: Joi.number().integer().min(0).max(12).default(0),
  }) }),
  asyncHandler(async (req, res) => {
    await consentService.assertCanAccessPatient(req, req.body.patientId, { purpose: 'prescribe' });
    const { durationDays, ...fields } = req.body;
    const rx = new Prescription({
      ...fields, doctorId: req.user.userId, startDate: new Date(), endDate: new Date(Date.now() + durationDays * 86400000),
    });
    await chain(rx, 'CREATE', req);
    await notificationService.notify(rx.patientId, {
      type: 'info', title: 'New prescription', message: `${rx.medication} ${rx.dosage}, ${rx.frequency}`, page: 'medications',
    });
    res.status(201).json({ success: true, message: 'Prescription issued', data: await populate(Prescription.findById(rx._id)) });
  }));

/** GET /api/prescriptions?status=: patients see theirs, doctors see the ones they issued. */
router.get('/', requireRole('patient', 'doctor'),
  validate({ query: Joi.object({ status: Joi.string().valid('active', 'completed', 'cancelled') }) }),
  asyncHandler(async (req, res) => {
    const filter = req.user.role === 'patient' ? { patientId: req.user.userId } : { doctorId: req.user.userId };
    if (req.query.status) filter.status = req.query.status;
    res.json({ success: true, data: await populate(Prescription.find(filter).sort({ createdAt: -1 })) });
  }));

/** POST /api/prescriptions/:id/refill-request: the patient asks for a refill. */
router.post('/:id/refill-request', requireRole('patient'), validate(idParam), asyncHandler(async (req, res) => {
  const rx = await Prescription.findOne({ _id: req.params.id, patientId: req.user.userId });
  if (!rx) throw notFound('Prescription not found');
  if (rx.status !== 'active') throw conflict('Only active prescriptions can be refilled', 'INVALID_TRANSITION');
  if (rx.refillRequest.status === 'pending') throw conflict('A refill request is already pending', 'ALREADY_PENDING');
  if (rx.refillsUsed >= rx.refillsAllowed) throw conflict('No refills remain on this prescription. Book an appointment for a new one.', 'NO_REFILLS');

  rx.refillRequest = { status: 'pending', requestedAt: new Date(), decidedAt: null };
  await chain(rx, 'REFILL_REQUESTED', req);
  await notificationService.notify(rx.doctorId, {
    type: 'warning', title: 'Refill request', message: `A patient requested a refill of ${rx.medication} ${rx.dosage}.`, page: 'prescriptions',
  });
  res.json({ success: true, message: 'Refill requested', data: rx });
}));

/** PATCH /api/prescriptions/:id { action }: approve/deny refill, complete or cancel. */
router.patch('/:id', requireRole('doctor'),
  validate({ ...idParam, body: Joi.object({ action: Joi.string().valid('approve_refill', 'deny_refill', 'complete', 'cancel').required() }) }),
  asyncHandler(async (req, res) => {
    const rx = await Prescription.findOne({ _id: req.params.id, doctorId: req.user.userId });
    if (!rx) throw notFound('Prescription not found');
    const { action } = req.body;

    if (action === 'approve_refill' || action === 'deny_refill') {
      if (rx.refillRequest.status !== 'pending') throw conflict('There is no pending refill request', 'INVALID_TRANSITION');
      const approved = action === 'approve_refill';
      rx.refillRequest.status = approved ? 'approved' : 'denied';
      rx.refillRequest.decidedAt = new Date();
      if (approved) rx.refillsUsed += 1;
      await chain(rx, approved ? 'REFILL_APPROVED' : 'REFILL_DENIED', req);
      await notificationService.notify(rx.patientId, {
        type: approved ? 'success' : 'danger',
        title: `Refill ${approved ? 'approved' : 'denied'}`,
        message: `Your refill of ${rx.medication} was ${approved ? 'approved' : 'denied'}.`,
        page: 'medications',
      });
    } else {
      if (rx.status !== 'active') throw conflict(`The prescription is already ${rx.status}`, 'INVALID_TRANSITION');
      rx.status = action === 'complete' ? 'completed' : 'cancelled';
      await chain(rx, action === 'complete' ? 'COMPLETE' : 'CANCEL', req);
    }
    res.json({ success: true, message: 'Prescription updated', data: await populate(Prescription.findById(rx._id)) });
  }));

module.exports = router;
