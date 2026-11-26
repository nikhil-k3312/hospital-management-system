const mongoose = require('mongoose');

/**
 * One emergency sign-in waiting for (or after) review (decision D12, guide 26 Nov 2026).
 *
 * The reason text stays here and in the ledger; the blockchain holds only hashes. The verdict is
 * NOT stored here: it is read from the EmergencyReview contract, where only k of n administrators
 * can close a case. This collection only links a case to the user and the ledger entry, and tracks
 * whether the server managed to open it on-chain (pending cases are retried by anchor-pending.js).
 */
const emergencyCaseSchema = new mongoose.Schema({
  caseId: { type: String, required: true, unique: true },   // 0x + hash of the ledger entry of the sign-in
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, required: true },
  reason: { type: String, required: true },
  reasonHash: { type: String, required: true },             // 0x + sha-256 of the reason (what the chain holds)
  subject: { type: String, required: true },                // salted user hash, as in the RoleRegistry
  ledgerSeq: { type: Number, default: null },
  trustScore: { type: Number, default: null },
  openedAt: { type: Date, required: true },
  chainStatus: { type: String, enum: ['recorded', 'pending', 'disabled'], required: true },
  txHash: { type: String, default: null },
  error: { type: String, default: null },
}, { timestamps: true, versionKey: false });

emergencyCaseSchema.index({ openedAt: -1 });
emergencyCaseSchema.index({ chainStatus: 1 });

module.exports = mongoose.model('EmergencyCase', emergencyCaseSchema);
