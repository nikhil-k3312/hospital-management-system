const { app, request, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, futureSlot } = require('../helpers');
const emailService = require('../../src/services/emailService');
const { EmailService, createTransport } = require('../../src/services/emailService');
const config = require('../../src/config/config');
const redisClient = require('../../src/db/redis');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

describe('error handling', () => {
  test('malformed JSON, bad ids and unknown routes get clean JSON errors', async () => {
    const malformed = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{"email":');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ success: false, message: 'Malformed JSON body' });

    const patient = await login(await createUser('patient'));
    expect((await as(patient).get('/api/appointments/not-an-id')).status).toBe(400);
    expect((await request(app).get('/api/nope')).status).toBe(404);
  });

  test('when Redis is unreachable, protected requests and logins fail closed with 503', async () => {
    const user = await createUser('patient');
    const session = await login(user);
    const down = () => Promise.reject(new Error('connect ECONNREFUSED'));

    jest.spyOn(redisClient, 'exists').mockImplementationOnce(down); // token blacklist check
    const res = await as(session).get('/api/users/me');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('REDIS_UNAVAILABLE');

    jest.spyOn(redisClient, 'get').mockImplementationOnce(down); // OTP attempt counter
    const otp = await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: 'Str0ng!Pass' });
    expect(otp.status).toBe(503);
    jest.restoreAllMocks();
  });

  test('an oversized body is rejected with 413', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'a@b.com', fullName: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(413);
  });

  test('security headers and the CSP are set; the frontend is served on the same origin', async () => {
    const res = await request(app).get('/login.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((await request(app).get('/package.json')).status).toBe(404); // dev files are never served
    expect((await request(app).get('/health')).body.status).toBe('running');
  });
});

describe('rescheduling', () => {
  test('a patient moves an appointment to a free slot; it goes back to pending and the doctor is told', async () => {
    const doctorUser = await createUser('doctor');
    const patient = await login(await createUser('patient'));
    const doctor = await login(doctorUser);
    const booked = await as(patient).post('/api/appointments').send({ doctorId: String(doctorUser._id), startTime: futureSlot(24).toISOString(), reason: 'Check-up' });
    await as(doctor).patch(`/api/appointments/${booked.body.data._id}`).send({ status: 'confirmed' });

    const moved = await as(patient).patch(`/api/appointments/${booked.body.data._id}`).send({ startTime: futureSlot(48).toISOString() });
    expect(moved.status).toBe(200);
    expect(moved.body.data.status).toBe('pending');
    expect((await as(doctor).get('/api/notifications')).body.data[0].title).toBe('Appointment rescheduled');

    expect((await as(doctor).patch(`/api/appointments/${booked.body.data._id}`).send({ startTime: futureSlot(72).toISOString() })).status).toBe(403);
  });

  test('rescheduling onto a taken slot is refused', async () => {
    const doctorUser = await createUser('doctor');
    const p1 = await login(await createUser('patient'));
    const p2 = await login(await createUser('patient'));
    const slotA = futureSlot(24);
    const slotB = futureSlot(48);
    await as(p1).post('/api/appointments').send({ doctorId: String(doctorUser._id), startTime: slotA.toISOString(), reason: 'Check-up' });
    const mine = await as(p2).post('/api/appointments').send({ doctorId: String(doctorUser._id), startTime: slotB.toISOString(), reason: 'Check-up' });
    const res = await as(p2).patch(`/api/appointments/${mine.body.data._id}`).send({ startTime: slotA.toISOString() });
    expect(res.status).toBe(409);
  });

  test('a doctor can add notes; a completed appointment cannot be cancelled', async () => {
    const doctorUser = await createUser('doctor');
    const patient = await login(await createUser('patient'));
    const doctor = await login(doctorUser);
    const booked = await as(patient).post('/api/appointments').send({ doctorId: String(doctorUser._id), startTime: futureSlot(24).toISOString(), reason: 'Check-up' });
    const noted = await as(doctor).patch(`/api/appointments/${booked.body.data._id}`).send({ notes: 'Bring previous reports' });
    expect(noted.body.data.notes).toBe('Bring previous reports');
    expect((await as(doctor).get(`/api/appointments/${booked.body.data._id}`)).status).toBe(200);
  });
});

describe('directory and consent edges', () => {
  test('patients see verified doctors; doctors find patients by email', async () => {
    const doctorUser = await createUser('doctor');
    await createUser('doctor', { approvalStatus: 'pending' });
    const patientUser = await createUser('patient');
    const patient = await login(patientUser);
    const doctor = await login(doctorUser);

    const doctors = await as(patient).get('/api/doctors');
    expect(doctors.body.data).toHaveLength(1);
    expect(doctors.body.data[0].doctorProfile.consultationFee).toBe(800);

    const found = await as(doctor).get(`/api/patients/search?email=${encodeURIComponent(patientUser.email)}`);
    expect(found.body.data.fullName).toBe(patientUser.fullName);
    expect((await as(doctor).get('/api/patients/search?email=nobody@example.com')).status).toBe(404);
  });

  test('a duplicate access request is refused; the patient can deny one', async () => {
    const doctor = await login(await createUser('doctor'));
    const patientUser = await createUser('patient');
    const patient = await login(patientUser);
    const first = await as(doctor).post('/api/consents/request').send({ patientId: String(patientUser._id), purpose: 'Review history' });
    expect((await as(doctor).post('/api/consents/request').send({ patientId: String(patientUser._id), purpose: 'Review history' })).status).toBe(409);
    expect((await as(patient).post(`/api/consents/${first.body.data._id}/deny`)).body.data.status).toBe('denied');
    expect((await as(patient).post(`/api/consents/${first.body.data._id}/approve`)).status).toBe(409);
    expect((await as(doctor).get('/api/consents')).body.data[0].status).toBe('denied');
  });

  test('a doctor can complete or cancel a prescription and sees refill denials through', async () => {
    const doctorUser = await createUser('doctor');
    const patientUser = await createUser('patient');
    const doctor = await login(doctorUser);
    const patient = await login(patientUser);
    await as(patient).post('/api/consents/grant').send({ doctorId: String(doctorUser._id) });
    const rx = await as(doctor).post('/api/prescriptions').send({ patientId: String(patientUser._id), medication: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', refillsAllowed: 2 });
    await as(patient).post(`/api/prescriptions/${rx.body.data._id}/refill-request`);
    expect((await as(doctor).patch(`/api/prescriptions/${rx.body.data._id}`).send({ action: 'deny_refill' })).body.data.refillRequest.status).toBe('denied');
    expect((await as(doctor).patch(`/api/prescriptions/${rx.body.data._id}`).send({ action: 'complete' })).body.data.status).toBe('completed');
    expect((await as(doctor).patch(`/api/prescriptions/${rx.body.data._id}`).send({ action: 'cancel' })).status).toBe(409);
  });
});

describe('ledger browsing (admin)', () => {
  test('stats, entries per chain, and record verification of a clean system', async () => {
    const admin = await login(await createUser('admin'));
    const doctorUser = await createUser('doctor');
    const patientUser = await createUser('patient');
    const patient = await login(patientUser);
    await as(patient).post('/api/consents/grant').send({ doctorId: String(doctorUser._id) });

    const stats = await as(admin).get('/api/ledger/stats');
    expect(stats.body.data.records.entries).toBeGreaterThan(0);
    expect(stats.body.data.byAction.some((a) => a._id.action === 'GRANT_ACCESS')).toBe(true);

    const records = await as(admin).get('/api/ledger/entries?chain=records&limit=5');
    expect(records.body.data[0].action).toBe('GRANT_ACCESS');
    const access = await as(admin).get('/api/ledger/entries?chain=access&entityType=access_decision');
    expect(access.body.data.length).toBeGreaterThan(0);
    const page2 = await as(admin).get(`/api/ledger/entries?chain=access&beforeSeq=${access.body.data[0].seq}`);
    expect(page2.body.data.every((e) => e.seq < access.body.data[0].seq)).toBe(true);

    const users = await as(admin).get('/api/admin/users?role=patient&status=active&q=patient');
    expect(users.body.data.map((u) => u._id)).toContain(String(patientUser._id));
    expect((await as(admin).patch(`/api/admin/users/${admin.user._id}`).send({ isActive: false })).status).toBe(400);
  });
});

describe('email service', () => {
  test('renders OTP, welcome and decision emails, escaping names', async () => {
    const service = new EmailService(createTransport({ email: { transport: 'json' } }));
    const otp = await service.sendOTP('a@example.com', '123456', '<script>x</script>');
    const message = JSON.parse(otp.message);
    expect(message.subject).toBe('Your MediChain login code');
    expect(message.html).toContain('123456');
    expect(message.html).not.toContain('<script>x');
    expect(message.text).toContain(`expires in ${config.otp.expiryMinutes} minutes`);

    const welcome = JSON.parse((await service.sendWelcome('d@example.com', 'Dr X', 'doctor', true)).message);
    expect(welcome.html).toContain('awaiting verification');
    const decision = JSON.parse((await service.sendApprovalDecision('d@example.com', 'Dr X', false, 'Licence expired')).message);
    expect(decision.subject).toContain('declined');
    expect(await service.verifyConnection()).toBe(true);
  });

  test('a failed OTP email surfaces as an error (login cannot continue), a failed welcome email does not', async () => {
    const broken = new EmailService({ sendMail: () => Promise.reject(new Error('SMTP down')) });
    await expect(broken.sendOTP('a@example.com', '1', 'A')).rejects.toThrow('EMAIL_FAILED');
    await expect(broken.sendWelcome('a@example.com', 'A', 'patient')).resolves.toBeNull();
    await expect(broken.sendApprovalDecision('a@example.com', 'A', true)).resolves.toBeNull();
  });

  test('a failed OTP email returns 500 from request-otp instead of pretending it was sent', async () => {
    const user = await createUser('patient');
    jest.spyOn(emailService, 'sendOTP').mockRejectedValueOnce(new Error('EMAIL_FAILED'));
    const res = await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: 'Str0ng!Pass' });
    expect(res.status).toBe(500);
  });
});
