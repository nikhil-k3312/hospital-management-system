const express = require('express');
const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const HospitalSettings = require('../../models/HospitalSettings');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, forbidden, conflict, badRequest } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');
const { isValidSlot } = require('./slots');
const { createBillForAppointment } = require('../billing/billing.service');

const router = express.Router();
router.use(authenticate);

const populate = (query) => query
  .populate('patientId', 'fullName email phone gender dateOfBirth')
  .populate('doctorId', 'fullName doctorProfile.specialization doctorProfile.department');

const fmt = (date) => new Date(date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const recordAppointmentEvent = (appointment, action, req, meta) => ledgerService.recordEvent({
  entityType: 'appointment',
  entity: appointment,
  action,
  actor: req.user,
  meta,
});

/** Throws 404 unless the caller is this appointment's patient, its doctor, or an admin. */
async function loadOwnAppointment(req) {
  const appointment = await Appointment.findById(req.params.id);
  if (!appointment) throw notFound('Appointment not found');
  const { userId, role } = req.user;
  const isParty = appointment.patientId.toString() === userId || appointment.doctorId.toString() === userId;
  if (!isParty && role !== 'admin') throw notFound('Appointment not found');
  return appointment;
}

/**
 * POST /api/appointments: a patient books a slot.
 * The slot must be one the doctor actually offers, and the unique partial
 * index on (doctorId, startTime) rejects a slot that is already taken, even
 * when two patients click "Book" at the same moment.
 */
router.post('/', requireRole('patient'),
  validate({ body: Joi.object({
    doctorId: objectId().required(),
    startTime: Joi.date().iso().greater('now').required(),
    type: Joi.string().valid('consultation', 'follow_up', 'checkup').default('consultation'),
    reason: Joi.string().trim().min(3).max(500).required(),
  }) }),
  asyncHandler(async (req, res) => {
    const { doctorId, startTime, type, reason } = req.body;
    const doctor = await User.findOne({ _id: doctorId, role: 'doctor', approvalStatus: 'approved', isActive: true });
    if (!doctor) throw notFound('Doctor not found');

    const settings = await HospitalSettings.getSingleton();
    const start = new Date(startTime);
    if (!isValidSlot(doctor.doctorProfile.availability, start, settings.maxAdvanceBookingDays)) {
      throw badRequest('That time is not one of the doctor\'s available slots');
    }

    let appointment;
    try {
      appointment = await Appointment.create({
        patientId: req.user.userId,
        doctorId,
        startTime: start,
        endTime: new Date(start.getTime() + doctor.doctorProfile.availability.slotMinutes * 60000),
        type,
        reason,
      });
    } catch (error) {
      if (error.code === 11000) throw conflict('This slot has just been booked. Please choose another time.', 'SLOT_TAKEN');
      throw error;
    }

    await recordAppointmentEvent(appointment, 'CREATE', req);
    await notificationService.notify(doctorId, {
      type: 'info', title: 'New appointment request',
      message: `A patient requested a ${type.replace('_', '-')} on ${fmt(start)}: "${reason}"`, page: 'appointments',
    });

    res.status(201).json({ success: true, message: 'Appointment requested', data: await populate(Appointment.findById(appointment._id)) });
  }));

/** GET /api/appointments?status=&from=&to=: the caller's own appointments (all of them for admins). */
router.get('/',
  validate({ query: Joi.object({
    status: Joi.string().valid(...Appointment.STATUSES),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
    limit: Joi.number().integer().min(1).max(500).default(200),
  }) }),
  asyncHandler(async (req, res) => {
    const { userId, role } = req.user;
    const filter = {};
    if (role === 'patient') filter.patientId = userId;
    else if (role === 'doctor') filter.doctorId = userId;
    else if (role !== 'admin') throw forbidden('Not available for this role');
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from || req.query.to) {
      filter.startTime = {};
      if (req.query.from) filter.startTime.$gte = req.query.from;
      if (req.query.to) filter.startTime.$lte = req.query.to;
    }
    const appointments = await populate(Appointment.find(filter).sort({ startTime: 1 }).limit(req.query.limit));
    res.json({ success: true, data: appointments });
  }));

router.get('/:id', validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const appointment = await loadOwnAppointment(req);
  res.json({ success: true, data: await populate(Appointment.findById(appointment._id)) });
}));

/**
 * PATCH /api/appointments/:id
 *   doctor:  { status: 'confirmed' | 'completed' | 'no_show', notes }
 *   patient: { startTime }  to reschedule (the new slot is checked like a booking)
 * Allowed transitions: pending -> confirmed -> completed | no_show.
 */
const DOCTOR_TRANSITIONS = { pending: ['confirmed'], confirmed: ['completed', 'no_show'] };

router.patch('/:id',
  validate({
    params: Joi.object({ id: objectId().required() }),
    body: Joi.object({
      status: Joi.string().valid('confirmed', 'completed', 'no_show'),
      notes: Joi.string().trim().max(2000).allow(''),
      startTime: Joi.date().iso().greater('now'),
    }).min(1),
  }),
  asyncHandler(async (req, res) => {
    const appointment = await loadOwnAppointment(req);
    const { role } = req.user;

    if (req.body.status) {
      if (role !== 'doctor') throw forbidden('Only the doctor can change the appointment status');
      if (req.sessionState.approvalStatus !== 'approved') throw forbidden('Your account is awaiting administrator verification.', 'APPROVAL_PENDING');
      const allowed = DOCTOR_TRANSITIONS[appointment.status] || [];
      if (!allowed.includes(req.body.status)) {
        throw conflict(`Cannot change an appointment from "${appointment.status}" to "${req.body.status}"`, 'INVALID_TRANSITION');
      }
      if (req.body.status === 'completed' && appointment.startTime > new Date()) {
        throw conflict('An appointment cannot be completed before it starts', 'INVALID_TRANSITION');
      }
      appointment.status = req.body.status;
      if (req.body.notes !== undefined) appointment.notes = req.body.notes;
      await appointment.save();
      await recordAppointmentEvent(appointment, req.body.status.toUpperCase(), req);

      const labels = { confirmed: 'confirmed', completed: 'marked completed', no_show: 'marked as missed' };
      await notificationService.notify(appointment.patientId, {
        type: req.body.status === 'confirmed' ? 'success' : 'info',
        title: `Appointment ${labels[req.body.status]}`,
        message: `Your appointment on ${fmt(appointment.startTime)} was ${labels[req.body.status]}.`,
        page: 'appointments',
      });

      if (req.body.status === 'completed') {
        const doctor = await User.findById(appointment.doctorId);
        await createBillForAppointment(appointment, doctor, req.user);
      }
    } else if (req.body.startTime) {
      if (role !== 'patient') throw forbidden('Only the patient can reschedule');
      if (!['pending', 'confirmed'].includes(appointment.status)) throw conflict('Only upcoming appointments can be rescheduled', 'INVALID_TRANSITION');
      const doctor = await User.findById(appointment.doctorId);
      const settings = await HospitalSettings.getSingleton();
      const start = new Date(req.body.startTime);
      if (!isValidSlot(doctor.doctorProfile.availability, start, settings.maxAdvanceBookingDays)) {
        throw badRequest('That time is not one of the doctor\'s available slots');
      }
      const previous = appointment.startTime;
      appointment.startTime = start;
      appointment.endTime = new Date(start.getTime() + doctor.doctorProfile.availability.slotMinutes * 60000);
      appointment.status = 'pending'; // the doctor confirms the new time again
      try {
        await appointment.save();
      } catch (error) {
        if (error.code === 11000) throw conflict('This slot has just been booked. Please choose another time.', 'SLOT_TAKEN');
        throw error;
      }
      await recordAppointmentEvent(appointment, 'RESCHEDULE', req, { from: previous });
      await notificationService.notify(appointment.doctorId, {
        type: 'warning', title: 'Appointment rescheduled',
        message: `An appointment moved from ${fmt(previous)} to ${fmt(start)} and needs confirmation.`, page: 'appointments',
      });
    } else {
      if (role !== 'doctor') throw forbidden('Only the doctor can add notes');
      appointment.notes = req.body.notes;
      await appointment.save();
    }

    res.json({ success: true, message: 'Appointment updated', data: await populate(Appointment.findById(appointment._id)) });
  }));

/** DELETE /api/appointments/:id: cancel (keeps the record, frees the slot). */
router.delete('/:id',
  validate({ params: Joi.object({ id: objectId().required() }), body: Joi.object({ reason: Joi.string().trim().max(300).allow('') }) }),
  asyncHandler(async (req, res) => {
    const appointment = await loadOwnAppointment(req);
    if (!['pending', 'confirmed'].includes(appointment.status)) {
      throw conflict(`A ${appointment.status} appointment cannot be cancelled`, 'INVALID_TRANSITION');
    }
    appointment.status = 'cancelled';
    appointment.cancelledBy = req.user.role === 'insurance_agent' ? 'admin' : req.user.role;
    appointment.cancelReason = req.body?.reason || '';
    await appointment.save();
    await recordAppointmentEvent(appointment, 'CANCEL', req, { by: req.user.role });

    const other = req.user.role === 'patient' ? appointment.doctorId : appointment.patientId;
    await notificationService.notify(other, {
      type: 'warning', title: 'Appointment cancelled',
      message: `The appointment on ${fmt(appointment.startTime)} was cancelled by the ${req.user.role}.${appointment.cancelReason ? ` Reason: ${appointment.cancelReason}` : ''}`,
      page: 'appointments',
    });
    res.json({ success: true, message: 'Appointment cancelled', data: appointment });
  }));

module.exports = router;
