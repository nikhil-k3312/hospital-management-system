const mongoose = require('mongoose');

const RECORD_TYPES = ['diagnosis', 'lab_result', 'imaging', 'visit_note', 'vaccination', 'allergy', 'patient_upload', 'other'];

// Where a hash was anchored on the blockchain (HealthRecordRegistry).
const chainAnchorSchema = new mongoose.Schema({
  status: { type: String, enum: ['anchored', 'pending', 'disabled'], default: 'disabled' },
  key: { type: String, default: null },
  txHash: { type: String, default: null },
  blockNumber: { type: Number, default: null },
  version: { type: Number, default: null },
}, { _id: false });

const attachmentSchema = new mongoose.Schema({
  fileId: { type: String, required: true }, // our id for the file (GridFS id for legacy files)
  storage: { type: String, enum: ['ipfs', 'gridfs'], default: 'gridfs' },
  cid: { type: String, default: null }, // IPFS content id of the ENCRYPTED bytes
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true }, // hash of the original bytes: ledger + blockchain
  uploadedBy: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  chain: { type: chainAnchorSchema, default: () => ({}) },
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
  chain: { type: chainAnchorSchema, default: () => ({}) }, // anchor of the latest version
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
