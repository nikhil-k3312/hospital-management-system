const mongoose = require('mongoose');

/**
 * One attempt to anchor the head of a ledger chain on the blockchain (Problem 10).
 * This collection is only a convenience record (status, transaction, cost for Problem 19):
 * verification never trusts it and reads the latest head from the contract itself.
 */
const ledgerAnchorSchema = new mongoose.Schema({
  chain: { type: String, enum: ['records', 'access'], required: true },
  seq: { type: Number, required: true },
  headHash: { type: String, required: true },
  status: { type: String, enum: ['anchored', 'pending', 'disabled'], required: true },
  txHash: { type: String, default: null },
  blockNumber: { type: Number, default: null },
  gasUsed: { type: Number, default: null },
  latencyMs: { type: Number, default: null },
  trigger: { type: String, enum: ['interval', 'entries', 'manual', 'retry'], default: 'manual' },
  error: { type: String, default: null },
  anchoredAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

ledgerAnchorSchema.index({ chain: 1, seq: -1 });
ledgerAnchorSchema.index({ status: 1, chain: 1 });

module.exports = mongoose.model('LedgerAnchor', ledgerAnchorSchema);
