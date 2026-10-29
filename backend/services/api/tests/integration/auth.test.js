const { app, request, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, PASSWORD } = require('../helpers');
const emailService = require('../../src/services/emailService');
const User = require('../../src/models/User');
const LedgerEntry = require('../../src/models/LedgerEntry');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

const register = (body) => request(app).post('/api/auth/register').send(body);

describe('POST /api/auth/register', () => {
  test('creates an approved patient, hashes the password and writes a ledger entry', async () => {
    const res = await register({ email: 'Asha@Example.com', password: PASSWORD, fullName: 'Asha Rao', insuranceProvider: 'Star Health', policyNumber: 'P-1' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: 'asha@example.com', role: 'patient', approvalStatus: 'approved' });
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const stored = await User.findOne({ email: 'asha@example.com' });
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.ledgerAddress).toMatch(/^mc_[a-f0-9]{40}$/);
    expect(await LedgerEntry.countDocuments({ action: 'REGISTER' })).toBe(1);
  });

  test('a self-registered doctor is pending until an admin verifies them', async () => {
    const res = await register({ email: 'doc@x.com', password: PASSWORD, fullName: 'Dr X', role: 'doctor', specialization: 'Cardiology', licenseNumber: 'MCI-1' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.approvalStatus).toBe('pending');
  });

  test('nobody can self-register as admin', async () => {
    const res = await register({ email: 'evil@x.com', password: PASSWORD, fullName: 'Evil', role: 'admin' });
    expect(res.status).toBe(400);
  });

  test('rejects weak passwords and duplicate emails', async () => {
    expect((await register({ email: 'a@x.com', password: 'weakpass', fullName: 'A' })).status).toBe(400);
    await register({ email: 'a@x.com', password: PASSWORD, fullName: 'A A' });
    expect((await register({ email: 'a@x.com', password: PASSWORD, fullName: 'A A' })).status).toBe(409);
  });
});

describe('two-step login', () => {
  test('password then emailed OTP returns an access token and an HttpOnly refresh cookie', async () => {
    const user = await createUser('patient');
    const session = await login(user);
    expect(session.token.split('.')).toHaveLength(3);
    expect(session.cookie).toMatch(/HttpOnly/);
    expect(session.cookie).toMatch(/SameSite=Strict/);
    expect(session.cookie).toMatch(/Path=\/api\/auth/);

    const me = await as(session).get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.isVerified).toBe(true);
    expect(me.body.data.trustScore.score).toBe(100);
  });

  test('unknown email and wrong password get the same answer (no user enumeration)', async () => {
    const user = await createUser('patient');
    const unknown = await request(app).post('/api/auth/login/request-otp').send({ email: 'nobody@x.com', password: PASSWORD });
    const wrong = await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: 'Wr0ng!Pass' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  test('the account locks after 5 wrong passwords (lockout works)', async () => {
    const user = await createUser('patient');
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: 'Wr0ng!Pass' });
      expect(res.body.attemptsRemaining).toBe(4 - i);
    }
    const locked = await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: PASSWORD });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  test('a wrong OTP is rejected and an OTP works only once', async () => {
    const user = await createUser('patient');
    let otp;
    jest.spyOn(emailService, 'sendOTP').mockImplementationOnce(async (e, code) => { otp = code; });
    await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: PASSWORD });

    const wrongCode = otp === '123456' ? '654321' : '123456';
    expect((await request(app).post('/api/auth/login/verify-otp').send({ email: user.email, otp: wrongCode })).status).toBe(401);
    expect((await request(app).post('/api/auth/login/verify-otp').send({ email: user.email, otp })).status).toBe(200);
    expect((await request(app).post('/api/auth/login/verify-otp').send({ email: user.email, otp })).status).toBe(401);
  });

  test('a deactivated account cannot log in', async () => {
    const user = await createUser('patient', { isActive: false });
    const res = await request(app).post('/api/auth/login/request-otp').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('refresh-token rotation', () => {
  test('each refresh token works exactly once', async () => {
    const session = await login(await createUser('patient'));
    const first = await request(app).post('/api/auth/refresh-token').set('Cookie', session.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.token).toBeTruthy();
    const newCookie = first.headers['set-cookie'].find((c) => c.startsWith('refreshToken='));
    expect(newCookie).not.toBe(session.cookie);

    // Replaying the old cookie fails: it was revoked when it was used.
    expect((await request(app).post('/api/auth/refresh-token').set('Cookie', session.cookie)).status).toBe(401);
    // The new one works.
    expect((await request(app).post('/api/auth/refresh-token').set('Cookie', newCookie)).status).toBe(200);
  });

  test('without a cookie there is no session', async () => {
    expect((await request(app).post('/api/auth/refresh-token')).status).toBe(401);
  });
});

describe('logout and password change', () => {
  test('logout kills the access token and the refresh token immediately', async () => {
    const session = await login(await createUser('patient'));
    const res = await as(session).post('/api/auth/logout').set('Cookie', session.cookie);
    expect(res.status).toBe(200);

    const after = await as(session).get('/api/users/me');
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('TOKEN_REVOKED');
    expect((await request(app).post('/api/auth/refresh-token').set('Cookie', session.cookie)).status).toBe(401);
  });

  test('changing the password signs out every session', async () => {
    const user = await createUser('patient');
    const session = await login(user);
    const res = await as(session).post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'N3w!Password' });
    expect(res.status).toBe(200);
    expect((await as(session).get('/api/users/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh-token').set('Cookie', session.cookie)).status).toBe(401);
    await expect(login(user, 'N3w!Password')).resolves.toHaveProperty('token');
  });
});

describe('protected routes', () => {
  test('reject a missing or forged token, and audit the denial', async () => {
    expect((await request(app).get('/api/users/me')).status).toBe(401);
    expect((await request(app).get('/api/users/me').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
    expect(await LedgerEntry.countDocuments({ chain: 'access', action: 'DENY' })).toBe(2);
  });

  test('a deactivated user is cut off at their next request', async () => {
    const admin = await login(await createUser('admin'));
    const patientUser = await createUser('patient');
    const patient = await login(patientUser);
    expect((await as(patient).get('/api/users/me')).status).toBe(200);

    await as(admin).patch(`/api/admin/users/${patientUser._id}`).send({ isActive: false });
    const res = await as(patient).get('/api/users/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_DEACTIVATED');
  });

  test('PATCH /api/users/me updates only the caller\'s own profile section', async () => {
    const doctor = await login(await createUser('doctor'));
    const ok = await as(doctor).patch('/api/users/me').send({ phone: '+91 90000 00000', doctorProfile: { consultationFee: 1200, availability: { startHour: 10, endHour: 14 } } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.doctorProfile.consultationFee).toBe(1200);
    expect(ok.body.data.user.doctorProfile.availability).toMatchObject({ startHour: 10, endHour: 14 });

    expect((await as(doctor).patch('/api/users/me').send({ patientProfile: { bloodType: 'A+' } })).status).toBe(400);
    expect((await as(doctor).patch('/api/users/me').send({ role: 'admin' })).status).toBe(400);
  });
});
