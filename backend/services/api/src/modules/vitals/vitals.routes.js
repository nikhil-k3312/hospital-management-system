const express = require('express');
const crypto = require('crypto');
const VitalReading = require('../../models/VitalReading');
const Device = require('../../models/Device');
const AccessGrant = require('../../models/AccessGrant');
const User = require('../../models/User');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, unauthorized, badRequest } = require('../../utils/errors');
const consentService = require('../../services/consentService');
const notificationService = require('../../services/notificationService');

const router = express.Router();
const { VITAL_RANGES, findAbnormal } = VitalReading;

const readingSchema = Joi.object({
  heartRate: Joi.number().min(20).max(250),
  systolic: Joi.number().min(50).max(260),
  diastolic: Joi.number().min(30).max(160),
  spo2: Joi.number().min(50).max(100),
  temperature: Joi.number().min(30).max(45),
  glucose: Joi.number().min(20).max(600),
  recordedAt: Joi.date().iso().max('now'),
}).or('heartRate', 'systolic', 'diastolic', 'spo2', 'temperature', 'glucose');

/**
 * Saves a reading and, if anything is outside its normal range, alerts the
 * patient and every doctor who currently has consent to see their data.
 */
async function saveReading(patientId, values, source, deviceId = null) {
  const reading = await VitalReading.create({
    patientId, deviceId, source, ...values, abnormal: findAbnormal(values), recordedAt: values.recordedAt || new Date(),
  });

  if (reading.abnormal.length) {
    const details = reading.abnormal.map((f) => `${VITAL_RANGES[f].label} ${reading[f]} ${VITAL_RANGES[f].unit}`).join(', ');
    const patient = await User.findById(patientId).select('fullName');
    const doctors = await AccessGrant.find({ patientId, status: 'active', expiresAt: { $gt: new Date() } }).distinct('doctorId');
    await notificationService.notify(patientId, {
      type: 'danger', title: 'Abnormal vital sign', message: `Out of normal range: ${details}.`, page: 'metrics',
    });
    await notificationService.notify(doctors, {
      type: 'danger', title: `Vitals alert: ${patient.fullName}`, message: `Out of normal range: ${details}.`, page: 'iot',
    });
  }
  return reading;
}

/**
 * POST /api/devices/readings: IoT ingestion. Devices authenticate with an
 * API key in the x-device-key header; the key's hash identifies the device
 * and therefore the patient. No user session is involved.
 */
router.post('/devices/readings', validate({ body: readingSchema }), asyncHandler(async (req, res) => {
  const key = req.get('x-device-key');
  if (!key) throw unauthorized('Device key required', 'NO_DEVICE_KEY');
  const device = await Device.findOne({ apiKeyHash: crypto.createHash('sha256').update(key).digest('hex') });
  if (!device || device.status !== 'active') throw unauthorized('Unknown or inactive device', 'INVALID_DEVICE');

  const reading = await saveReading(device.patientId, req.body, 'device', device._id);
  device.lastSeenAt = new Date();
  await device.save();
  res.status(201).json({ success: true, data: { readingId: reading._id, abnormal: reading.abnormal } });
}));

/** POST /api/vitals: a patient records a reading by hand (home BP cuff, glucometer...). */
router.post('/vitals', authenticate, requireRole('patient'), validate({ body: readingSchema }), asyncHandler(async (req, res) => {
  const reading = await saveReading(req.user.userId, req.body, 'manual');
  res.status(201).json({ success: true, message: reading.abnormal.length ? 'Saved. Some values are outside the normal range.' : 'Reading saved', data: reading });
}));

/** GET /api/vitals?patientId=&days=: a patient's history (own, or consent-gated for doctors). */
router.get('/vitals', authenticate, requireRole('patient', 'doctor', { allowBreakGlass: true }),
  validate({ query: Joi.object({ patientId: objectId(), days: Joi.number().integer().min(1).max(365).default(7), limit: Joi.number().integer().min(1).max(2000).default(500) }) }),
  asyncHandler(async (req, res) => {
    const patientId = req.user.role === 'patient' ? req.user.userId : req.query.patientId;
    if (!patientId) throw badRequest('patientId is required');
    await consentService.assertCanAccessPatient(req, patientId, { purpose: 'view vitals' });
    const since = new Date(Date.now() - req.query.days * 86400000);
    const readings = await VitalReading.find({ patientId, recordedAt: { $gte: since } }).sort({ recordedAt: 1 }).limit(req.query.limit).lean();
    res.json({ success: true, data: { readings, ranges: VITAL_RANGES } });
  }));

/** GET /api/vitals/monitor: a doctor's live view, the latest reading of every consenting patient. */
router.get('/vitals/monitor', authenticate, requireRole('doctor'), asyncHandler(async (req, res) => {
  const patientIds = await consentService.activePatientIdsForDoctor(req.user.userId);
  const [patients, devices] = await Promise.all([
    User.find({ _id: { $in: patientIds } }).select('fullName').lean(),
    Device.find({ patientId: { $in: patientIds } }).select('name type status lastSeenAt patientId').lean(),
  ]);
  const latest = await Promise.all(patientIds.map((id) => VitalReading.findOne({ patientId: id }).sort({ recordedAt: -1 }).lean()));

  res.json({
    success: true,
    data: {
      ranges: VITAL_RANGES,
      patients: patients.map((p) => ({
        patientId: p._id,
        fullName: p.fullName,
        latest: latest.find((r) => r && r.patientId.toString() === p._id.toString()) || null,
        devices: devices.filter((d) => d.patientId.toString() === p._id.toString()),
      })),
    },
  });
}));

/** GET /api/devices/mine: a patient's own registered devices. */
router.get('/devices/mine', authenticate, requireRole('patient'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await Device.find({ patientId: req.user.userId }).sort({ createdAt: -1 }) });
}));

module.exports = router;
module.exports.saveReading = saveReading;
