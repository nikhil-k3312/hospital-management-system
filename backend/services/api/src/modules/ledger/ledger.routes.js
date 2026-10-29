const express = require('express');
const LedgerEntry = require('../../models/LedgerEntry');
const MedicalRecord = require('../../models/MedicalRecord');
const Prescription = require('../../models/Prescription');
const Claim = require('../../models/Claim');
const Bill = require('../../models/Bill');
const AccessGrant = require('../../models/AccessGrant');
const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, Joi } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

/** Every collection whose documents are protected by the records chain. */
const PROTECTED = [
  { entityType: 'record', model: MedicalRecord, label: 'Medical records', describe: (d) => d.title },
  { entityType: 'prescription', model: Prescription, label: 'Prescriptions', describe: (d) => `${d.medication} ${d.dosage}` },
  { entityType: 'consent', model: AccessGrant, label: 'Consents', describe: (d) => `consent ${d.status}` },
  { entityType: 'appointment', model: Appointment, label: 'Appointments', describe: (d) => d.startTime.toISOString() },
  { entityType: 'claim', model: Claim, label: 'Insurance claims', describe: (d) => d.claimNumber },
  { entityType: 'bill', model: Bill, label: 'Bills', describe: (d) => d.billNumber },
];

/** GET /api/ledger/stats: size and head hash of each chain. */
router.get('/stats', asyncHandler(async (req, res) => {
  const [stats, byAction] = await Promise.all([
    ledgerService.stats(),
    LedgerEntry.aggregate([{ $match: { chain: 'records' } }, { $group: { _id: { entityType: '$entityType', action: '$action' }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
  ]);
  res.json({ success: true, data: { ...stats, byAction } });
}));

/** GET /api/ledger/entries?chain=records&limit=50&beforeSeq=: newest blocks first. */
router.get('/entries', validate({ query: Joi.object({
  chain: Joi.string().valid('records', 'access').default('records'),
  limit: Joi.number().integer().min(1).max(200).default(50),
  beforeSeq: Joi.number().integer().min(0),
  entityType: Joi.string().max(40),
}) }), asyncHandler(async (req, res) => {
  const filter = { chain: req.query.chain };
  if (req.query.beforeSeq !== undefined) filter.seq = { $lt: req.query.beforeSeq };
  if (req.query.entityType) filter.entityType = req.query.entityType;
  const entries = await LedgerEntry.find(filter).sort({ seq: -1 }).limit(req.query.limit).lean();
  const actorIds = [...new Set(entries.map((e) => e.actorId).filter(Boolean))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('fullName role').lean();
  const names = new Map(actors.map((a) => [a._id.toString(), a.fullName]));
  res.json({ success: true, data: entries.map((e) => ({ ...e, actorName: names.get(e.actorId) || null })) });
}));

/**
 * GET /api/ledger/verify: the full integrity audit.
 *   1. walk both chains and recompute every hash and link
 *   2. re-hash every protected document and compare it with the payload
 *      hash the ledger last recorded for it
 * A document edited directly in MongoDB fails step 2. An edited ledger entry
 * fails step 1.
 */
router.get('/verify', asyncHandler(async (req, res) => {
  const started = Date.now();
  const chains = await Promise.all(['records', 'access'].map((c) => ledgerService.verifyChain(c)));

  const entities = [];
  for (const { entityType, model, label, describe } of PROTECTED) {
    const docs = await model.find();
    const results = await Promise.all(docs.map((doc) => ledgerService.verifyEntity(entityType, doc)));
    const tampered = results.map((r, i) => ({ ...r, name: describe(docs[i]) })).filter((r) => !r.matches);
    entities.push({
      entityType,
      label,
      checked: results.length,
      tampered: tampered.map((t) => ({ entityId: t.entityId, name: t.name, reason: t.reason || 'content_changed', ledgerSeq: t.ledgerSeq })),
    });
  }

  const valid = chains.every((c) => c.valid) && entities.every((e) => e.tampered.length === 0);
  res.json({ success: true, data: { valid, chains, entities, checkedAt: new Date(), durationMs: Date.now() - started } });
}));

module.exports = router;
