const mongoose = require('mongoose');

const prescriptionSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  medication: { type: String, required: true, trim: true },
  dosage: { type: String, required: true, trim: true },
  frequency: { type: String, required: true, trim: true },
  instructions: { type: String, default: '' },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: null },
  refillsAllowed: { type: Number, default: 0, min: 0 },
  refillsUsed: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
  refillRequest: {
    status: { type: String, enum: ['none', 'pending', 'approved', 'denied'], default: 'none' },
    requestedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
  },
  ledgerEntryId: { type: String, default: null },
}, { timestamps: true });

prescriptionSchema.methods.ledgerPayload = function ledgerPayload() {
  return {
    patientId: this.patientId.toString(),
    doctorId: this.doctorId.toString(),
    medication: this.medication,
    dosage: this.dosage,
    frequency: this.frequency,
    instructions: this.instructions,
    refillsAllowed: this.refillsAllowed,
    refillsUsed: this.refillsUsed,
    status: this.status,
  };
};

module.exports = mongoose.model('Prescription', prescriptionSchema);
