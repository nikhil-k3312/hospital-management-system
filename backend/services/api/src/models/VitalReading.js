const mongoose = require('mongoose');

/** Normal ranges used to flag readings. Outside them, alerts are raised. */
const VITAL_RANGES = {
  heartRate: { min: 50, max: 110, unit: 'bpm', label: 'Heart rate' },
  systolic: { min: 90, max: 140, unit: 'mmHg', label: 'Systolic BP' },
  diastolic: { min: 60, max: 90, unit: 'mmHg', label: 'Diastolic BP' },
  spo2: { min: 94, max: 100, unit: '%', label: 'Blood oxygen' },
  temperature: { min: 36.1, max: 37.8, unit: '°C', label: 'Temperature' },
  glucose: { min: 70, max: 180, unit: 'mg/dL', label: 'Blood glucose' },
};

const vitalReadingSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
  source: { type: String, enum: ['device', 'manual'], required: true },
  heartRate: { type: Number, default: null },
  systolic: { type: Number, default: null },
  diastolic: { type: Number, default: null },
  spo2: { type: Number, default: null },
  temperature: { type: Number, default: null },
  glucose: { type: Number, default: null },
  abnormal: { type: [String], default: [] }, // names of out-of-range fields
  recordedAt: { type: Date, default: Date.now },
}, { versionKey: false });

vitalReadingSchema.index({ patientId: 1, recordedAt: -1 });

/** Returns the names of the fields in `reading` that fall outside VITAL_RANGES. */
function findAbnormal(reading) {
  return Object.entries(VITAL_RANGES)
    .filter(([field, range]) => reading[field] !== null && reading[field] !== undefined
      && (reading[field] < range.min || reading[field] > range.max))
    .map(([field]) => field);
}

module.exports = mongoose.model('VitalReading', vitalReadingSchema);
module.exports.VITAL_RANGES = VITAL_RANGES;
module.exports.findAbnormal = findAbnormal;
