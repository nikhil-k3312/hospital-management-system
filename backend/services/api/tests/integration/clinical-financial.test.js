const { app, request, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as } = require('../helpers');
const Appointment = require('../../src/models/Appointment');
const Bill = require('../../src/models/Bill');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

async function consentedPair() {
  const doctorUser = await createUser('doctor');
  const patientUser = await createUser('patient');
  const doctor = await login(doctorUser);
  const patient = await login(patientUser);
  await as(patient).post('/api/consents/grant').send({ doctorId: String(doctorUser._id), durationDays: 30 });
  return { doctorUser, patientUser, doctor, patient };
}

describe('prescriptions', () => {
  test('issue -> patient requests refill -> doctor approves; refills are counted', async () => {
    const { doctor, patient, patientUser } = await consentedPair();
    const rx = await as(doctor).post('/api/prescriptions').send({
      patientId: String(patientUser._id), medication: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily', refillsAllowed: 1,
    });
    expect(rx.status).toBe(201);
    const id = rx.body.data._id;

    expect((await as(patient).post(`/api/prescriptions/${id}/refill-request`)).status).toBe(200);
    expect((await as(patient).post(`/api/prescriptions/${id}/refill-request`)).status).toBe(409); // already pending
    const approved = await as(doctor).patch(`/api/prescriptions/${id}`).send({ action: 'approve_refill' });
    expect(approved.body.data).toMatchObject({ refillsUsed: 1, refillRequest: { status: 'approved' } });

    const none = await as(patient).post(`/api/prescriptions/${id}/refill-request`);
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('NO_REFILLS');
  });

  test('prescribing needs consent', async () => {
    const doctor = await login(await createUser('doctor'));
    const patientUser = await createUser('patient');
    const res = await as(doctor).post('/api/prescriptions').send({ patientId: String(patientUser._id), medication: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' });
    expect(res.status).toBe(403);
  });
});

describe('billing and insurance claims', () => {
  async function billedPatient() {
    const pair = await consentedPair();
    const appt = await Appointment.create({
      patientId: pair.patientUser._id, doctorId: pair.doctorUser._id, startTime: new Date(Date.now() - 7200000),
      endTime: new Date(Date.now() - 5400000), status: 'confirmed', reason: 'Review',
    });
    await as(pair.doctor).patch(`/api/appointments/${appt._id}`).send({ status: 'completed' });
    const bill = await Bill.findOne({ appointmentId: appt._id });
    const agentUser = await createUser('insurance_agent');
    return { ...pair, bill, agentUser, agent: await login(agentUser) };
  }

  test('full round trip: submit -> review -> approve -> settle, and the bill is covered', async () => {
    const w = await billedPatient();
    const claim = await as(w.patient).post('/api/claims').send({ billId: String(w.bill._id) });
    expect(claim.status).toBe(201);
    expect((await Bill.findById(w.bill._id)).status).toBe('claim_pending');
    const id = claim.body.data._id;

    // The agent sees it in their queue, with billing data only.
    const queue = await as(w.agent).get('/api/claims');
    expect(queue.body.data.map((c) => c._id)).toContain(id);

    expect((await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'under_review' })).status).toBe(200);
    expect((await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'approved', approvedAmount: 800 })).status).toBe(200);
    const settled = await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'settled' });
    expect(settled.body.data.settlementReference).toMatch(/^STL-/);

    expect((await Bill.findById(w.bill._id)).status).toBe('covered');
    const mine = await as(w.patient).get('/api/claims');
    expect(mine.body.data[0].status).toBe('settled');
    const notes = await as(w.patient).get('/api/notifications');
    expect(notes.body.data.some((n) => n.message.includes('was settled'))).toBe(true);
  });

  test('the state machine refuses illegal jumps', async () => {
    const w = await billedPatient();
    const claim = await as(w.patient).post('/api/claims').send({ billId: String(w.bill._id) });
    const res = await as(w.agent).patch(`/api/claims/${claim.body.data._id}`).send({ status: 'settled' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  test('a partial approval leaves the bill partially covered, and the balance can be paid', async () => {
    const w = await billedPatient();
    const claim = await as(w.patient).post('/api/claims').send({ billId: String(w.bill._id) });
    const id = claim.body.data._id;
    await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'under_review' });
    expect((await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'approved', approvedAmount: 900 })).status).toBe(400); // more than claimed
    await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'approved', approvedAmount: 500 });
    await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'settled' });
    expect((await Bill.findById(w.bill._id)).status).toBe('partially_covered');

    const paid = await as(w.patient).post(`/api/bills/${w.bill._id}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'paid', paidAmount: 300 });
  });

  test('a denied claim needs a reason and returns the bill to unpaid', async () => {
    const w = await billedPatient();
    const claim = await as(w.patient).post('/api/claims').send({ billId: String(w.bill._id) });
    const id = claim.body.data._id;
    await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'under_review' });
    expect((await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'denied' })).status).toBe(400);
    expect((await as(w.agent).patch(`/api/claims/${id}`).send({ status: 'denied', note: 'Policy lapsed' })).status).toBe(200);
    expect((await Bill.findById(w.bill._id)).status).toBe('unpaid');
  });

  test('agents of another insurer cannot see or act on the claim; reports are computed live', async () => {
    const w = await billedPatient();
    const claim = await as(w.patient).post('/api/claims').send({ billId: String(w.bill._id) });
    const outsider = await login(await createUser('insurance_agent', { agentProfile: { company: 'HDFC Ergo' } }));
    expect((await as(outsider).get('/api/claims')).body.data).toHaveLength(0);
    expect((await as(outsider).patch(`/api/claims/${claim.body.data._id}`).send({ status: 'under_review' })).status).toBe(403);

    const report = await as(w.agent).get('/api/claims/reports');
    expect(report.body.data).toMatchObject({ totalClaims: 1, totalClaimed: 800 });
  });

  test('patients cannot reach the agent workflow', async () => {
    const w = await billedPatient();
    const claim = await as(w.patient).post('/api/claims').send({ billId: String(w.bill._id) });
    expect((await as(w.patient).patch(`/api/claims/${claim.body.data._id}`).send({ status: 'under_review' })).status).toBe(403);
  });
});

describe('admin module', () => {
  test('verifying a doctor flips approvalStatus and unlocks clinical routes', async () => {
    const admin = await login(await createUser('admin'));
    const docUser = await createUser('doctor', { approvalStatus: 'pending' });
    const doc = await login(docUser);

    const blocked = await as(doc).get('/api/patients');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('APPROVAL_PENDING');

    const pending = await as(admin).get('/api/admin/doctors/pending-verification');
    expect(pending.body.data.map((u) => u._id)).toContain(String(docUser._id));
    expect((await as(admin).patch(`/api/admin/doctors/${docUser._id}/verify`).send({ decision: 'approve' })).status).toBe(200);

    expect((await as(doc).get('/api/patients')).status).toBe(200);
  });

  test('admins create staff; non-admins cannot reach admin routes', async () => {
    const admin = await login(await createUser('admin'));
    const res = await as(admin).post('/api/admin/users').send({
      email: 'agent@starhealth.com', fullName: 'Agent Smith', password: 'Ag3nt!Pass', role: 'insurance_agent', company: 'Star Health',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.approvalStatus).toBe('approved');

    const patient = await login(await createUser('patient'));
    const denied = await as(patient).get('/api/admin/users');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ROLE_DENIED');
  });

  test('stats reflect the live database', async () => {
    const admin = await login(await createUser('admin'));
    const before = (await as(admin).get('/api/admin/stats')).body.data;
    await createUser('patient');
    const after = (await as(admin).get('/api/admin/stats')).body.data;
    expect(after.users.total).toBe(before.users.total + 1);
    expect(after.system.mongo.ok).toBe(true);
    expect(after.system.redis.ok).toBe(true);
    expect(after.appointments.last7Days).toHaveLength(7);
  });

  test('settings are editable and drive the public registration data', async () => {
    const admin = await login(await createUser('admin'));
    await as(admin).patch('/api/admin/settings').send({ hospitalName: 'City Care', insuranceProviders: ['Star Health', 'Niva Bupa'] });
    const pub = await request(app).get('/api/settings/public');
    expect(pub.body.data).toMatchObject({ hospitalName: 'City Care', insuranceProviders: ['Star Health', 'Niva Bupa'] });
  });

  test('the public landing-page stats are anonymous live counts', async () => {
    await createUser('patient');
    await createUser('doctor');
    await createUser('doctor', { approvalStatus: 'pending' });
    const res = await request(app).get('/api/public/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ patients: 1, doctors: 1, appointmentsCompleted: 0, ledgerBlocks: 0 });
  });

  test('the access audit lists allow and deny decisions', async () => {
    const admin = await login(await createUser('admin'));
    await request(app).get('/api/users/me'); // a denial
    const audit = await as(admin).get('/api/admin/audit?decision=deny');
    expect(audit.status).toBe(200);
    expect(audit.body.data.length).toBeGreaterThan(0);
    expect(audit.body.data.every((e) => e.action === 'DENY')).toBe(true);
  });
});

describe('IoT devices and vitals', () => {
  test('a registered device posts readings; abnormal values alert the patient and consenting doctors', async () => {
    const { doctor, patient, patientUser } = await consentedPair();
    const admin = await login(await createUser('admin'));
    const reg = await as(admin).post('/api/admin/devices').send({
      serialNumber: 'HM-0001', name: 'Wrist heart monitor', type: 'heart_monitor', patientId: String(patientUser._id),
    });
    expect(reg.status).toBe(201);
    const { apiKey } = reg.body.data;
    expect(apiKey).toMatch(/^mcd_/);

    const ok = await request(app).post('/api/devices/readings').set('x-device-key', apiKey).send({ heartRate: 74, spo2: 98 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.abnormal).toEqual([]);
    const high = await request(app).post('/api/devices/readings').set('x-device-key', apiKey).send({ heartRate: 132 });
    expect(high.body.data.abnormal).toEqual(['heartRate']);

    expect((await as(patient).get('/api/vitals?days=1')).body.data.readings).toHaveLength(2);
    const monitor = await as(doctor).get('/api/vitals/monitor');
    expect(monitor.body.data.patients[0].latest.heartRate).toBe(132);
    expect((await as(doctor).get('/api/notifications')).body.data.some((n) => n.type === 'danger')).toBe(true);
  });

  test('an unknown device key is rejected, and a deactivated device stops working', async () => {
    const admin = await login(await createUser('admin'));
    const patientUser = await createUser('patient');
    expect((await request(app).post('/api/devices/readings').set('x-device-key', 'mcd_fake').send({ heartRate: 70 })).status).toBe(401);

    const reg = await as(admin).post('/api/admin/devices').send({ serialNumber: 'BP-1', name: 'Cuff', type: 'bp_monitor', patientId: String(patientUser._id) });
    await as(admin).patch(`/api/admin/devices/${reg.body.data.device._id}`).send({ status: 'inactive' });
    expect((await request(app).post('/api/devices/readings').set('x-device-key', reg.body.data.apiKey).send({ systolic: 120 })).status).toBe(401);
  });

  test('a patient can log a reading by hand; doctors need consent to see vitals', async () => {
    const patientUser = await createUser('patient');
    const patient = await login(patientUser);
    expect((await as(patient).post('/api/vitals').send({ systolic: 128, diastolic: 84 })).status).toBe(201);
    const stranger = await login(await createUser('doctor'));
    expect((await as(stranger).get(`/api/vitals?patientId=${patientUser._id}`)).status).toBe(403);
  });
});

describe('notifications', () => {
  test('mark one and mark all as read', async () => {
    const { patient } = await consentedPair();
    const doctor2 = await createUser('doctor');
    await as(patient).post('/api/consents/grant').send({ doctorId: String(doctor2._id) });

    const notes = await as(patient).get('/api/notifications');
    expect(notes.status).toBe(200);
    const mine = await login(doctor2);
    const list = await as(mine).get('/api/notifications?unread=true');
    expect(list.body.meta.unreadCount).toBe(1);
    expect((await as(mine).patch(`/api/notifications/${list.body.data[0]._id}/read`)).status).toBe(200);
    expect((await as(mine).get('/api/notifications')).body.meta.unreadCount).toBe(0);
    expect((await as(mine).post('/api/notifications/read-all')).status).toBe(200);
  });
});
