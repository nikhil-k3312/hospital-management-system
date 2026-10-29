const Notification = require('../models/Notification');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Creates in-app notifications. Failures are logged and swallowed: a missed
 * notification must never roll back the clinical or financial action that
 * caused it.
 */
async function notify(userIds, { type = 'info', title, message, page = '' }) {
  const ids = [].concat(userIds).filter(Boolean).map(String);
  if (!ids.length) return [];
  try {
    return await Notification.insertMany(ids.map((userId) => ({ userId, type, title, message, page })));
  } catch (error) {
    logger.error(`Notification failed: ${error.message}`);
    return [];
  }
}

async function notifyRole(role, payload) {
  const users = await User.find({ role, isActive: true }).select('_id').lean();
  return notify(users.map((u) => u._id), payload);
}

module.exports = { notify, notifyRole };
