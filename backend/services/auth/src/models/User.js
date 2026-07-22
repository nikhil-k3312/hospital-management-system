const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  
  passwordHash: {
    type: String,
    required: true,
    minlength: 8,
  },
  
  role: {
    type: String,
    enum: ['patient', 'doctor', 'admin', 'insurance'],
    required: true,
    default: 'patient'
  },
  
  walletAddress: {
    type: String,
    default: null,
  },
  
  isVerified: {
    type: Boolean,
    default: false,
  },
  
  isActive: {
    type: Boolean,
    default: true,
  },
  
  lastLogin: {
    type: Date,
    default: null,
  },
  
  failedLoginAttempts: {
    type: Number,
    default: 0,
  },
  
  accountLockedUntil: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.passwordHash);
};

// Method to check if account is locked
userSchema.methods.isAccountLocked = function() {
  return this.accountLockedUntil && this.accountLockedUntil > Date.now();
};

// Don't return sensitive data
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.failedLoginAttempts;
  delete obj.accountLockedUntil;
  return obj;
};

module.exports = mongoose.model('User', userSchema);