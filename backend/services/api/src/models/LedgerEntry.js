const mongoose = require('mongoose');

/**
 * One block of MediChain's hash-chain ledger (decision D2: replaces Hyperledger Fabric).
 *
 * Two independent chains share this collection:
 *   - "records": every create/update of clinical and financial data
 *     (records, files, consents, appointments, prescriptions, claims, bills)
 *   - "access":  every allow/deny access decision made by the zero-trust layer
 *
 * entryHash = SHA-256(canonical JSON of every other field). Each entry stores the
 * previous entry's hash, so editing any entry breaks every link after it.
 * The application never updates or deletes entries: there are no routes for it.
 */
const ledgerEntrySchema = new mongoose.Schema({
  chain: { type: String, enum: ['records', 'access'], required: true },
  seq: { type: Number, required: true }, // position in the chain, starting at 0
  entityType: { type: String, required: true },
  entityId: { type: String, default: null },
  action: { type: String, required: true },
  actorId: { type: String, default: null },
  actorRole: { type: String, default: null },
  payloadHash: { type: String, default: null }, // SHA-256 of the entity's content at this moment
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, required: true },
  previousEntryHash: { type: String, default: null }, // null only for the genesis entry
  entryHash: { type: String, required: true },
}, { versionKey: false });

// The unique (chain, seq) index makes forking impossible: two writers that read
// the same "last entry" both try to insert seq N, and the second one fails.
ledgerEntrySchema.index({ chain: 1, seq: 1 }, { unique: true });
ledgerEntrySchema.index({ chain: 1, entityType: 1, entityId: 1, seq: 1 });
ledgerEntrySchema.index({ chain: 1, actorId: 1, seq: -1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
