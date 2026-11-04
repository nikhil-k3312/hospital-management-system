const { request, app, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, PASSWORD } = require('../helpers');
const config = require('../../src/config/config');
const emailService = require('../../src/services/emailService');
const AccessGrant = require('../../src/models/AccessGrant');
const LedgerEntry = require('../../src/models/LedgerEntry');
const User = require('../../src/models/User');

// geoip-lite places 49.207.0.1 in Hyderabad and 81.2.69.142 in St Albans (UK).
const HYDERABAD_IP = '49.207.0.1';
const UK_IP = '81.2.69.142';
const GPS_HYDERABAD = { lat: 17.39, lon: 78.49 };
const UA = 'jest';

beforeAll(setupDatabase);
beforeEach(async () => {
  await resetDatabase();
  Object.assign(config.context, { hospitalNetworks: [], dutyStartHour: 0, dutyEndHour: 24 }); // always "duty hours" unless a test says otherwise
});
afterAll(teardownDatabase);

const cookiesOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
const post = (url, { ip = HYDERABAD_IP, cookies = [], ua = UA } = {}) => request(app).post(url).set('User-Agent', ua).set('X-Forwarded-For', ip).set('Cookie', cookies);

function captureCodes() {
  const codes = [];
  const spy = jest.spyOn(emailService, 'sendOTP').mockImplementation(async (email, code) => { codes.push(code); });
  return { codes, restore: () => spy.mockRestore() };
}

/** Registration plus the normal first login (password, then emailed code). */
async function registerAndFirstLogin(email = 'arjun@example.com') {
  const reg = await request(app).post('/api/auth/register').send({
    email, password: PASSWORD, fullName: 'Arjun Mehta', role: 'patient',
    securityQuestion: 'In which city were you born?', securityAnswer: 'Bengaluru',
  });
  expect(reg.status).toBe(201);
  const mail = captureCodes();
  const step1 = await post('/api/auth/login/dynamic').send({ email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
  mail.restore();
  expect(step1.body.data.mode).toBe('otp'); // first time: the normal login
  const step2 = await post('/api/auth/login/verify-otp').send({ email, otp: mail.codes[0] });
  expect(step2.status).toBe(200);
  return { user: await User.findOne({ email }), cookies: cookiesOf(step2), first: step2.body.data };
}

describe('first time: normal sign-up and sign-in', () => {
  test('an unknown browser gets the normal login page', async () => {
    expect((await post('/api/auth/route').send({})).body.data).toEqual({ mode: 'login' });
  });

  test('registration then the first login use the normal password + code flow and remember browser and network', async () => {
    const { user, cookies, first } = await registerAndFirstLogin();
    expect(first.firstLogin).toBe(true);
    expect(first.landing.path).toBe('/patient.html#dashboard');
    expect(cookies.some((c) => c.startsWith('mcDevice='))).toBe(true);
    expect(user.trustedDevices).toHaveLength(1);
    expect(user.knownNetworks).toHaveLength(1);
    expect(user.securityAnswerHash).toMatch(/^\$2[aby]\$/); // bcrypt, never the plain answer
  });
});

describe('after the first time: dynamic login algorithm', () => {
  test('trusted browser + known network + GPS matching the IP = 95, low risk: password only', async () => {
    const { cookies } = await registerAndFirstLogin();
    const deviceOnly = cookies.filter((c) => c.startsWith('mcDevice='));
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { cookies: deviceOnly }).send({ password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    mail.restore();

    expect(res.body.data.mode).toBe('redirect');
    expect(res.body.data.assessment.score).toBe(95); // 35 location + 25 device + 20 time + 15 known network
    expect(res.body.data.assessment.breakdown.location.category).toBe('IP and GPS agree');
    expect(mail.codes).toHaveLength(0); // no code needed at low risk
  });

  test('new browser on a new network with GPS far from the IP = 40, high risk: code + security question', async () => {
    await registerAndFirstLogin();
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: 'arjun@example.com', password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(res.body.data.mode).toBe('challenge');
    expect(res.body.data.assessment.score).toBe(40); // 5 + 10 + 20 + 5
    expect(res.body.data.assessment.risk).toBe('high');
    expect(res.body.data.assessment.factors).toEqual(['password', 'otp', 'security_question']);
    expect(res.body.data.securityQuestion).toBe('In which city were you born?');
    expect(res.body.data.assessment.breakdown.location.distanceKm).toBeGreaterThan(7000);

    const wrong = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: res.body.data.challengeId, otp: mail.codes[0], securityAnswer: 'Delhi' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_SECURITY_ANSWER');

    const retry = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: 'arjun@example.com', password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    const ok = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: retry.body.data.challengeId, otp: mail.codes[1], securityAnswer: '  bengaluru ' });
    mail.restore();
    expect(ok.status).toBe(200);
    expect(ok.body.data.mode).toBe('redirect');
    expect(cookiesOf(ok).some((c) => c.startsWith('mcDevice='))).toBe(true); // this browser is now trusted
  });

  test('trusted browser with no GPS = 75, medium risk: emailed code only', async () => {
    const { cookies } = await registerAndFirstLogin();
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { cookies }).send({ password: PASSWORD, context: { gps: null } });
    expect(res.body.data.mode).toBe('challenge');
    expect(res.body.data.assessment.score).toBe(75); // 15 unknown location + 25 + 20 + 15
    expect(res.body.data.assessment.factors).toEqual(['password', 'otp']);
    expect(res.body.data.securityQuestion).toBeNull();
    const ok = await post('/api/auth/login/challenge', { cookies }).send({ challengeId: res.body.data.challengeId, otp: mail.codes[0] });
    mail.restore();
    expect(ok.status).toBe(200);
  });

  test('a hospital network scores 20 and off-hours scores 10', async () => {
    const { cookies } = await registerAndFirstLogin();
    Object.assign(config.context, { hospitalNetworks: ['49.207.0.0/16'], dutyStartHour: 0, dutyEndHour: 0 });
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { cookies }).send({ password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    mail.restore();
    const b = res.body.data.assessment.breakdown;
    expect(b.network).toMatchObject({ score: 20, category: 'Hospital network' });
    expect(b.time).toMatchObject({ score: 10, category: 'Off hours' });
    expect(res.body.data.assessment.score).toBe(90);
  });

  test('without a security question on file, high risk asks for the emailed code', async () => {
    const patient = await createUser('patient', { loginCount: 3 });
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: patient.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    mail.restore();
    expect(res.body.data.assessment.risk).toBe('high');
    expect(res.body.data.assessment.factors).toEqual(['password', 'otp']);
  });

  test('a wrong password is refused before any context decision', async () => {
    await registerAndFirstLogin();
    const res = await post('/api/auth/login/dynamic').send({ email: 'arjun@example.com', password: 'Wrong!Pass1', context: {} });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  test('every decision goes to the access ledger with the score but no raw IP or coordinates', async () => {
    const { cookies } = await registerAndFirstLogin();
    await post('/api/auth/login/dynamic', { cookies }).send({ password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    const entry = await LedgerEntry.findOne({ chain: 'access', entityType: 'login_context' }).lean();
    expect(entry.action).toBe('ALLOW');
    expect(entry.meta.trustScore).toBe(95);
    const stored = JSON.stringify(entry.meta);
    expect(stored).not.toContain(HYDERABAD_IP);
    expect(stored).not.toContain('17.39');
    expect(entry.meta.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('behaviour signal', () => {
  test('two failed passwords since the last login cost 20 points: 95 becomes 75, medium risk', async () => {
    const { cookies } = await registerAndFirstLogin();
    const deviceOnly = cookies.filter((c) => c.startsWith('mcDevice='));
    for (let i = 0; i < 2; i += 1) {
      await post('/api/auth/login/dynamic', { cookies: deviceOnly }).send({ password: 'Wrong!Pass1', context: { gps: GPS_HYDERABAD } });
    }
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { cookies: deviceOnly }).send({ password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    mail.restore();
    expect(res.body.data.mode).toBe('challenge');
    expect(res.body.data.assessment.score).toBe(75);
    expect(res.body.data.assessment.breakdown.behaviour).toMatchObject({ score: -20, failures: 2 });
  });
});

describe('emergency sign-in (break-glass at login)', () => {
  const REASON = 'Cardiac arrest in ICU bed 4, need medication history now';
  const clinician = (role) => createUser(role, { loginCount: 3, securityQuestion: 'In which city were you born?', securityAnswerHash: 'Bengaluru' });

  async function highRiskChallenge(user) {
    const mail = captureCodes();
    const res = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: user.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    mail.restore();
    expect(res.body.data.assessment.risk).toBe('high');
    return { challenge: res.body.data, code: mail.codes[0] };
  }

  test('a doctor may give a reason instead of the security answer: short, audited session, browser not trusted', async () => {
    const doctor = await clinician('doctor');
    await createUser('admin');
    const { challenge, code } = await highRiskChallenge(doctor);
    expect(challenge.emergencyAllowed).toBe(true);

    const res = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: challenge.challengeId, otp: code, emergencyReason: REASON });
    expect(res.status).toBe(200);
    expect(res.body.data.emergency.reason).toBe(REASON);
    const minutesLeft = (new Date(res.body.data.emergency.until) - Date.now()) / 60000;
    expect(minutesLeft).toBeGreaterThan(29);
    expect(minutesLeft).toBeLessThanOrEqual(30);
    expect(cookiesOf(res).some((c) => c.startsWith('mcDevice='))).toBe(false); // context not proved, so not remembered

    const entry = await LedgerEntry.findOne({ chain: 'access', entityType: 'login_context', 'meta.reason': 'emergency_login' }).lean();
    expect(entry.meta.emergencyReason).toBe(REASON);
    const Notification = require('../../src/models/Notification');
    expect(await Notification.countDocuments({ title: 'Emergency sign-in used' })).toBe(1);

    // refreshing never extends the emergency window
    const refreshed = await post('/api/auth/refresh-token', { ip: UK_IP, cookies: cookiesOf(res) }).send();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.emergency.until).toBe(res.body.data.emergency.until);
  });

  test('the emailed code is still required', async () => {
    const doctor = await clinician('doctor');
    const { challenge } = await highRiskChallenge(doctor);
    const res = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: challenge.challengeId, otp: '000000', emergencyReason: REASON });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_OTP');
  });

  test('patients cannot use emergency sign-in', async () => {
    const patient = await clinician('patient');
    const { challenge, code } = await highRiskChallenge(patient);
    expect(challenge.emergencyAllowed).toBe(false);
    const res = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: challenge.challengeId, otp: code, emergencyReason: REASON });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMERGENCY_NOT_ALLOWED');
  });

  test('a reason shorter than 10 characters is rejected', async () => {
    const doctor = await clinician('doctor');
    const { challenge, code } = await highRiskChallenge(doctor);
    const res = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: challenge.challengeId, otp: code, emergencyReason: 'urgent' });
    expect(res.status).toBe(400);
  });
});

describe('page load: dynamic routing', () => {
  test('live session at low risk goes straight to pending work', async () => {
    const { user, cookies } = await registerAndFirstLogin();
    const doctor = await createUser('doctor');
    await AccessGrant.create({ patientId: user._id, doctorId: doctor._id, purpose: 'Cardiology review', status: 'requested', requestedBy: 'doctor' });
    const res = await post('/api/auth/route', { cookies }).send({ context: { gps: GPS_HYDERABAD } });
    expect(res.body.data.mode).toBe('redirect');
    expect(res.body.data.landing.path).toBe('/patient.html#permissions');
  });

  test('live session but higher risk shows the welcome-back form with the factors needed', async () => {
    const { cookies } = await registerAndFirstLogin();
    const res = await post('/api/auth/route', { cookies }).send({ context: { gps: null } });
    expect(res.body.data.mode).toBe('returning');
    expect(res.body.data.firstName).toBe('Arjun');
    expect(res.body.data.assessment.factors).toEqual(['password', 'otp']);
  });

  test('an admin with pending verifications is routed to Verification', async () => {
    const admin = await createUser('admin');
    await createUser('doctor', { approvalStatus: 'pending' });
    const mail = captureCodes();
    await post('/api/auth/login/request-otp').send({ email: admin.email, password: PASSWORD });
    const step2 = await post('/api/auth/login/verify-otp').send({ email: admin.email, otp: mail.codes[0] });
    mail.restore();
    const res = await post('/api/auth/route', { cookies: cookiesOf(step2) }).send({ context: { gps: GPS_HYDERABAD } });
    expect(res.body.data.mode).toBe('redirect');
    expect(res.body.data.landing.path).toBe('/admin.html#verification');
  });

  test('a device cookie copied to another browser is not recognised', async () => {
    const { cookies } = await registerAndFirstLogin();
    expect((await post('/api/auth/route', { cookies, ua: 'other-browser' }).send({})).body.data.mode).toBe('login');
  });

  test('changing the password forgets every trusted browser', async () => {
    const patient = await createUser('patient');
    const session = await login(patient);
    await as(session).post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'N3w!Passw0rd' });
    expect((await User.findById(patient._id)).trustedDevices).toHaveLength(0);
  });
});
