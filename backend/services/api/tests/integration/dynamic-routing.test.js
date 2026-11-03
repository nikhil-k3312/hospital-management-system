const { request, app, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, PASSWORD } = require('../helpers');
const emailService = require('../../src/services/emailService');
const AccessGrant = require('../../src/models/AccessGrant');
const User = require('../../src/models/User');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

const UA = 'jest';
const cookiesOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
const route = (cookies = [], ua = UA) => request(app).post('/api/auth/route').set('User-Agent', ua).set('Cookie', cookies);

/** Full first-time login, keeping both cookies the browser would keep. */
async function firstLogin(user) {
  let otp;
  const spy = jest.spyOn(emailService, 'sendOTP').mockImplementation(async (e, code) => { otp = code; });
  await request(app).post('/api/auth/login/request-otp').set('User-Agent', UA).send({ email: user.email, password: PASSWORD });
  spy.mockRestore();
  const res = await request(app).post('/api/auth/login/verify-otp').set('User-Agent', UA).send({ email: user.email, otp });
  return { res, cookies: cookiesOf(res) };
}

describe('first login: normal form', () => {
  test('an unknown browser is told to show the normal login form', async () => {
    const res = await route();
    expect(res.body.data).toEqual({ mode: 'login' });
  });

  test('the first full login lands on the home page and remembers the browser', async () => {
    const patient = await createUser('patient');
    const { res, cookies } = await firstLogin(patient);
    expect(res.body.data.firstLogin).toBe(true);
    expect(res.body.data.landing.path).toBe('/patient.html#dashboard');
    expect(cookies.some((c) => c.startsWith('mcDevice='))).toBe(true);

    const stored = await User.findById(patient._id);
    expect(stored.trustedDevices).toHaveLength(1);
    expect(stored.trustedDevices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/); // only the hash is stored
    expect(stored.loginCount).toBe(1);
  });
});

describe('second visit: dynamic routing', () => {
  test('a trusted browser with a live session is routed straight to pending work', async () => {
    const patient = await createUser('patient');
    const doctor = await createUser('doctor');
    const { cookies } = await firstLogin(patient);
    await AccessGrant.create({ patientId: patient._id, doctorId: doctor._id, purpose: 'Cardiology review', status: 'requested', requestedBy: 'doctor' });

    const res = await route(cookies);
    expect(res.body.data.mode).toBe('redirect');
    expect(res.body.data.landing.path).toBe('/patient.html#permissions');
    expect(res.body.data.token).toBeTruthy();
  });

  test('routing follows the role: an admin with pending verifications opens Verification', async () => {
    const admin = await createUser('admin');
    await createUser('doctor', { approvalStatus: 'pending' });
    const { cookies } = await firstLogin(admin);
    expect((await route(cookies)).body.data.landing.path).toBe('/admin.html#verification');
  });

  test('with nothing pending, the returning user lands on the home page', async () => {
    const agent = await createUser('insurance_agent');
    const { cookies } = await firstLogin(agent);
    expect((await route(cookies)).body.data.landing.path).toBe('/insurance.html#dashboard');
  });

  test('after logout the trusted browser gets the "welcome back" form, and a password alone signs in', async () => {
    const patient = await createUser('patient');
    const { res, cookies } = await firstLogin(patient);
    await as({ token: res.body.data.token }).post('/api/auth/logout').set('Cookie', cookies);
    const deviceOnly = cookies.filter((c) => c.startsWith('mcDevice='));

    const back = await route(deviceOnly);
    expect(back.body.data.mode).toBe('returning');
    expect(back.body.data.firstName).toBe('patient');
    expect(back.body.data.emailHint).toMatch(/^p\*+@example\.com$/);

    const quick = await request(app).post('/api/auth/login/quick').set('User-Agent', UA).set('Cookie', deviceOnly).send({ password: PASSWORD });
    expect(quick.status).toBe(200);
    expect(quick.body.data.mode).toBe('redirect');
    expect(quick.body.data.landing.path).toBe('/patient.html#dashboard');
  });

  test('after a failed attempt the quick login still asks for the emailed code', async () => {
    const patient = await createUser('patient');
    const { cookies } = await firstLogin(patient);
    const deviceOnly = cookies.filter((c) => c.startsWith('mcDevice='));
    const quick = (password) => request(app).post('/api/auth/login/quick').set('User-Agent', UA).set('Cookie', deviceOnly).send({ password });

    expect((await quick('Wrong!Pass1')).status).toBe(401);
    const spy = jest.spyOn(emailService, 'sendOTP').mockImplementation(async () => {});
    const res = await quick(PASSWORD);
    spy.mockRestore();
    expect(res.body.data.mode).toBe('otp');
  });

  test('a device cookie copied to another browser is not recognised', async () => {
    const patient = await createUser('patient');
    const { cookies } = await firstLogin(patient);
    expect((await route(cookies, 'some-other-browser')).body.data.mode).toBe('login');
    const quick = await request(app).post('/api/auth/login/quick').set('User-Agent', 'some-other-browser').set('Cookie', cookies).send({ password: PASSWORD });
    expect(quick.status).toBe(401);
    expect(quick.body.code).toBe('DEVICE_UNKNOWN');
  });

  test('changing the password forgets every trusted browser', async () => {
    const patient = await createUser('patient');
    const session = await login(patient);
    await as(session).post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'N3w!Passw0rd' });
    expect((await User.findById(patient._id)).trustedDevices).toHaveLength(0);
  });
});
