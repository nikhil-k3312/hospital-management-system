const express = require('express');
const Bill = require('../../models/Bill');
const { authenticate, requireRole } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound, conflict } = require('../../utils/errors');
const ledgerService = require('../../services/ledgerService');

const router = express.Router();
router.use(authenticate);

/** GET /api/bills: a patient's bills (admins may see all). */
router.get('/', requireRole('patient', 'admin'), asyncHandler(async (req, res) => {
  const filter = req.user.role === 'patient' ? { patientId: req.user.userId } : {};
  const bills = await Bill.find(filter).populate('doctorId', 'fullName').populate('patientId', 'fullName').sort({ createdAt: -1 });
  res.json({ success: true, data: bills });
}));

/**
 * POST /api/bills/:id/pay: records that the patient paid the outstanding
 * balance (at the counter or online). No payment gateway is involved; this
 * endpoint only records the payment and chains it in the ledger.
 */
router.post('/:id/pay', requireRole('patient'), validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const bill = await Bill.findOne({ _id: req.params.id, patientId: req.user.userId });
  if (!bill) throw notFound('Bill not found');
  if (!['unpaid', 'partially_covered'].includes(bill.status)) throw conflict(`This bill is ${bill.status.replace('_', ' ')}`, 'INVALID_TRANSITION');

  const balance = bill.amount - bill.coveredAmount;
  bill.paidAmount = balance;
  bill.paidAt = new Date();
  bill.status = 'paid';
  await bill.save();
  await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: 'PAYMENT_RECORDED', actor: req.user, meta: { amount: balance } });
  res.json({ success: true, message: `Payment of ₹${balance} recorded`, data: bill });
}));

module.exports = router;
