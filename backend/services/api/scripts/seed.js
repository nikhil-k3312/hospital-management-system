/**
 * Demo seed: fills the database with a small, realistic hospital so every
 * screen of every dashboard has something to show.
 *
 *   npm run seed            refuses to run if users already exist
 *   npm run seed -- --reset wipes the MediChain database first
 *
 * Demo data is inserted straight into MongoDB (this is a seed script, not
 * application code), but every protected document is also written to the
 * ledger through ledgerService, exactly as the API would, so
 * "Verify ledger" reports a clean, valid chain afterwards.
 *
 * Accounts are plus-addresses of SEED_EMAIL_BASE (you+patient@gmail.com ...),
 * so all OTP emails arrive in one inbox. The password is SEED_DEMO_PASSWORD.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const mongoose = require('mongoose');
const config = require('../src/config/config');
const { connectMongo, disconnectMongo, getBucket } = require('../src/db/mongo');
const ledgerService = require('../src/services/ledgerService');
const User = require('../src/models/User');
const Appointment = require('../src/models/Appointment');
const AccessGrant = require('../src/models/AccessGrant');
const MedicalRecord = require('../src/models/MedicalRecord');
const Prescription = require('../src/models/Prescription');
const Bill = require('../src/models/Bill');
const Claim = require('../src/models/Claim');
const Device = require('../src/models/Device');
const VitalReading = require('../src/models/VitalReading');
const Notification = require('../src/models/Notification');
const HospitalSettings = require('../src/models/HospitalSettings');
const { makeNumber } = require('../src/modules/billing/billing.service');

const DEVICES_FILE = path.join(__dirname, '.demo-devices.json');
const DAY = 86400000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith('<')) {
    console.error(`Set ${name} in backend/services/api/.env before seeding (see .env.example).`);
    process.exit(1);
  }
  return value;
}

const base = requireEnv('SEED_EMAIL_BASE');
const demoPassword = requireEnv('SEED_DEMO_PASSWORD');
if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()\-_=+]).{8,}$/.test(demoPassword)) {
  console.error('SEED_DEMO_PASSWORD must have 8+ characters with upper case, lower case, a digit and a symbol.');
  process.exit(1);
}
const [local, domain] = base.split('@');
const email = (tag) => `${local}+${tag}@${domain}`;

/** A weekday date `offset` days from today at hh:mm, local time. */
function at(offsetDays, hours, minutes = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + (offsetDays >= 0 ? 1 : -1));
  d.setHours(hours, minutes, 0, 0);
  return d;
}

const system = { userId: null, role: 'system' };
const actorOf = (user) => ({ userId: user._id.toString(), role: user.role });

async function chainEvent(entityType, entity, action, actor = system, meta) {
  const entry = await ledgerService.recordEvent({ entityType, entity, action, actor, meta });
  if ('ledgerEntryId' in entity) {
    entity.ledgerEntryId = entry._id.toString();
    await entity.save();
  }
  return entry;
}

async function createUser(fields, profile = {}) {
  const user = new User({ passwordHash: demoPassword, isVerified: true, approvalStatus: 'approved', ...fields });
  Object.entries(profile).forEach(([key, value]) => Object.assign(user[key], value));
  await user.save();
  await ledgerService.append({
    chain: 'records', entityType: 'user', entityId: user._id, action: 'REGISTER', actorId: user._id, actorRole: user.role,
    payload: { email: user.email, role: user.role, ledgerAddress: user.ledgerAddress },
  });
  return user;
}

async function storeFile(record, filename, text, uploader) {
  const buffer = Buffer.from(text, 'utf8');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const fileId = await new Promise((resolve, reject) => {
    const stream = getBucket().openUploadStream(filename, { metadata: { recordId: record._id.toString(), sha256, contentType: 'text/plain' } });
    Readable.from(buffer).pipe(stream).on('error', reject).on('finish', () => resolve(stream.id.toString()));
  });
  record.attachments.push({ fileId, filename, contentType: 'text/plain', size: buffer.length, sha256, uploadedBy: uploader._id.toString() });
  await ledgerService.append({
    chain: 'records', entityType: 'file', entityId: fileId, action: 'FILE_ATTACHED', actorId: uploader._id, actorRole: uploader.role,
    payloadHash: sha256, meta: { recordId: record._id.toString(), filename, size: buffer.length },
  });
  record.version += 1;
  await chainEvent('record', record, 'UPDATE', actorOf(uploader), { attached: fileId });
}

async function main() {
  await connectMongo();
  const reset = process.argv.includes('--reset');

  if (await User.estimatedDocumentCount() > 0 && !reset) {
    console.error('The database already has users. Run "npm run seed -- --reset" to wipe it and seed again.');
    process.exit(1);
  }
  console.log(`Starting from an empty database "${mongoose.connection.name}"...`);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  console.log('Creating hospital settings...');
  await HospitalSettings.create({
    key: 'hospital',
    hospitalName: 'MediChain General Hospital',
    address: '14 Residency Road, Bengaluru 560025',
    contactEmail: base,
    contactPhone: '+91 80 4000 1234',
    insuranceProviders: ['Star Health', 'HDFC Ergo', 'Niva Bupa', 'ICICI Lombard'],
    departments: ['Cardiology', 'General Medicine', 'Endocrinology', 'Dermatology', 'Orthopaedics'],
  });

  console.log('Creating users...');
  const admin = await createUser({ email: email('admin'), fullName: 'Shashank Admin', role: 'admin', phone: '+91 98450 00001' });
  const iyer = await createUser(
    { email: email('doctor'), fullName: 'Ananya Iyer', role: 'doctor', gender: 'female', phone: '+91 98450 10001' },
    { doctorProfile: { specialization: 'Cardiology', department: 'Cardiology', licenseNumber: 'KMC-48213', consultationFee: 900, availability: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, slotMinutes: 30 } } }
  );
  const menon = await createUser(
    { email: email('doctor2'), fullName: 'Rahul Menon', role: 'doctor', gender: 'male', phone: '+91 98450 10002' },
    { doctorProfile: { specialization: 'Endocrinology', department: 'Endocrinology', licenseNumber: 'KMC-51877', consultationFee: 700, availability: { days: [1, 2, 3, 4, 5, 6], startHour: 10, endHour: 18, slotMinutes: 30 } } }
  );
  const reddy = await createUser(
    { email: email('doctor3'), fullName: 'Kavya Reddy', role: 'doctor', gender: 'female', approvalStatus: 'pending', isVerified: false },
    { doctorProfile: { specialization: 'Dermatology', department: 'Dermatology', licenseNumber: 'KMC-60342', consultationFee: 600 } }
  );
  const agent = await createUser(
    { email: email('agent'), fullName: 'Priya Sharma', role: 'insurance_agent', phone: '+91 98450 20001' },
    { agentProfile: { company: 'Star Health', employeeId: 'SH-AG-1042' } }
  );
  const arjun = await createUser(
    { email: email('patient'), fullName: 'Arjun Mehta', role: 'patient', gender: 'male', dateOfBirth: new Date(1979, 4, 14), phone: '+91 98450 30001', address: '22 Indiranagar, Bengaluru' },
    { patientProfile: { bloodType: 'B+', allergies: ['Penicillin'], emergencyContact: 'Nisha Mehta (+91 98450 30002)', insuranceProvider: 'Star Health', policyNumber: 'SH-2025-778812' } }
  );
  const meera = await createUser(
    { email: email('patient2'), fullName: 'Meera Nair', role: 'patient', gender: 'female', dateOfBirth: new Date(1968, 10, 2), phone: '+91 98450 30011', address: '7 Jayanagar 4th Block, Bengaluru' },
    { patientProfile: { bloodType: 'O+', allergies: [], emergencyContact: 'Vikram Nair (+91 98450 30012)', insuranceProvider: 'Star Health', policyNumber: 'SH-2024-551903' } }
  );
  const rohan = await createUser(
    { email: email('patient3'), fullName: 'Rohan Gupta', role: 'patient', gender: 'male', dateOfBirth: new Date(1995, 1, 21), phone: '+91 98450 30021' },
    { patientProfile: { bloodType: 'A-', allergies: ['Sulfa drugs'], emergencyContact: 'Anita Gupta (+91 98450 30022)', insuranceProvider: 'HDFC Ergo', policyNumber: 'HE-2026-100245' } }
  );

  console.log('Creating consents...');
  const consent = async (patient, doctor, status, purpose, daysValid = 30) => {
    const grant = new AccessGrant({
      patientId: patient._id, doctorId: doctor._id, status, purpose, requestedBy: status === 'requested' ? 'doctor' : 'patient',
      grantedAt: status === 'active' ? new Date() : null, expiresAt: status === 'active' ? new Date(Date.now() + daysValid * DAY) : null,
    });
    await chainEvent('consent', grant, status === 'active' ? 'GRANT_ACCESS' : 'REQUEST_ACCESS', actorOf(status === 'active' ? patient : doctor));
    return grant;
  };
  await consent(arjun, iyer, 'active', 'Ongoing hypertension management');
  await consent(meera, iyer, 'active', 'Cardiac risk assessment');
  await consent(meera, menon, 'active', 'Diabetes care', 60);
  await consent(arjun, menon, 'requested', 'Second opinion on fasting glucose');

  console.log('Creating appointments and bills...');
  const appointment = async (patient, doctor, start, status, reason, type = 'consultation', notes = '') => {
    const appt = new Appointment({
      patientId: patient._id, doctorId: doctor._id, startTime: start,
      endTime: new Date(start.getTime() + doctor.doctorProfile.availability.slotMinutes * 60000), status, reason, type, notes,
    });
    await appt.save();
    await ledgerService.recordEvent({ entityType: 'appointment', entity: appt, action: status === 'pending' ? 'CREATE' : status.toUpperCase(), actor: actorOf(status === 'pending' ? patient : doctor) });
    let bill = null;
    if (status === 'completed') {
      bill = new Bill({
        billNumber: makeNumber('B'), patientId: patient._id, doctorId: doctor._id, appointmentId: appt._id,
        description: `Consultation with Dr. ${doctor.fullName} (${doctor.doctorProfile.specialization})`, amount: doctor.doctorProfile.consultationFee,
        createdAt: start,
      });
      await bill.save();
      await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: 'CREATE', actor: actorOf(doctor) });
    }
    return { appt, bill };
  };

  const a1 = await appointment(arjun, iyer, at(-21, 10), 'completed', 'Recurring headaches and high home BP readings', 'consultation', 'BP 152/96. Started amlodipine 5 mg. Lipid panel ordered.');
  const a2 = await appointment(arjun, iyer, at(-7, 11), 'completed', 'Review lipid report', 'follow_up', 'LDL elevated. Added atorvastatin 10 mg. Lifestyle advice given.');
  const m1 = await appointment(meera, menon, at(-14, 12), 'completed', 'High fasting glucose', 'consultation', 'HbA1c 7.4%. Started metformin 500 mg twice daily.');
  const m2 = await appointment(meera, iyer, at(-4, 15), 'completed', 'Palpitations', 'consultation', 'ECG normal sinus rhythm. Holter not required.');
  await appointment(arjun, iyer, at(-2, 9, 30), 'cancelled', 'Routine check');
  await appointment(rohan, menon, at(-1, 16), 'no_show', 'Thyroid follow-up', 'follow_up');
  // Today, relative to the moment the seed runs: one visit that has already
  // started (the doctor can complete it live, which raises a bill) and one later today.
  const todayPast = new Date(); todayPast.setMinutes(todayPast.getMinutes() < 30 ? 0 : 30, 0, 0); todayPast.setHours(todayPast.getHours() - 1);
  const todayLater = new Date(todayPast.getTime() + 3 * 3600000);
  await appointment(rohan, iyer, todayPast, 'confirmed', 'Chest tightness while running', 'consultation');
  await appointment(meera, iyer, todayLater, 'pending', 'Discuss exercise tolerance', 'follow_up');
  // Upcoming
  await appointment(arjun, iyer, at(1, 10), 'confirmed', 'Three-month BP review', 'follow_up');
  await appointment(rohan, iyer, at(2, 14), 'pending', 'Follow-up after stress test', 'follow_up');
  await appointment(meera, menon, at(3, 12), 'confirmed', 'Diabetes follow-up', 'follow_up');
  await appointment(rohan, menon, at(5, 10, 30), 'pending', 'Annual check-up', 'checkup');

  console.log('Creating medical records and attachments...');
  const record = async (patient, doctor, fields, createdAt) => {
    const rec = new MedicalRecord({ patientId: patient._id, doctorId: doctor ? doctor._id : null, ...fields, createdAt });
    await rec.save();
    await chainEvent('record', rec, 'CREATE', actorOf(doctor || patient));
    return rec;
  };
  const r1 = await record(arjun, iyer, {
    recordType: 'diagnosis', title: 'Stage 1 essential hypertension', diagnosis: 'I10 - Essential (primary) hypertension',
    description: 'Office BP 152/96 and 148/94 on separate visits; home readings consistently above 140/90.',
    findings: 'No end-organ damage on examination. Fundoscopy normal.', appointmentId: a1.appt._id,
  }, at(-21, 10, 30));
  const r2 = await record(arjun, iyer, {
    recordType: 'lab_result', title: 'Fasting lipid profile', diagnosis: 'E78.0 - Pure hypercholesterolaemia',
    description: 'Total cholesterol 236 mg/dL, LDL 162 mg/dL, HDL 41 mg/dL, triglycerides 168 mg/dL.', appointmentId: a2.appt._id,
  }, at(-8, 9));
  await storeFile(r2, 'lipid-profile-report.txt', [
    'MEDICHAIN GENERAL HOSPITAL - CLINICAL LABORATORY',
    `Patient: Arjun Mehta    Sample: fasting serum    Date: ${at(-8, 8).toDateString()}`,
    '', 'Total cholesterol   236 mg/dL   (< 200)', 'LDL cholesterol     162 mg/dL   (< 100)',
    'HDL cholesterol      41 mg/dL   (> 40)', 'Triglycerides       168 mg/dL   (< 150)',
    '', 'Interpretation: elevated LDL. Clinical correlation advised.', 'Verified by: Lab Officer K. Rao',
  ].join('\n'), iyer);
  await record(arjun, iyer, {
    recordType: 'visit_note', title: 'Follow-up: lipids reviewed', description: 'Started atorvastatin 10 mg nightly. Diet and 150 min/week exercise advised. Review in 3 months.', appointmentId: a2.appt._id,
  }, at(-7, 11, 30));
  await record(arjun, null, { recordType: 'patient_upload', title: 'Previous ECG from City Clinic (2025)', description: 'Uploaded by the patient for reference.' }, at(-30, 18));
  await record(meera, menon, {
    recordType: 'diagnosis', title: 'Type 2 diabetes mellitus', diagnosis: 'E11.9 - Type 2 diabetes mellitus without complications',
    description: 'Fasting glucose 148 mg/dL, HbA1c 7.4%.', appointmentId: m1.appt._id,
  }, at(-14, 12, 30));
  const m2rec = await record(meera, iyer, {
    recordType: 'lab_result', title: '12-lead ECG', description: 'Normal sinus rhythm, rate 78 bpm. No ST-T changes.', findings: 'Normal ECG', appointmentId: m2.appt._id,
  }, at(-4, 15, 30));
  await storeFile(m2rec, 'ecg-summary.txt', 'ECG SUMMARY\nRhythm: sinus\nRate: 78 bpm\nPR 160 ms, QRS 88 ms, QTc 412 ms\nImpression: normal ECG', iyer);
  await record(meera, menon, { recordType: 'vaccination', title: 'Influenza vaccine 2026-27', description: 'Quadrivalent influenza vaccine, left deltoid. No reaction.' }, at(-10, 10));

  console.log('Creating prescriptions...');
  const rx = async (patient, doctor, fields, extra = {}) => {
    const p = new Prescription({ patientId: patient._id, doctorId: doctor._id, ...fields, ...extra });
    await chainEvent('prescription', p, 'CREATE', actorOf(doctor));
    return p;
  };
  const amlo = await rx(arjun, iyer, { medication: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily, morning', instructions: 'Take with water. Report ankle swelling.', refillsAllowed: 3, refillsUsed: 1, startDate: at(-21, 10), endDate: new Date(Date.now() + 70 * DAY) });
  amlo.refillRequest = { status: 'pending', requestedAt: new Date(Date.now() - 3 * 3600000), decidedAt: null };
  await chainEvent('prescription', amlo, 'REFILL_REQUESTED', actorOf(arjun));
  await rx(arjun, iyer, { medication: 'Atorvastatin', dosage: '10 mg', frequency: 'Once daily, at night', instructions: 'Avoid grapefruit juice.', refillsAllowed: 2, startDate: at(-7, 11), endDate: new Date(Date.now() + 83 * DAY) });
  await rx(meera, menon, { medication: 'Metformin', dosage: '500 mg', frequency: 'Twice daily with meals', instructions: 'Take with food to reduce stomach upset.', refillsAllowed: 5, refillsUsed: 0, startDate: at(-14, 12), endDate: new Date(Date.now() + 76 * DAY) });
  await rx(meera, iyer, { medication: 'Paracetamol', dosage: '650 mg', frequency: 'As needed, max 3 a day', refillsAllowed: 0, startDate: at(-40, 10), endDate: at(-33, 10) }, { status: 'completed' });

  console.log('Creating insurance claims...');
  const claim = async (patient, bill, steps) => {
    const c = new Claim({
      claimNumber: makeNumber('CLM'), patientId: patient._id, billId: bill._id, insuranceProvider: patient.patientProfile.insuranceProvider,
      policyNumber: patient.patientProfile.policyNumber, amount: bill.amount, description: bill.description,
      history: [{ status: 'submitted', by: patient._id.toString(), byRole: 'patient', note: 'Claim submitted' }],
    });
    await chainEvent('claim', c, 'SUBMIT', actorOf(patient));
    bill.status = 'claim_pending';
    await bill.save();
    await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: 'CLAIM_FILED', actor: actorOf(patient) });
    for (const [status, extra] of steps) {
      Object.assign(c, { status, agentId: agent._id, ...extra });
      c.history.push({ status, by: agent._id.toString(), byRole: 'insurance_agent', note: extra.decisionNote || '' });
      if (status === 'settled') {
        c.settledAt = new Date(Date.now() - 2 * DAY);
        c.settlementReference = `STL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        bill.coveredAmount = c.approvedAmount;
        bill.status = c.approvedAmount >= bill.amount ? 'covered' : 'partially_covered';
        await bill.save();
        await ledgerService.recordEvent({ entityType: 'bill', entity: bill, action: 'CLAIM_SETTLED', actor: actorOf(agent) });
      }
      await chainEvent('claim', c, status.toUpperCase(), actorOf(agent));
    }
    return c;
  };
  await claim(arjun, a1.bill, [['under_review', {}], ['approved', { approvedAmount: 900 }], ['settled', {}]]);
  await claim(meera, m1.bill, [['under_review', {}]]);
  await claim(arjun, a2.bill, []);
  // m2.bill stays unpaid so the patient can file or pay it live during the demo.

  console.log('Registering IoT devices and generating 7 days of vitals...');
  const devicesOut = [];
  const device = async (patient, serialNumber, name, type) => {
    const apiKey = `mcd_${crypto.randomBytes(24).toString('hex')}`;
    const d = await Device.create({
      serialNumber, name, type, patientId: patient._id, registeredBy: admin._id, lastSeenAt: new Date(),
      apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    });
    devicesOut.push({ deviceId: d._id.toString(), serialNumber, name, type, patient: patient.fullName, apiKey });
    return d;
  };
  const arjunDevice = await device(arjun, 'MC-MPM-0001', 'Multi-parameter home monitor', 'multi_parameter');
  const meeraDevice = await device(meera, 'MC-OXI-0002', 'Pulse oximeter', 'pulse_oximeter');

  const jitter = (v, spread) => Math.round((v + (Math.random() * 2 - 1) * spread) * 10) / 10;
  const readings = [];
  for (let h = 7 * 24; h >= 0; h -= 4) {
    const when = new Date(Date.now() - h * 3600000);
    const trend = h / (7 * 24); // Arjun's BP comes down over the week on treatment
    const a = {
      patientId: arjun._id, deviceId: arjunDevice._id, source: 'device', recordedAt: when,
      heartRate: Math.round(jitter(76, 8)), systolic: Math.round(jitter(128 + 16 * trend, 6)), diastolic: Math.round(jitter(82 + 8 * trend, 4)),
      spo2: Math.round(jitter(97.5, 1.2)), temperature: jitter(36.8, 0.3),
    };
    const m = {
      patientId: meera._id, deviceId: meeraDevice._id, source: 'device', recordedAt: when,
      heartRate: Math.round(jitter(80, 7)), spo2: Math.round(jitter(97, 1.5)),
    };
    readings.push({ ...a, abnormal: VitalReading.findAbnormal(a) }, { ...m, abnormal: VitalReading.findAbnormal(m) });
  }
  await VitalReading.insertMany(readings);
  fs.writeFileSync(DEVICES_FILE, JSON.stringify({ apiBase: `http://localhost:${config.port}`, devices: devicesOut }, null, 2));

  console.log('Creating notifications...');
  await Notification.insertMany([
    { userId: admin._id, type: 'warning', title: 'New account awaiting verification', message: 'Kavya Reddy registered as a doctor and needs verification.', page: 'verification' },
    { userId: iyer._id, type: 'warning', title: 'Refill request', message: 'Arjun Mehta requested a refill of Amlodipine 5 mg.', page: 'prescriptions' },
    { userId: iyer._id, type: 'info', title: 'New appointment request', message: 'Rohan Gupta requested a consultation: "Chest tightness while running"', page: 'appointments' },
    { userId: arjun._id, type: 'warning', title: 'Access request', message: 'Dr. Rahul Menon is requesting access to your medical records: "Second opinion on fasting glucose"', page: 'permissions' },
    { userId: arjun._id, type: 'success', title: 'Claim settled', message: 'Your claim for the consultation with Dr. Ananya Iyer was settled.', page: 'billing', read: true },
    { userId: meera._id, type: 'info', title: 'New bill', message: 'A bill was raised for your consultation with Dr. Ananya Iyer.', page: 'billing' },
    { userId: agent._id, type: 'info', title: 'New claim', message: "A claim for Arjun Mehta's follow-up is waiting for review.", page: 'queue' },
  ]);

  const check = await ledgerService.verifyChain('records');
  console.log('\nDone. Ledger check:', check.valid ? `valid (${check.entriesChecked} entries)` : check);
  console.log('\nDemo accounts (password = SEED_DEMO_PASSWORD from .env):');
  console.table([
    ['Admin', admin.email], ['Doctor (Cardiology)', iyer.email], ['Doctor (Endocrinology)', menon.email],
    ['Doctor (pending verification)', reddy.email], ['Insurance agent (Star Health)', agent.email],
    ['Patient: Arjun Mehta', arjun.email], ['Patient: Meera Nair', meera.email], ['Patient: Rohan Gupta (no consent: break-glass demo)', rohan.email],
  ].map(([role, mail]) => ({ role, email: mail })));
  console.log(`IoT device keys written to ${path.relative(process.cwd(), DEVICES_FILE)} (git-ignored). Run "npm run demo:iot" to stream live readings.`);
  await disconnectMongo();
}

main().catch(async (error) => {
  console.error(error);
  await disconnectMongo();
  process.exit(1);
});
