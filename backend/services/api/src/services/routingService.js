const AccessGrant = require('../models/AccessGrant');
const Appointment = require('../models/Appointment');
const Bill = require('../models/Bill');
const Claim = require('../models/Claim');
const Prescription = require('../models/Prescription');
const User = require('../models/User');

/**
 * Dynamic routing for returning users.
 *
 * The first login always lands on the role's home page. From the second login on,
 * the landing page is worked out from the user's role, account state and the work
 * waiting for them, so they open straight on what needs attention.
 * Rules are checked in order; the first that matches wins.
 */
const DASHBOARDS = { patient: '/patient.html', doctor: '/doctor.html', admin: '/admin.html', insurance_agent: '/insurance.html' };

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const RULES = {
  patient: [
    { page: 'permissions', reason: 'A doctor is waiting for your consent decision',
      test: (u) => AccessGrant.exists({ patientId: u._id, status: 'requested' }) },
    { page: 'billing', reason: 'You have an unpaid bill',
      test: (u) => Bill.exists({ patientId: u._id, status: 'unpaid' }) },
    { page: 'appointments', reason: 'You have an appointment today',
      test: (u) => Appointment.exists({ patientId: u._id, status: { $in: ['pending', 'confirmed'] },
        startTime: { $gte: startOfToday(), $lt: new Date(startOfToday().getTime() + 86400000) } }) },
  ],
  doctor: [
    { page: 'profile', reason: 'Your account is awaiting verification',
      test: (u) => u.approvalStatus !== 'approved' },
    { page: 'appointments', reason: 'Appointment requests need your confirmation',
      test: (u) => Appointment.exists({ doctorId: u._id, status: 'pending', startTime: { $gte: new Date() } }) },
    { page: 'prescriptions', reason: 'Patients have asked for refills',
      test: (u) => Prescription.exists({ doctorId: u._id, 'refillRequest.status': 'pending' }) },
  ],
  admin: [
    { page: 'verification', reason: 'New doctors or agents are waiting for verification',
      test: () => User.exists({ role: { $in: User.ROLES_NEEDING_APPROVAL }, approvalStatus: 'pending' }) },
  ],
  insurance_agent: [
    { page: 'profile', reason: 'Your account is awaiting verification',
      test: (u) => u.approvalStatus !== 'approved' },
    { page: 'queue', reason: 'Claims are waiting in your queue',
      test: (u) => Claim.exists({ insuranceProvider: u.agentProfile.company, status: { $in: ['submitted', 'under_review'] } }) },
  ],
};

/** Home page for a role: used for the first login. */
function homeFor(user) {
  return { path: `${DASHBOARDS[user.role]}#dashboard`, page: 'dashboard', reason: 'Home' };
}

/** Landing page for a returning user. */
async function resolveLanding(user) {
  for (const rule of RULES[user.role] || []) {
    // eslint-disable-next-line no-await-in-loop
    if (await rule.test(user)) return { path: `${DASHBOARDS[user.role]}#${rule.page}`, page: rule.page, reason: rule.reason };
  }
  return homeFor(user);
}

module.exports = { resolveLanding, homeFor, DASHBOARDS, RULES };
