const mongoose = require('mongoose');

/** A single settings document for the hospital, edited from the admin dashboard. */
const hospitalSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'hospital', unique: true },
  hospitalName: { type: String, default: 'MediChain General Hospital' },
  address: { type: String, default: '' },
  contactEmail: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  maxAdvanceBookingDays: { type: Number, default: 60, min: 1, max: 365 },
  defaultConsentDays: { type: Number, default: 30, min: 1, max: 365 },
  insuranceProviders: { type: [String], default: [] },
  departments: { type: [String], default: [] },
}, { timestamps: true });

hospitalSettingsSchema.statics.getSingleton = async function getSingleton() {
  const existing = await this.findOne({ key: 'hospital' });
  if (existing) return existing;
  try {
    return await this.create({ key: 'hospital' });
  } catch (error) {
    if (error.code === 11000) return this.findOne({ key: 'hospital' }); // created concurrently
    throw error;
  }
};

module.exports = mongoose.model('HospitalSettings', hospitalSettingsSchema);
