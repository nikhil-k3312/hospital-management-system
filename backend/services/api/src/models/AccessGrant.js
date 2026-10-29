const mongoose = require('mongoose');

/**
 * Patient consent: allows one doctor to read and write one patient's medical
 * data until `expiresAt`. A doctor can *request* access; only the patient can
 * approve, deny or revoke it. A patient can also grant access proactively.
 */
const accessGrantSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['requested', 'active', 'denied', 'revoked'], default: 'requested' },
  purpose: { type: String, trim: true, default: '' },
  requestedBy: { type: String, enum: ['doctor', 'patient'], required: true },
  grantedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  ledgerEntryId: { type: String, default: null },
}, { timestamps: true });

accessGrantSchema.index({ patientId: 1, doctorId: 1, status: 1 });

accessGrantSchema.methods.isCurrentlyActive = function isCurrentlyActive(now = new Date()) {
  return this.status === 'active' && this.expiresAt && this.expiresAt > now;
};

/** The status the user sees: an active grant past its expiry shows as "expired". */
accessGrantSchema.methods.effectiveStatus = function effectiveStatus(now = new Date()) {
  if (this.status === 'active' && (!this.expiresAt || this.expiresAt <= now)) return 'expired';
  return this.status;
};

accessGrantSchema.methods.ledgerPayload = function ledgerPayload() {
  return {
    patientId: this.patientId.toString(),
    doctorId: this.doctorId.toString(),
    status: this.status,
    expiresAt: this.expiresAt,
    purpose: this.purpose,
  };
};

module.exports = mongoose.model('AccessGrant', accessGrantSchema);
