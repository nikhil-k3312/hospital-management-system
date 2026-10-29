const mongoose = require('mongoose');

const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const ACTIVE_STATUSES = ['pending', 'confirmed', 'completed'];

const appointmentSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  type: { type: String, enum: ['consultation', 'follow_up', 'checkup', 'emergency'], default: 'consultation' },
  reason: { type: String, trim: true, default: '' },
  status: { type: String, enum: STATUSES, default: 'pending' },
  notes: { type: String, default: '' }, // doctor's visit notes on completion
  cancelledBy: { type: String, enum: ['patient', 'doctor', 'admin', null], default: null },
  cancelReason: { type: String, default: '' },
  // True while the appointment occupies its slot. Cancelling sets it to false,
  // which frees the slot for someone else.
  holdsSlot: { type: Boolean, default: true },
}, { timestamps: true });

// Double-booking prevention at the database level: among appointments that
// hold their slot, a doctor can have only one per start time. Even two
// requests racing each other cannot both succeed.
appointmentSchema.index(
  { doctorId: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { holdsSlot: true } }
);

appointmentSchema.pre('validate', function syncHoldsSlot(next) {
  this.holdsSlot = ACTIVE_STATUSES.includes(this.status);
  next();
});

appointmentSchema.methods.ledgerPayload = function ledgerPayload() {
  return {
    patientId: String(this.patientId._id || this.patientId),
    doctorId: String(this.doctorId._id || this.doctorId),
    startTime: this.startTime,
    status: this.status,
  };
};

module.exports = mongoose.model('Appointment', appointmentSchema);
module.exports.STATUSES = STATUSES;
