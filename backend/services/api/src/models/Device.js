const mongoose = require('mongoose');

/**
 * A registered IoT medical device assigned to one patient. The device
 * authenticates with an API key; only the key's SHA-256 is stored, and the
 * plain key is shown to the admin once at registration.
 */
const deviceSchema = new mongoose.Schema({
  serialNumber: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['heart_monitor', 'bp_monitor', 'pulse_oximeter', 'thermometer', 'multi_parameter'], required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  apiKeyHash: { type: String, required: true, unique: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  lastSeenAt: { type: Date, default: null },
  registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

deviceSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.apiKeyHash;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Device', deviceSchema);
