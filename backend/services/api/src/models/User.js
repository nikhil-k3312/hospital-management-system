const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { sha256 } = require('../utils/hash');

const ROLES = ['patient', 'doctor', 'admin', 'insurance_agent'];
// Doctors and insurance agents must be approved by an admin before they can
// touch clinical or financial data. Patients and admins are approved on creation.
const ROLES_NEEDING_APPROVAL = ['doctor', 'insurance_agent'];

const availabilitySchema = new mongoose.Schema({
  days: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0 = Sunday ... 6 = Saturday
  startHour: { type: Number, default: 9, min: 0, max: 23 },
  endHour: { type: Number, default: 17, min: 1, max: 24 },
  slotMinutes: { type: Number, default: 30, min: 10, max: 120 },
}, { _id: false });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  fullName: { type: String, trim: true, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true, default: 'patient' },

  phone: { type: String, trim: true, default: '' },
  dateOfBirth: { type: Date, default: null },
  gender: { type: String, enum: ['female', 'male', 'other', ''], default: '' },
  address: { type: String, trim: true, default: '' },

  // Patient-only details
  patientProfile: {
    bloodType: { type: String, default: '' },
    allergies: { type: [String], default: [] },
    emergencyContact: { type: String, default: '' },
    insuranceProvider: { type: String, default: '' },
    policyNumber: { type: String, default: '' },
  },

  // Doctor-only details
  doctorProfile: {
    specialization: { type: String, default: '' },
    licenseNumber: { type: String, default: '' },
    department: { type: String, default: '' },
    consultationFee: { type: Number, default: 500, min: 0 },
    availability: { type: availabilitySchema, default: () => ({}) },
  },

  // Insurance-agent-only details
  agentProfile: {
    company: { type: String, default: '' },
    employeeId: { type: String, default: '' },
  },

  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  approvalNote: { type: String, default: '' },

  // Identity of this user inside the hash-chain ledger (was `walletAddress`).
  ledgerAddress: { type: String, index: true },

  isVerified: { type: Boolean, default: false }, // proven control of the email (first OTP login)
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date, default: null },
  failedLoginAttempts: { type: Number, default: 0 },
  accountLockedUntil: { type: Date, default: null },
  refreshTokens: {
    type: [String],
    default: [],
    validate: { validator: (tokens) => tokens.length <= 5, message: 'A user can have at most 5 refresh tokens' },
  },
}, { timestamps: true });

userSchema.index({ role: 1, approvalStatus: 1 });

userSchema.pre('save', async function hashPasswordAndAssignLedgerAddress(next) {
  try {
    if (!this.ledgerAddress) {
      this.ledgerAddress = `mc_${sha256(this._id.toString()).slice(0, 40)}`;
    }
    if (this.isModified('passwordHash')) {
      const salt = await bcrypt.genSalt(10);
      this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    }
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.methods.isAccountLocked = function isAccountLocked() {
  return Boolean(this.accountLockedUntil && this.accountLockedUntil > Date.now());
};

userSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.failedLoginAttempts;
  delete obj.accountLockedUntil;
  delete obj.refreshTokens;
  delete obj.__v;
  // Hide the other roles' (empty) profile sections. When a partial populate did
  // not select `role`, keep whatever profile fields were explicitly selected.
  if (obj.role) {
    if (obj.role !== 'patient') delete obj.patientProfile;
    if (obj.role !== 'doctor') delete obj.doctorProfile;
    if (obj.role !== 'insurance_agent') delete obj.agentProfile;
  }
  return obj;
};

/** Minimal public view used when one user is shown to another (e.g. a doctor in a booking list). */
userSchema.methods.toPublic = function toPublic() {
  const base = { _id: this._id, fullName: this.fullName, role: this.role };
  if (this.role === 'doctor') {
    base.doctorProfile = {
      specialization: this.doctorProfile.specialization,
      department: this.doctorProfile.department,
      consultationFee: this.doctorProfile.consultationFee,
    };
  }
  return base;
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.ROLES_NEEDING_APPROVAL = ROLES_NEEDING_APPROVAL;
