const mongoose = require('mongoose');

/**
 * A bill is raised automatically when a doctor marks an appointment completed.
 * The patient can record a payment or file an insurance claim against it.
 */
const billSchema = new mongoose.Schema({
  billNumber: { type: String, required: true, unique: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
  description: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ['unpaid', 'paid', 'claim_pending', 'covered', 'partially_covered'],
    default: 'unpaid',
  },
  coveredAmount: { type: Number, default: 0 },
  paidAmount: { type: Number, default: 0 },
  paidAt: { type: Date, default: null },
}, { timestamps: true });

billSchema.methods.ledgerPayload = function ledgerPayload() {
  return {
    billNumber: this.billNumber,
    patientId: this.patientId.toString(),
    amount: this.amount,
    status: this.status,
    coveredAmount: this.coveredAmount,
    paidAmount: this.paidAmount,
  };
};

module.exports = mongoose.model('Bill', billSchema);
