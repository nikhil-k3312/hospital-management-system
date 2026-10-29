const express = require('express');
const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Appointment = require('../../models/Appointment');
const MedicalRecord = require('../../models/MedicalRecord');
const Claim = require('../../models/Claim');
const Bill = require('../../models/Bill');
const Device = require('../../models/Device');
const VitalReading = require('../../models/VitalReading');
const AccessGrant = require('../../models/AccessGrant');
const LedgerEntry = require('../../models/LedgerEntry');
const HospitalSettings = require('../../models/HospitalSettings');
const redisClient = require('../../db/redis');
const { authenticate, requireRole, invalidateSession } = require('../../middleware/auth');
const { validate, objectId, password, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, conflict, badRequest } = require('../../utils/errors');
const tokenService = require('../../services/tokenService');
const ledgerService = require('../../services/ledgerService');
const emailService = require('../../services/emailService');
const notificationService = require('../../services/notificationService');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------------------------------------------------------------- users */

/** GET /api/admin/users?role=&status=&q= */
router.get('/users', validate({ query: Joi.object({
  role: Joi.string().valid(...User.ROLES),
  status: Joi.string().valid('active', 'inactive', 'pending'),
  q: Joi.string().trim().max(100).allow(''),
}) }), asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.status === 'active') filter.isActive = true;
  if (req.query.status === 'inactive') filter.isActive = false;
  if (req.query.status === 'pending') filter.approvalStatus = 'pending';
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [{ fullName: rx }, { email: rx }];
  }
  const users = await User.find(filter).sort({ createdAt: -1 }).limit(500);
  res.json({ success: true, data: users });
}));

/**
 * POST /api/admin/users: creates staff accounts (doctor, admin, insurance
 * agent). These are approved immediately because an admin created them.
 */
router.post('/users', validate({ body: Joi.object({
  email: Joi.string().email().lowercase().required(),
  fullName: Joi.string().trim().min(2).max(100).required(),
  password: password().required(),
  role: Joi.string().valid('doctor', 'admin', 'insurance_agent').required(),
  phone: Joi.string().trim().max(30).allow('').default(''),
  specialization: Joi.when('role', { is: 'doctor', then: Joi.string().trim().required(), otherwise: Joi.forbidden() }),
  licenseNumber: Joi.when('role', { is: 'doctor', then: Joi.string().trim().required(), otherwise: Joi.forbidden() }),
  consultationFee: Joi.when('role', { is: 'doctor', then: Joi.number().min(0).default(500), otherwise: Joi.forbidden() }),
  company: Joi.when('role', { is: 'insurance_agent', then: Joi.string().trim().required(), otherwise: Joi.forbidden() }),
}) }), asyncHandler(async (req, res) => {
  const b = req.body;
  if (await User.exists({ email: b.email })) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  const user = new User({ email: b.email, fullName: b.fullName, passwordHash: b.password, role: b.role, phone: b.phone, approvalStatus: 'approved' });
  if (b.role === 'doctor') {
    Object.assign(user.doctorProfile, { specialization: b.specialization, licenseNumber: b.licenseNumber, department: b.specialization, consultationFee: b.consultationFee });
  }
  if (b.role === 'insurance_agent') user.agentProfile = { company: b.company, employeeId: '' };
  await user.save();
  await ledgerService.append({
    chain: 'records', entityType: 'user', entityId: user._id, action: 'STAFF_CREATED', actorId: req.user.userId, actorRole: 'admin',
    payload: { email: user.email, role: user.role, ledgerAddress: user.ledgerAddress },
  });
  emailService.sendWelcome(user.email, user.fullName, user.role, false);
  res.status(201).json({ success: true, message: `${b.role.replace('_', ' ')} account created`, data: user });
}));

/** PATCH /api/admin/users/:id { isActive }: deactivation signs the user out everywhere. */
router.patch('/users/:id', validate({
  params: Joi.object({ id: objectId().required() }),
  body: Joi.object({ isActive: Joi.boolean().required() }),
}), asyncHandler(async (req, res) => {
  if (req.params.id === req.user.userId) throw badRequest('You cannot deactivate your own account');
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('User not found');
  user.isActive = req.body.isActive;
  if (!user.isActive) user.refreshTokens = [];
  await user.save();
  if (!user.isActive) await tokenService.revokeAllRefreshTokens(user._id.toString());
  await invalidateSession(user._id); // takes effect on the user's very next request
  await ledgerService.append({
    chain: 'records', entityType: 'user', entityId: user._id, action: user.isActive ? 'ACTIVATED' : 'DEACTIVATED',
    actorId: req.user.userId, actorRole: 'admin', payload: { isActive: user.isActive },
  });
  res.json({ success: true, message: `Account ${user.isActive ? 'activated' : 'deactivated'}`, data: user });
}));

/* ---------------------------------------------------------------- verification */

/** GET /api/admin/doctors/pending-verification: doctors and insurance agents awaiting approval. */
router.get('/doctors/pending-verification', asyncHandler(async (req, res) => {
  const pending = await User.find({ approvalStatus: 'pending', role: { $in: User.ROLES_NEEDING_APPROVAL } }).sort({ createdAt: 1 });
  res.json({ success: true, data: pending });
}));

/** PATCH /api/admin/doctors/:id/verify { decision: 'approve'|'reject', note } */
router.patch('/doctors/:id/verify', validate({
  params: Joi.object({ id: objectId().required() }),
  body: Joi.object({ decision: Joi.string().valid('approve', 'reject').required(), note: Joi.string().trim().max(500).allow('').default('') }),
}), asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: { $in: User.ROLES_NEEDING_APPROVAL } });
  if (!user) throw notFound('Account not found');
  if (user.approvalStatus !== 'pending') throw conflict(`This account is already ${user.approvalStatus}`, 'ALREADY_DECIDED');

  const approved = req.body.decision === 'approve';
  user.approvalStatus = approved ? 'approved' : 'rejected';
  user.approvalNote = req.body.note;
  await user.save();
  await invalidateSession(user._id); // the new status applies on their next request
  await ledgerService.append({
    chain: 'records', entityType: 'user', entityId: user._id, action: approved ? 'CREDENTIALS_VERIFIED' : 'CREDENTIALS_REJECTED',
    actorId: req.user.userId, actorRole: 'admin', payload: { approvalStatus: user.approvalStatus, licenseNumber: user.doctorProfile?.licenseNumber },
  });
  await notificationService.notify(user._id, {
    type: approved ? 'success' : 'danger',
    title: approved ? 'Account verified' : 'Verification declined',
    message: approved ? 'Your credentials were verified. All features are now available.' : `Your verification was declined. ${req.body.note}`,
  });
  emailService.sendApprovalDecision(user.email, user.fullName, approved, req.body.note);
  res.json({ success: true, message: `Account ${approved ? 'approved' : 'rejected'}`, data: user });
}));

/* ---------------------------------------------------------------- statistics */

async function ping(fn) {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** GET /api/admin/stats: every number on the admin overview, computed live. */
router.get('/stats', asyncHandler(async (req, res) => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday.getTime() + 86400000);
  const weekAgo = new Date(startOfToday.getTime() - 6 * 86400000);

  const [usersByRole, pendingVerification, appointmentsToday, appointmentsByStatus, weekly, records, claimsByStatus, revenue,
    devices, readings24h, activeConsents, ledger, mongoPing, redisPing] = await Promise.all([
    User.aggregate([{ $group: { _id: '$role', total: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } }]),
    User.countDocuments({ approvalStatus: 'pending' }),
    Appointment.countDocuments({ startTime: { $gte: startOfToday, $lt: endOfToday }, status: { $ne: 'cancelled' } }),
    Appointment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Appointment.aggregate([
      { $match: { startTime: { $gte: weekAgo, $lt: endOfToday }, status: { $ne: 'cancelled' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startTime', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }, count: { $sum: 1 } } },
    ]),
    MedicalRecord.countDocuments(),
    Claim.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    Bill.aggregate([{ $group: { _id: null, billed: { $sum: '$amount' }, paid: { $sum: '$paidAmount' }, covered: { $sum: '$coveredAmount' } } }]),
    Device.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    VitalReading.countDocuments({ recordedAt: { $gte: new Date(Date.now() - 86400000) } }),
    AccessGrant.countDocuments({ status: 'active', expiresAt: { $gt: new Date() } }),
    ledgerService.stats(),
    ping(() => mongoose.connection.db.admin().ping()),
    ping(() => redisClient.ping()),
  ]);

  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(weekAgo.getTime() + i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: key, count: weekly.find((w) => w._id === key)?.count || 0 });
  }
  const mem = process.memoryUsage();

  res.json({
    success: true,
    data: {
      users: { byRole: usersByRole, total: usersByRole.reduce((n, r) => n + r.total, 0), pendingVerification },
      appointments: { today: appointmentsToday, byStatus: appointmentsByStatus, last7Days: days },
      records,
      activeConsents,
      claims: { byStatus: claimsByStatus },
      revenue: revenue[0] || { billed: 0, paid: 0, covered: 0 },
      iot: { devices, readings24h },
      ledger,
      system: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576), heapTotalMB: Math.round(mem.heapTotal / 1048576) },
        loadAverage: os.loadavg(),
        cpus: os.cpus().length,
        mongo: mongoPing,
        redis: redisPing,
      },
    },
  });
}));

/* ---------------------------------------------------------------- settings */

const settingsSchema = Joi.object({
  hospitalName: Joi.string().trim().min(2).max(120),
  address: Joi.string().trim().max(300).allow(''),
  contactEmail: Joi.string().email().allow(''),
  contactPhone: Joi.string().trim().max(30).allow(''),
  maxAdvanceBookingDays: Joi.number().integer().min(1).max(365),
  defaultConsentDays: Joi.number().integer().min(1).max(365),
  insuranceProviders: Joi.array().items(Joi.string().trim().min(2).max(100)).max(50).unique(),
  departments: Joi.array().items(Joi.string().trim().min(2).max(100)).max(50).unique(),
}).min(1);

router.get('/settings', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await HospitalSettings.getSingleton() });
}));

router.patch('/settings', validate({ body: settingsSchema }), asyncHandler(async (req, res) => {
  const settings = await HospitalSettings.getSingleton();
  Object.assign(settings, req.body);
  await settings.save();
  await ledgerService.append({
    chain: 'records', entityType: 'settings', entityId: settings._id, action: 'UPDATE', actorId: req.user.userId, actorRole: 'admin',
    payload: req.body,
  });
  res.json({ success: true, message: 'Settings saved', data: settings });
}));

/* ---------------------------------------------------------------- access audit */

/** GET /api/admin/audit?decision=&reason=&limit=: the zero-trust access chain, newest first. */
router.get('/audit', validate({ query: Joi.object({
  decision: Joi.string().valid('allow', 'deny'),
  reason: Joi.string().max(60),
  limit: Joi.number().integer().min(1).max(500).default(100),
}) }), asyncHandler(async (req, res) => {
  const filter = { chain: 'access' };
  if (req.query.decision) filter.action = req.query.decision === 'allow' ? 'ALLOW' : 'DENY';
  if (req.query.reason) filter['meta.reason'] = req.query.reason;
  const entries = await LedgerEntry.find(filter).sort({ seq: -1 }).limit(req.query.limit).lean();

  const actorIds = [...new Set(entries.map((e) => e.actorId).filter(Boolean))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('fullName email role').lean();
  const byId = new Map(actors.map((a) => [a._id.toString(), a]));

  const [denied24h, breakGlass] = await Promise.all([
    LedgerEntry.countDocuments({ chain: 'access', action: 'DENY', timestamp: { $gte: new Date(Date.now() - 86400000) } }),
    LedgerEntry.countDocuments({ chain: 'access', 'meta.reason': 'break_glass_allowed' }),
  ]);
  res.json({
    success: true,
    data: entries.map((e) => ({ ...e, actor: byId.get(e.actorId) || null })),
    meta: { denied24h, breakGlassTotal: breakGlass },
  });
}));

/* ---------------------------------------------------------------- IoT devices */

router.get('/devices', asyncHandler(async (req, res) => {
  const devices = await Device.find().populate('patientId', 'fullName email').sort({ createdAt: -1 });
  res.json({ success: true, data: devices });
}));

/**
 * POST /api/admin/devices: registers a device for a patient. The plain API
 * key is returned ONCE here (to configure the device) and stored only as a hash.
 */
router.post('/devices', validate({ body: Joi.object({
  serialNumber: Joi.string().trim().min(3).max(60).required(),
  name: Joi.string().trim().min(2).max(100).required(),
  type: Joi.string().valid('heart_monitor', 'bp_monitor', 'pulse_oximeter', 'thermometer', 'multi_parameter').required(),
  patientId: objectId().required(),
}) }), asyncHandler(async (req, res) => {
  const patient = await User.findOne({ _id: req.body.patientId, role: 'patient' });
  if (!patient) throw notFound('Patient not found');
  const apiKey = `mcd_${crypto.randomBytes(24).toString('hex')}`;
  const device = await Device.create({
    ...req.body, apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex'), registeredBy: req.user.userId,
  });
  await notificationService.notify(patient._id, {
    type: 'info', title: 'Device registered', message: `${device.name} was linked to your account. Its readings will appear in Health Metrics.`, page: 'metrics',
  });
  res.status(201).json({ success: true, message: 'Device registered. Copy the API key now: it will not be shown again.', data: { device, apiKey } });
}));

router.patch('/devices/:id', validate({
  params: Joi.object({ id: objectId().required() }),
  body: Joi.object({ status: Joi.string().valid('active', 'inactive').required() }),
}), asyncHandler(async (req, res) => {
  const device = await Device.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (!device) throw notFound('Device not found');
  res.json({ success: true, message: `Device ${req.body.status === 'active' ? 'activated' : 'deactivated'}`, data: device });
}));

module.exports = router;
