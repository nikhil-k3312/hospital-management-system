const express = require('express');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Appointment = require('../../models/Appointment');
const AccessGrant = require('../../models/AccessGrant');
const HospitalSettings = require('../../models/HospitalSettings');
const LedgerEntry = require('../../models/LedgerEntry');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, badRequest } = require('../../utils/errors');
const { buildDaySlots } = require('../appointments/slots');

const router = express.Router();

/* ---------------------------------------------------------------- public */

/** GET /api/settings/public: what the login and registration pages need before anyone logs in. */
router.get('/settings/public', asyncHandler(async (req, res) => {
  const settings = await HospitalSettings.getSingleton();
  res.json({
    success: true,
    data: {
      hospitalName: settings.hospitalName,
      insuranceProviders: settings.insuranceProviders,
      departments: settings.departments,
      contactEmail: settings.contactEmail,
      contactPhone: settings.contactPhone,
    },
  });
}));

/** GET /api/public/stats: anonymous aggregate counts for the landing page. No personal data. */
router.get('/public/stats', asyncHandler(async (req, res) => {
  const [patients, doctors, appointmentsCompleted, ledgerBlocks] = await Promise.all([
    User.countDocuments({ role: 'patient', isActive: true }),
    User.countDocuments({ role: 'doctor', approvalStatus: 'approved', isActive: true }),
    Appointment.countDocuments({ status: 'completed' }),
    LedgerEntry.countDocuments({ chain: 'records' }),
  ]);
  res.json({ success: true, data: { patients, doctors, appointmentsCompleted, ledgerBlocks } });
}));

/* ---------------------------------------------------------------- profile */

/** GET /api/users/me: the logged-in user plus the trust context of this request. */
router.get('/users/me', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) throw notFound('User not found');
  res.json({ success: true, data: { user: user.toJSON(), trustScore: req.trustScore } });
}));

const profileSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100),
  phone: Joi.string().trim().max(30).allow(''),
  dateOfBirth: Joi.date().iso().max('now').allow(null),
  gender: Joi.string().valid('female', 'male', 'other', ''),
  address: Joi.string().trim().max(300).allow(''),
  patientProfile: Joi.object({
    bloodType: Joi.string().valid('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', ''),
    allergies: Joi.array().items(Joi.string().trim().max(60)).max(30),
    emergencyContact: Joi.string().trim().max(150).allow(''),
    insuranceProvider: Joi.string().trim().max(100).allow(''),
    policyNumber: Joi.string().trim().max(60).allow(''),
  }),
  doctorProfile: Joi.object({
    specialization: Joi.string().trim().max(100),
    department: Joi.string().trim().max(100).allow(''),
    consultationFee: Joi.number().min(0).max(100000),
    availability: Joi.object({
      days: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1).unique(),
      startHour: Joi.number().integer().min(0).max(23),
      endHour: Joi.number().integer().min(1).max(24),
      slotMinutes: Joi.number().valid(15, 20, 30, 45, 60),
    }),
  }),
  agentProfile: Joi.object({ employeeId: Joi.string().trim().max(60).allow('') }),
}).min(1);

/**
 * PATCH /api/users/me: each role may only edit its own profile section.
 * Email, role, approval and security fields can never be changed here.
 */
router.patch('/users/me', authenticate, validate({ body: profileSchema }), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.userId);
  const body = req.body;

  ['fullName', 'phone', 'dateOfBirth', 'gender', 'address'].forEach((field) => {
    if (body[field] !== undefined) user[field] = body[field];
  });

  const section = { patient: 'patientProfile', doctor: 'doctorProfile', insurance_agent: 'agentProfile' }[user.role];
  for (const key of ['patientProfile', 'doctorProfile', 'agentProfile']) {
    if (body[key] && key !== section) throw badRequest(`${key} cannot be set for a ${user.role} account`);
  }
  if (section && body[section]) {
    const { availability, ...rest } = body[section];
    Object.assign(user[section], rest);
    if (availability) {
      const merged = { ...user.doctorProfile.availability.toObject(), ...availability };
      if (merged.endHour <= merged.startHour) throw badRequest('Availability end hour must be after the start hour');
      user.doctorProfile.availability = merged;
    }
  }

  await user.save();
  res.json({ success: true, message: 'Profile updated', data: { user: user.toJSON() } });
}));

/* ---------------------------------------------------------------- doctors */

/** GET /api/doctors: verified, active doctors that patients can book. */
router.get('/doctors', authenticate, asyncHandler(async (req, res) => {
  const filter = { role: 'doctor', approvalStatus: 'approved', isActive: true };
  if (req.query.specialization) filter['doctorProfile.specialization'] = req.query.specialization;
  const doctors = await User.find(filter).sort({ fullName: 1 });
  res.json({
    success: true,
    data: doctors.map((d) => ({
      ...d.toPublic(),
      doctorProfile: {
        specialization: d.doctorProfile.specialization,
        department: d.doctorProfile.department,
        consultationFee: d.doctorProfile.consultationFee,
        availability: d.doctorProfile.availability,
      },
    })),
  });
}));

/** GET /api/doctors/:doctorId/available-slots?date=YYYY-MM-DD */
router.get('/doctors/:doctorId/available-slots', authenticate,
  validate({ params: Joi.object({ doctorId: objectId().required() }), query: Joi.object({ date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required() }) }),
  asyncHandler(async (req, res) => {
    const doctor = await User.findOne({ _id: req.params.doctorId, role: 'doctor', approvalStatus: 'approved', isActive: true });
    if (!doctor) throw notFound('Doctor not found');
    const settings = await HospitalSettings.getSingleton();

    const slots = buildDaySlots(doctor.doctorProfile.availability, req.query.date, settings.maxAdvanceBookingDays);
    if (slots.length === 0) return res.json({ success: true, data: { date: req.query.date, slots: [] } });

    const taken = await Appointment.find({
      doctorId: doctor._id, holdsSlot: true,
      startTime: { $gte: slots[0].start, $lte: slots[slots.length - 1].start },
    }).select('startTime').lean();
    const takenSet = new Set(taken.map((a) => a.startTime.toISOString()));

    res.json({
      success: true,
      data: {
        date: req.query.date,
        slots: slots.map((s) => ({ start: s.start, end: s.end, available: !takenSet.has(s.start.toISOString()) })),
      },
    });
  }));

/* ---------------------------------------------------------------- patients (doctor view) */

/**
 * GET /api/patients: a doctor's patient list = everyone who booked them or
 * has a consent relationship with them, with the current consent status.
 * Only demographics are shown here; clinical data stays behind consent.
 */
router.get('/patients', authenticate, requireRole('doctor'), asyncHandler(async (req, res) => {
  const doctorId = req.user.userId;
  const [appointmentPatients, grants] = await Promise.all([
    Appointment.distinct('patientId', { doctorId }),
    AccessGrant.find({ doctorId }).sort({ updatedAt: -1 }),
  ]);

  const ids = new Set([...appointmentPatients.map(String), ...grants.map((g) => g.patientId.toString())]);
  const patients = await User.find({ _id: { $in: [...ids] }, role: 'patient' }).sort({ fullName: 1 });
  const lastVisits = await Appointment.aggregate([
    { $match: { doctorId: new mongoose.Types.ObjectId(doctorId), status: 'completed' } },
    { $group: { _id: '$patientId', lastVisit: { $max: '$startTime' } } },
  ]);
  const lastVisitMap = new Map(lastVisits.map((v) => [v._id.toString(), v.lastVisit]));

  const now = new Date();
  res.json({
    success: true,
    data: patients.map((p) => {
      const grant = grants.find((g) => g.patientId.toString() === p._id.toString());
      return {
        _id: p._id,
        fullName: p.fullName,
        email: p.email,
        gender: p.gender,
        dateOfBirth: p.dateOfBirth,
        lastVisit: lastVisitMap.get(p._id.toString()) || null,
        consent: grant ? { grantId: grant._id, status: grant.effectiveStatus(now), expiresAt: grant.expiresAt } : null,
      };
    }),
  });
}));

/** GET /api/patients/search?email=: lets a doctor find a patient to request access from. */
router.get('/patients/search', authenticate, requireRole('doctor'),
  validate({ query: Joi.object({ email: Joi.string().email().lowercase().required() }) }),
  asyncHandler(async (req, res) => {
    const patient = await User.findOne({ email: req.query.email, role: 'patient', isActive: true });
    if (!patient) throw notFound('No patient with that email');
    res.json({ success: true, data: { _id: patient._id, fullName: patient.fullName, email: patient.email } });
  }));

module.exports = router;
