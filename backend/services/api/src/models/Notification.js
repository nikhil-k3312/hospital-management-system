const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['info', 'success', 'warning', 'danger'], default: 'info' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  page: { type: String, default: '' }, // dashboard page the notification links to
  read: { type: Boolean, default: false },
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
