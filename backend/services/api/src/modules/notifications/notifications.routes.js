const express = require('express');
const Notification = require('../../models/Notification');
const { authenticate } = require('../../middleware/auth');
const { validate, objectId, Joi } = require('../../middleware/validate');
const { asyncHandler, notFound } = require('../../utils/errors');

const router = express.Router();
router.use(authenticate);

/** GET /api/notifications?unread=true */
router.get('/', validate({ query: Joi.object({ unread: Joi.boolean(), limit: Joi.number().integer().min(1).max(200).default(50) }) }),
  asyncHandler(async (req, res) => {
    const filter = { userId: req.user.userId };
    if (req.query.unread) filter.read = false;
    const [items, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(req.query.limit).lean(),
      Notification.countDocuments({ userId: req.user.userId, read: false }),
    ]);
    res.json({ success: true, data: items, meta: { unreadCount } });
  }));

router.patch('/:id/read', validate({ params: Joi.object({ id: objectId().required() }) }), asyncHandler(async (req, res) => {
  const updated = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user.userId }, { read: true }, { new: true });
  if (!updated) throw notFound('Notification not found');
  res.json({ success: true, data: updated });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  const result = await Notification.updateMany({ userId: req.user.userId, read: false }, { read: true });
  res.json({ success: true, message: `${result.modifiedCount} marked as read` });
}));

module.exports = router;
