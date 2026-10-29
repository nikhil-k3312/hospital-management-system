const mongoose = require('mongoose');

const CLAIM_STATUSES = ['submitted', 'under_review', 'approved', 'denied', 'settled'];

/**
 * Allowed status changes. Anything not listed here is rejected with 409,
 * so a claim can never jump from "submitted" straight to "settled".
 */
const CLAIM_TRANSITIONS = {
  submitted: ['under_review'],
  under_review: ['approved', 'denied'],
  approved: ['settled'],
  denied: [],
  settled: [],
};

const historySchema = new mongoose.Schema({
  status: { type: String, enum: CLAIM_STATUSES, required: true },
  by: { type: String, required: true },
  byRole: { type: String, required: true },
  note: { type: String, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const claimSchema = new mongoose.Schema({
  claimNumber: { type: String, required: true, unique: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', required: true },
  insuranceProvider: { type: String, required: true, index: true },
  policyNumber: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  description: { type: String, default: '' },
  status: { type: String, enum: CLAIM_STATUSES, default: 'submitted' },
  approvedAmount: { type: Number, default: 0 },
  decisionNote: { type: String, default: '' },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  settlementReference: { type: String, default: '' },
  settledAt: { type: Date, default: null },
  history: { type: [historySchema], default: [] },
  ledgerEntryId: { type: String, default: null },
}, { timestamps: true });

claimSchema.methods.ledgerPayload = function ledgerPayload() {
  return {
    claimNumber: this.claimNumber,
    patientId: this.patientId.toString(),
    billId: this.billId.toString(),
    amount: this.amount,
    status: this.status,
    approvedAmount: this.approvedAmount,
    settlementReference: this.settlementReference,
  };
};

module.exports = mongoose.model('Claim', claimSchema);
module.exports.CLAIM_STATUSES = CLAIM_STATUSES;
module.exports.CLAIM_TRANSITIONS = CLAIM_TRANSITIONS;
