const express = require('express');
const controller = require('./auth.controller');
const { validate, password, Joi } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();

const email = Joi.string().email().lowercase().trim().max(254).required();

const registerSchema = Joi.object({
  email,
  password: password().required(),
  fullName: Joi.string().trim().min(2).max(100).required(),
  // Admin accounts cannot be self-registered: they are created by another admin.
  role: Joi.string().valid('patient', 'doctor', 'insurance_agent').default('patient'),
  phone: Joi.string().trim().max(30).allow('').default(''),
  dateOfBirth: Joi.date().iso().max('now').allow(null, ''),
  gender: Joi.string().valid('female', 'male', 'other', '').default(''),
  address: Joi.string().trim().max(300).allow('').default(''),
  // patient
  bloodType: Joi.string().valid('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', '').default(''),
  emergencyContact: Joi.string().trim().max(150).allow('').default(''),
  insuranceProvider: Joi.string().trim().max(100).allow('').default(''),
  policyNumber: Joi.string().trim().max(60).allow('').default(''),
  // doctor
  specialization: Joi.when('role', { is: 'doctor', then: Joi.string().trim().max(100).required(), otherwise: Joi.forbidden() }),
  licenseNumber: Joi.when('role', { is: 'doctor', then: Joi.string().trim().max(60).required(), otherwise: Joi.forbidden() }),
  department: Joi.string().trim().max(100).allow(''),
  // insurance agent
  company: Joi.when('role', { is: 'insurance_agent', then: Joi.string().trim().max(100).required(), otherwise: Joi.forbidden() }),
  employeeId: Joi.string().trim().max(60).allow(''),
});

router.post('/register', validate({ body: registerSchema }), asyncHandler(controller.register));

router.post('/login/request-otp',
  validate({ body: Joi.object({ email, password: Joi.string().max(128).required() }) }),
  asyncHandler(controller.requestOtp));

router.post('/login/verify-otp',
  validate({ body: Joi.object({ email, otp: Joi.string().pattern(/^\d{4,8}$/).required().messages({ 'string.pattern.base': 'OTP must be digits only' }) }) }),
  asyncHandler(controller.verifyOtp));

router.post('/refresh-token', asyncHandler(controller.refreshToken));
router.post('/logout', authenticate, asyncHandler(controller.logout));
router.post('/change-password', authenticate,
  validate({ body: Joi.object({ currentPassword: Joi.string().max(128).required(), newPassword: password().required() }) }),
  asyncHandler(controller.changePassword));

module.exports = router;
