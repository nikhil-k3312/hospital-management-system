const mongoose = require('mongoose');

const RECORD_TYPES = ['diagnosis', 'lab_result', 'imaging', 'visit_note', 'vaccination', 'allergy', 'patient_upload', 'other'];

const attachmentSchema = new mongoose.Schema({
  fileId: { type: String, required: true }, // GridFS id
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true }, // also written into the ledger
  uploadedBy: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const medicalRecordSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
  recordType: { type: String, enum: RECORD_TYPES, required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  diagnosis: { type: String, default: '' },
  findings: { type: String, default: '' },
  attachments: { type: [attachmentSchema], default: [] },
  version: { type: Number, default: 1 },
  ledgerEntryId: { type: String, default: null }, // latest ledger entry for this record
}, { timestamps: true });

/**
 * The fields whose integrity the ledger protects. Their canonical hash is
 * stored as the ledger entry's payloadHash, so an edit made directly in the
 * database (bypassing the API) no longer matches the ledger.
 */
medicalRecordSchema.methods.ledgerPayload = function ledgerPayload() {
  return {
    patientId: this.patientId.toString(),
    doctorId: this.doctorId ? this.doctorId.toString() : null,
    recordType: this.recordType,
    title: this.title,
    description: this.description,
    diagnosis: this.diagnosis,
    findings: this.findings,
    attachments: this.attachments.map((a) => ({ fileId: a.fileId, sha256: a.sha256 })),
    version: this.version,
  };
};

module.exports = mongoose.model('MedicalRecord', medicalRecordSchema);
module.exports.RECORD_TYPES = RECORD_TYPES;
