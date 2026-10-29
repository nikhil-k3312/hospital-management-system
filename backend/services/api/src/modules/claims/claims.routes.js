const express = require('express');
const crypto = require('crypto');
const Claim = require('../../models/Claim');
const Bill = require('../../models/Bill');
const User = require('../../models/User');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, conflict, badRequest, forbidden } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');
const notificationService = require('../../services/notificationService');
const { makeNumber } = require('../billing/billing.service');

const router = express.Router();
router.use(authenticate);

const { CLAIM_TRANSITIONS } = Claim;

// Agents see billing data only: the bill description and amount, never clinical records.
const populate = (q) => q
  .populate('patientId', 'fullName email')
  .populate('billId', 'billNumber description amount status createdAt')
  .populate('agentId', 'fullName');

/** Agents work the queue of their own insurance company. */
async function agentScope(req) {
  const agent = await User.findById(req.user.userId).select('agentProfile');
  return agent.agentProfile.company ? { insuranceProvider: agent.agentProfile.company } : {};
}

async function chain(claim, action, req, meta) {
  const entry = await ledgerService.recordEvent({ entityType: 'claim', entity: claim, action, actor: req.user, meta });
  claim.ledgerEntryId = entry._id.toString();
  await claim.save();
}

/** POST /api/claims: a patient claims an unpaid bill against their insurance policy. */
router.post('/', requireRole('patient'),
  validate({ body: Joi.object({ billId: objectId().required(), description: Joi.string().trim().max(1000).allow('').default('') }) }),
  asyncHandler(async (req, res) => {
    const patient = await User.findById(req.user.userId);
    const { insuranceProvider, policyNumber } = patient.patientProfile;
    if (!insuranceProvider || !policyNumber) {
      throw badRequest('Add your insurance provider and policy number in Settings before filing a claim');
    }
    const bill = await Bill.findOne({ _id: req.body.billId, patientId: patient._id });
    if (!bill) throw notFound('Bill not found');
    if (bill.status !== 'unpaid') throw conflict(`This bill is ${bill.status.replace('_', ' ')} and cannot be claimed`, 'INVALID_TRANSITION');

    const claim = new Claim({
      claimNumber: makeNumber('CLM'),
      patientId: patient._id,
      billId: bill._id,
      insuranceProvider,
      policyNumber,
      amount: bill.amount,
      description: req.body.description || bill.description,
      history: [{ status: 'submitted', by: req.user.userId, byRole: 'patient', note: 'Claim submitted' }],
    });
    await chain(claim, 'SUBMIT', req);
    bill.status = 'claim_pending';
    await bill.save();
    await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: 'CLAIM_FILED', actor: req.user, meta: { claimId: claim._id.toString() } });

    const agents = await User.find({ role: 'insurance_agent', isActive: true, approvalStatus: 'approved', 'agentProfile.company': insuranceProvider }).distinct('_id');
    await notificationService.notify(agents, {
      type: 'info', title: 'New claim', message: `Claim ${claim.claimNumber} for ₹${claim.amount} is waiting for review.`, page: 'queue',
    });
    res.status(201).json({ success: true, message: `Claim ${claim.claimNumber} submitted`, data: await populate(Claim.findById(claim._id)) });
  }));

/** GET /api/claims?status=: patients see their own; agents see their company's queue; admins see all. */
router.get('/', requireRole('patient', 'insurance_agent', 'admin'),
  validate({ query: Joi.object({ status: Joi.string().valid(...Claim.CLAIM_STATUSES) }) }),
  asyncHandler(async (req, res) => {
    let filter = {};
    if (req.user.role === 'patient') filter.patientId = req.user.userId;
    if (req.user.role === 'insurance_agent') filter = await agentScope(req);
    if (req.query.status) filter.status = req.query.status;
    res.json({ success: true, data: await populate(Claim.find(filter).sort({ createdAt: -1 })) });
  }));

/** GET /api/claims/settlements: settled claims with their references. */
router.get('/settlements', requireRole('insurance_agent', 'admin'), asyncHandler(async (req, res) => {
  const scope = req.user.role === 'insurance_agent' ? await agentScope(req) : {};
  res.json({ success: true, data: await populate(Claim.find({ ...scope, status: 'settled' }).sort({ settledAt: -1 })) });
}));

/** GET /api/claims/reports: financial summary computed live from the claims collection. */
router.get('/reports', requireRole('insurance_agent', 'admin'), asyncHandler(async (req, res) => {
  const scope = req.user.role === 'insurance_agent' ? await agentScope(req) : {};
  const [byStatus, monthly, processing] = await Promise.all([
    Claim.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' }, approved: { $sum: '$approvedAmount' } } }]),
    Claim.aggregate([
      { $match: scope },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, claimed: { $sum: '$amount' }, settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, '$approvedAmount', 0] } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Claim.aggregate([
      { $match: { ...scope, status: 'settled', settledAt: { $ne: null } } },
      { $group: { _id: null, avgHours: { $avg: { $divide: [{ $subtract: ['$settledAt', '$createdAt'] }, 3600000] } } } },
    ]),
  ]);

  const totals = Object.fromEntries(byStatus.map((s) => [s._id, s]));
  const decided = (totals.approved?.count || 0) + (totals.settled?.count || 0) + (totals.denied?.count || 0);
  res.json({
    success: true,
    data: {
      byStatus,
      monthly,
      totalClaims: byStatus.reduce((n, s) => n + s.count, 0),
      totalClaimed: byStatus.reduce((n, s) => n + s.amount, 0),
      totalSettled: totals.settled?.approved || 0,
      approvalRate: decided ? ((totals.approved?.count || 0) + (totals.settled?.count || 0)) / decided : null,
      avgSettlementHours: processing[0]?.avgHours ?? null,
    },
  });
}));

router.get('/:id', requireRole('patient', 'insurance_agent', 'admin'), validate({ params: Joi.object({ id: objectId().required() }) }),
  asyncHandler(async (req, res) => {
    const claim = await populate(Claim.findById(req.params.id));
    if (!claim) throw notFound('Claim not found');
    if (req.user.role === 'patient' && claim.patientId._id.toString() !== req.user.userId) throw notFound('Claim not found');
    if (req.user.role === 'insurance_agent') {
      const scope = await agentScope(req);
      if (scope.insuranceProvider && scope.insuranceProvider !== claim.insuranceProvider) throw notFound('Claim not found');
    }
    res.json({ success: true, data: claim, meta: { history: await ledgerService.history('claim', claim._id) } });
  }));

/**
 * PATCH /api/claims/:id { status, approvedAmount?, note? }: the agent moves a
 * claim through submitted -> under_review -> approved|denied -> settled.
 * Settling marks the bill covered (or partially covered).
 */
router.patch('/:id', requireRole('insurance_agent'),
  validate({
    params: Joi.object({ id: objectId().required() }),
    body: Joi.object({
      status: Joi.string().valid('under_review', 'approved', 'denied', 'settled').required(),
      approvedAmount: Joi.number().min(0),
      note: Joi.string().trim().max(1000).allow('').default(''),
    }),
  }),
  asyncHandler(async (req, res) => {
    const claim = await Claim.findById(req.params.id);
    if (!claim) throw notFound('Claim not found');
    const scope = await agentScope(req);
    if (scope.insuranceProvider && scope.insuranceProvider !== claim.insuranceProvider) throw forbidden('This claim belongs to another insurer');

    const { status, approvedAmount, note } = req.body;
    if (!CLAIM_TRANSITIONS[claim.status].includes(status)) {
      throw conflict(`A claim cannot move from "${claim.status}" to "${status}"`, 'INVALID_TRANSITION');
    }
    if (status === 'approved') {
      if (approvedAmount === undefined) throw badRequest('approvedAmount is required to approve a claim');
      if (approvedAmount > claim.amount) throw badRequest('approvedAmount cannot exceed the claimed amount');
      claim.approvedAmount = approvedAmount;
    }
    if (status === 'denied' && !note) throw badRequest('Give a reason when denying a claim');

    claim.status = status;
    claim.agentId = req.user.userId;
    if (note) claim.decisionNote = note;
    claim.history.push({ status, by: req.user.userId, byRole: 'insurance_agent', note });

    const bill = await Bill.findById(claim.billId);
    if (status === 'settled') {
      claim.settledAt = new Date();
      claim.settlementReference = `STL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      bill.coveredAmount = claim.approvedAmount;
      bill.status = claim.approvedAmount >= bill.amount ? 'covered' : 'partially_covered';
    } else if (status === 'denied') {
      bill.status = 'unpaid'; // the patient pays it themselves
    }
    await chain(claim, status.toUpperCase(), req, note ? { note } : undefined);
    if (bill.isModified()) {
      await bill.save();
      await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: `CLAIM_${status.toUpperCase()}`, actor: req.user });
    }

    const messages = {
      under_review: 'is now under review',
      approved: `was approved for ₹${claim.approvedAmount}`,
      denied: `was denied: ${note}`,
      settled: `was settled (reference ${claim.settlementReference})`,
    };
    await notificationService.notify(claim.patientId, {
      type: status === 'denied' ? 'danger' : (status === 'under_review' ? 'info' : 'success'),
      title: `Claim ${claim.claimNumber}`,
      message: `Your claim ${messages[status]}.`,
      page: 'billing',
    });
    res.json({ success: true, message: `Claim ${status.replace('_', ' ')}`, data: await populate(Claim.findById(claim._id)) });
  }));

module.exports = router;
