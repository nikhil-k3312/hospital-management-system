const crypto = require('crypto');
const Bill = require('../../models/Bill');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');

/** Human-readable unique number, e.g. "B-20261027-3FA9C1". */
function makeNumber(prefix) {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${prefix}-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Raises the consultation bill when a doctor completes an appointment. */
async function createBillForAppointment(appointment, doctor, actor) {
  const bill = await Bill.create({
    billNumber: makeNumber('B'),
    patientId: appointment.patientId,
    doctorId: appointment.doctorId,
    appointmentId: appointment._id,
    description: `Consultation with Dr. ${doctor.fullName} (${doctor.doctorProfile.specialization || 'General'})`,
    amount: doctor.doctorProfile.consultationFee,
  });
  await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: 'CREATE', actor });
  await notificationService.notify(appointment.patientId, {
    type: 'info',
    title: 'New bill',
    message: `A bill of ₹${bill.amount} was raised for your consultation (${bill.billNumber}). You can pay it or file an insurance claim.`,
    page: 'billing',
  });
  return bill;
}

module.exports = { createBillForAppointment, makeNumber };
