const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const redisClient = require('../src/db/redis');
const { connectRedis, disconnectRedis } = require('../src/db/redis');
const emailService = require('../src/services/emailService');
const User = require('../src/models/User');
const HospitalSettings = require('../src/models/HospitalSettings');

const PASSWORD = 'Str0ng!Pass';

async function setupDatabase() {
  await connectMongo();
  await connectRedis();
}

async function resetDatabase() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  // Indexes must exist for the uniqueness guarantees (double-booking, ledger seq).
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await redisClient.flushDb();
  await HospitalSettings.create({ key: 'hospital', insuranceProviders: ['Star Health', 'HDFC Ergo'], departments: ['Cardiology'] });
}

async function teardownDatabase() {
  await disconnectMongo();
  await disconnectRedis();
}

let counter = 0;

/** Creates a user directly in the database (approved unless told otherwise). */
async function createUser(role, overrides = {}) {
  counter += 1;
  const user = new User({
    email: `${role}${counter}@example.com`,
    fullName: `${role} ${counter}`,
    passwordHash: PASSWORD,
    role,
    approvalStatus: 'approved',
    ...overrides,
  });
  if (role === 'doctor') {
    Object.assign(user.doctorProfile, {
      specialization: 'Cardiology', licenseNumber: `LIC-${counter}`, consultationFee: 800,
      availability: { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, slotMinutes: 30 },
    });
  }
  if (role === 'patient' && !overrides.patientProfile) {
    user.patientProfile = { insuranceProvider: 'Star Health', policyNumber: `POL-${counter}`, bloodType: 'O+' };
  }
  if (role === 'insurance_agent' && !overrides.agentProfile) user.agentProfile = { company: 'Star Health' };
  await user.save();
  return user;
}

/**
 * Logs in through the real two-step flow. The OTP is captured from the
 * email service (the json transport sends nothing anywhere).
 * Returns { token, cookie, user, agent }.
 */
async function login(user, password = PASSWORD) {
  let otp;
  const spy = jest.spyOn(emailService, 'sendOTP').mockImplementation(async (email, code) => { otp = code; });
  const step1 = await request(app).post('/api/auth/login/request-otp').set('User-Agent', 'jest').send({ email: user.email, password });
  spy.mockRestore();
  if (step1.status !== 200) throw new Error(`request-otp failed: ${step1.status} ${JSON.stringify(step1.body)}`);

  const step2 = await request(app).post('/api/auth/login/verify-otp').set('User-Agent', 'jest').send({ email: user.email, otp });
  if (step2.status !== 200) throw new Error(`verify-otp failed: ${step2.status} ${JSON.stringify(step2.body)}`);
  const cookie = step2.headers['set-cookie'].find((c) => c.startsWith('refreshToken='));
  return { token: step2.body.data.token, cookie, user: step2.body.data.user };
}

/** Supertest request with the Bearer token and a User-Agent already set. */
function as(session) {
  const wrap = (method) => (url) => request(app)[method](url).set('Authorization', `Bearer ${session.token}`).set('User-Agent', 'jest');
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
}

/** Next whole half-hour at least `hoursAhead` from now (a valid slot for test doctors). */
function futureSlot(hoursAhead = 24) {
  const d = new Date(Date.now() + hoursAhead * 3600000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

module.exports = { app, request, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, futureSlot, PASSWORD };
