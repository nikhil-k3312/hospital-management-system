/**
 * Tests for the CARMA paper version: one describe block per problem of the improvement plan.
 */
const { request, app, setupDatabase, resetDatabase, teardownDatabase, createUser, login, as, PASSWORD } = require('../helpers');
const config = require('../../src/config/config');
const emailService = require('../../src/services/emailService');
const totpService = require('../../src/services/totpService');
const roleService = require('../../src/services/roleService');
const blockchainService = require('../../src/services/blockchainService');
const anchorService = require('../../src/services/anchorService');
const ledgerService = require('../../src/services/ledgerService');
const LedgerEntry = require('../../src/models/LedgerEntry');
const LedgerAnchor = require('../../src/models/LedgerAnchor');
const User = require('../../src/models/User');

const HYDERABAD_IP = '49.207.0.1';
const OTHER_HYDERABAD_NET = '49.207.9.1';
const UK_IP = '81.2.69.142';
const GPS_HYDERABAD = { lat: 17.39, lon: 78.49 };
const UA = 'jest';

const defaults = {
  context: { ...config.context },
  security: { ...config.security },
  audit: { ...config.audit },
};

beforeAll(setupDatabase);
beforeEach(async () => {
  await resetDatabase();
  Object.assign(config.context, defaults.context, { hospitalNetworks: [], dutyStartHour: 0, dutyEndHour: 24 });
  Object.assign(config.security, defaults.security);
  Object.assign(config.audit, defaults.audit);
});
afterEach(() => jest.restoreAllMocks());
afterAll(teardownDatabase);

const cookiesOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
const post = (url, { ip = HYDERABAD_IP, cookies = [], ua = UA, token } = {}) => {
  const r = request(app).post(url).set('User-Agent', ua).set('X-Forwarded-For', ip).set('Cookie', cookies);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
const get = (url, { ip = HYDERABAD_IP, ua = UA, token } = {}) => request(app).get(url).set('User-Agent', ua).set('X-Forwarded-For', ip).set('Authorization', `Bearer ${token}`);

function captureCodes() {
  const codes = [];
  jest.spyOn(emailService, 'sendOTP').mockImplementation(async (email, code) => { codes.push(code); });
  return codes;
}

/** The first (bootstrap) login through /login/dynamic + /login/verify-otp. */
async function firstLogin(user, { ip = HYDERABAD_IP } = {}) {
  const codes = captureCodes();
  const step1 = await post('/api/auth/login/dynamic', { ip }).send({ email: user.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
  expect(step1.body.data.mode).toBe('otp');
  const step2 = await post('/api/auth/login/verify-otp', { ip }).send({ email: user.email, otp: codes[0] });
  expect(step2.status).toBe(200);
  return { token: step2.body.data.token, cookies: cookiesOf(step2), body: step2.body.data };
}

async function enrolTotp(userId) {
  const secret = totpService.newSecret();
  await User.updateOne({ _id: userId }, { $set: { totpEnabled: true, totpSecretEnc: totpService.encryptSecret(secret), totpLastStep: null } });
  return secret;
}

/* -------------------------------------------------------------------------------------- 1 */
describe('Problem 1: the bootstrap endpoints serve the first login only', () => {
  test('the first login works; afterwards both endpoints answer 403 USE_DYNAMIC_LOGIN and set no cookie', async () => {
    const user = await createUser('patient');
    await firstLogin(user);

    const codes = captureCodes();
    const req1 = await post('/api/auth/login/request-otp').send({ email: user.email, password: PASSWORD });
    expect(req1.status).toBe(403);
    expect(req1.body.code).toBe('USE_DYNAMIC_LOGIN');
    expect(codes).toHaveLength(0); // no code was sent

    const req2 = await post('/api/auth/login/verify-otp').send({ email: user.email, otp: '123456' });
    expect(req2.status).toBe(403);
    expect(req2.body.code).toBe('USE_DYNAMIC_LOGIN');
    expect(cookiesOf(req2).some((c) => c.startsWith('refreshToken=') || c.startsWith('mcDevice='))).toBe(false);
  });

  test('a wrong password still answers 401 (the check comes after the password)', async () => {
    const user = await createUser('patient', { loginCount: 2 });
    const res = await post('/api/auth/login/request-otp').send({ email: user.email, password: 'Wr0ng!Pass' });
    expect(res.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------------------- 2 */
describe('Problem 2: authenticator app (TOTP)', () => {
  test('set-up and confirmation inside a fresh session; the confirming code cannot be reused at login', async () => {
    const user = await createUser('patient');
    const session = await firstLogin(user);
    expect(session.body.totp).toEqual({ enabled: false, required: false });

    const setup = await post('/api/auth/totp/setup', { token: session.token }).send({});
    expect(setup.status).toBe(200);
    expect(setup.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\/MediChain/);
    const stored = await User.findById(user._id);
    expect(stored.totpEnabled).toBe(false);
    expect(stored.totpPendingEnc).not.toContain(setup.body.data.secret); // encrypted at rest

    expect((await post('/api/auth/totp/confirm', { token: session.token }).send({ code: '000000' })).status).toBe(400);
    const code = totpService.codeAt(setup.body.data.secret);
    const confirm = await post('/api/auth/totp/confirm', { token: session.token }).send({ code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.enabled).toBe(true);
    expect(await LedgerEntry.countDocuments({ chain: 'records', action: 'TOTP_ENROLLED' })).toBe(1);

    // high-risk login with the code just used to confirm: refused as a replay
    const codes = captureCodes();
    const ch = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: user.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(ch.body.data.totpRequired).toBe(true);
    const replay = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: ch.body.data.challengeId, otp: codes[0], totp: code });
    expect(replay.body.code).toBe('TOTP_REUSED');
  });

  test('replacing an authenticator needs a current code from it', async () => {
    const user = await createUser('patient');
    const session = await firstLogin(user);
    const secret = await enrolTotp(user._id);
    expect((await post('/api/auth/totp/setup', { token: session.token }).send({})).body.code).toBe('TOTP_CODE_REQUIRED');
    expect((await post('/api/auth/totp/setup', { token: session.token }).send({ currentCode: totpService.codeAt(secret) })).status).toBe(200);
  });

  test('no set-up in a session that is not fresh', async () => {
    const user = await createUser('patient');
    const session = await firstLogin(user);
    config.security.totpSetupFreshMinutes = -1; // every session is "too old"
    const res = await post('/api/auth/totp/setup', { token: session.token }).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOTP_SETUP_NOT_FRESH');
  });

  test('no set-up during an emergency session', async () => {
    const doctor = await createUser('doctor', { loginCount: 3 });
    const codes = captureCodes();
    const ch = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: doctor.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(ch.body.data.emergencyOnly).toBe(true);
    const em = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: ch.body.data.challengeId, otp: codes[0], emergencyReason: 'Cardiac arrest in ICU bed 4, need history' });
    expect(em.status).toBe(200);
    const res = await post('/api/auth/totp/setup', { ip: UK_IP, token: em.body.data.token }).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOTP_SETUP_NOT_ALLOWED');
  });

  test('emergency-only challenge: the emailed code without a reason is refused', async () => {
    const doctor = await createUser('doctor', { loginCount: 3 });
    const codes = captureCodes();
    const ch = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: doctor.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    const res = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: ch.body.data.challengeId, otp: codes[0] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('EMERGENCY_REASON_REQUIRED');
  });

  test('D1: staff without an authenticator are sent to set it up; the auth endpoints stay open', async () => {
    config.security.totpRequiredRoles = ['doctor', 'admin', 'insurance_agent'];
    const doctor = await createUser('doctor');
    const session = await firstLogin(doctor);
    expect(session.body.totp).toEqual({ enabled: false, required: true });
    const blocked = await get('/api/users/me', { token: session.token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TOTP_ENROLMENT_REQUIRED');
    expect((await get('/api/auth/totp/status', { token: session.token })).status).toBe(200);
    await enrolTotp(doctor._id);
    const { invalidateSession } = require('../../src/middleware/auth');
    await invalidateSession(doctor._id);
    expect((await get('/api/users/me', { token: session.token })).status).toBe(200);
  });

  test('an administrator can reset a lost authenticator; it is written to the ledger', async () => {
    const admin = await login(await createUser('admin'));
    const patient = await createUser('patient');
    await enrolTotp(patient._id);
    const res = await as(admin).post(`/api/admin/users/${patient._id}/reset-totp`);
    expect(res.status).toBe(200);
    expect((await User.findById(patient._id)).totpEnabled).toBe(false);
    expect(await LedgerEntry.countDocuments({ action: 'TOTP_RESET' })).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------- 3 */
describe('Problem 3: no readable IP address anywhere in the ledger', () => {
  test('sign-ins, requests and denials store only keyed hashes', async () => {
    const user = await createUser('patient');
    const session = await firstLogin(user);
    await get('/api/users/me', { token: session.token });
    await get('/api/users/me', { token: 'bad' });
    await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: user.email, password: 'Wr0ng!Pass', context: {} });
    const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
    const ipv6 = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i;
    const entries = await LedgerEntry.find({}).lean();
    expect(entries.length).toBeGreaterThan(2);
    entries.forEach((e) => {
      const text = JSON.stringify(e.meta || {});
      expect(text).not.toMatch(ipv4);
      expect(text).not.toMatch(ipv6);
      expect(text).not.toContain(HYDERABAD_IP);
    });
  });
});

/* -------------------------------------------------------------------------------------- 4-6 */
describe('Problems 4-6: gates and role thresholds on the live API', () => {
  test('insider at a ward computer (hospital network, duty, GPS agrees, NEW browser) gets a code, not password-only', async () => {
    const doctor = await createUser('doctor', { loginCount: 3 });
    config.context.hospitalNetworks = ['49.207.0.0/16'];
    const codes = captureCodes();
    const res = await post('/api/auth/login/dynamic').send({ email: doctor.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(res.body.data.assessment.score).toBe(85); // 35 + 10 + 20 + 20
    expect(res.body.data.mode).toBe('challenge');
    expect(res.body.data.assessment.gate).toBe('possession');
    expect(codes).toHaveLength(1);
  });

  test('profile static (baseline B1): even the best context needs the emailed code', async () => {
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    config.context.profile = 'static';
    captureCodes();
    const res = await post('/api/auth/login/dynamic', { cookies }).send({ password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(res.body.data.mode).toBe('challenge');
    expect(res.body.data.assessment.factors).toEqual(['password', 'otp']);
  });

  test('profile v3 (baseline B2): no possession gate, so the insider context (85 > 80) is password-only', async () => {
    const doctor = await createUser('doctor', { loginCount: 3 });
    config.context.hospitalNetworks = ['49.207.0.0/16'];
    config.context.profile = 'v3';
    const res = await post('/api/auth/login/dynamic').send({ email: doctor.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(res.body.data.mode).toBe('redirect');
    expect(res.body.data.assessment.thresholds).toEqual({ upper: 80, lower: 50 });
  });
});

/* -------------------------------------------------------------------------------------- 7-8 */
describe('Problems 7-8: sign-in time and context-bound refresh', () => {
  test('authTime is kept through refreshes', async () => {
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    const jwt = require('jsonwebtoken');
    const r1 = await post('/api/auth/refresh-token', { cookies }).send();
    expect(r1.status).toBe(200);
    const r2 = await post('/api/auth/refresh-token', { cookies: cookiesOf(r1) }).send();
    const before = jwt.decode(r1.body.data.token);
    const after = jwt.decode(r2.body.data.token);
    expect(after.authTime).toBe(before.authTime);
    expect(after.jti).not.toBe(before.jti);
  });

  test('refresh from another browser: 401 REAUTH_REQUIRED, and the token is revoked', async () => {
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    const res = await post('/api/auth/refresh-token', { cookies, ua: 'stolen-cookie-browser' }).send();
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'REAUTH_REQUIRED', reason: 'browser_changed' });
    expect((await post('/api/auth/refresh-token', { cookies }).send()).status).toBe(401); // revoked even for the owner
    expect(await LedgerEntry.countDocuments({ chain: 'access', entityType: 'session_refresh', action: 'DENY' })).toBe(1);
  });

  test('refresh from another network: 401 REAUTH_REQUIRED; the same /24 is fine', async () => {
    const user = await createUser('patient');
    const a = await firstLogin(user);
    expect((await post('/api/auth/refresh-token', { cookies: a.cookies, ip: '49.207.0.200' }).send()).status).toBe(200);
    const b = await firstLogin(await createUser('patient'));
    const moved = await post('/api/auth/refresh-token', { cookies: b.cookies, ip: OTHER_HYDERABAD_NET }).send();
    expect(moved.body).toMatchObject({ code: 'REAUTH_REQUIRED', reason: 'network_changed' });
  });

  test('a session cannot be refreshed past MAX_SESSION_HOURS', async () => {
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    config.security.maxSessionHours = 0;
    const res = await post('/api/auth/refresh-token', { cookies }).send();
    expect(res.body).toMatchObject({ code: 'REAUTH_REQUIRED', reason: 'max_session_age' });
  });
});

/* -------------------------------------------------------------------------------------- 10 */
describe('Problem 10: ledger heads anchored on the blockchain', () => {
  /** An in-memory stand-in for the contract: per chain, a list of (seq, headHash). */
  function fakeChain() {
    const heads = { access: [], records: [] };
    Object.defineProperty(blockchainService, 'enabled', { get: () => true, configurable: true });
    jest.spyOn(blockchainService, 'anchorLedgerHead').mockImplementation(async (chain, seq, headHash) => {
      const last = heads[chain][heads[chain].length - 1];
      if (last && seq <= last.seq) return { status: 'pending', error: 'seq must increase' };
      heads[chain].push({ seq, headHash });
      return { status: 'anchored', txHash: `0x${'a'.repeat(64)}`, blockNumber: heads[chain].length, gasUsed: 50000, latencyMs: 5 };
    });
    jest.spyOn(blockchainService, 'latestLedgerHead').mockImplementation(async (chain) => {
      const last = heads[chain][heads[chain].length - 1];
      return last ? { checked: true, exists: true, seq: last.seq, headHash: last.headHash, anchoredAt: new Date().toISOString() } : { checked: true, exists: false };
    });
    return heads;
  }
  afterEach(() => { delete blockchainService.enabled; });

  async function someAccessEntries(n = 6) {
    for (let i = 0; i < n; i += 1) {
      await ledgerService.append({ chain: 'access', entityType: 'access_decision', entityId: `GET /x/${i}`, action: i % 2 ? 'ALLOW' : 'DENY', meta: { reason: 'test' } });
    }
  }

  test('anchoring stores the head and verification matches', async () => {
    const heads = fakeChain();
    await someAccessEntries();
    const result = await anchorService.anchorHead('access');
    expect(result.status).toBe('anchored');
    expect(heads.access).toHaveLength(1);
    expect(await LedgerAnchor.countDocuments({ chain: 'access', status: 'anchored' })).toBe(1);
    expect(await ledgerService.verifyAnchor('access')).toMatchObject({ valid: true, anchored: true, anchoredSeq: 5 });
    expect((await anchorService.anchorHead('access')).status).toBe('up_to_date');
  });

  test('a consistent rewrite (all later hashes recomputed) passes the hash chain but fails the anchor', async () => {
    fakeChain();
    await someAccessEntries();
    await anchorService.anchorHead('access');
    const all = await LedgerEntry.find({ chain: 'access' }).sort({ seq: 1 }).lean();
    let previous = all[1].previousEntryHash;
    for (const entry of all.slice(1)) {
      const changed = { ...entry, previousEntryHash: previous, action: entry.seq === 1 ? 'DENY' : entry.action };
      changed.entryHash = ledgerService.computeEntryHash(changed);
      await LedgerEntry.collection.updateOne({ _id: entry._id }, { $set: { action: changed.action, previousEntryHash: changed.previousEntryHash, entryHash: changed.entryHash } });
      previous = changed.entryHash;
    }
    expect((await ledgerService.verifyChain('access')).valid).toBe(true); // the attack works against the hash chain alone
    expect(await ledgerService.verifyAnchor('access')).toMatchObject({ valid: false, problem: 'anchored_entry_changed' });
    expect((await anchorService.anchorHead('access')).status).toBe('up_to_date'); // nothing new to seal
    await someAccessEntries(1);
    expect((await anchorService.anchorHead('access')).status).toBe('refused'); // a tampered chain is never sealed
  });

  test('deleting the newest entries is detected once an anchor covered them', async () => {
    fakeChain();
    await someAccessEntries();
    await anchorService.anchorHead('access');
    const newest = await LedgerEntry.find({ chain: 'access' }).sort({ seq: -1 }).limit(2).lean();
    await LedgerEntry.collection.deleteMany({ _id: { $in: newest.map((e) => e._id) } });
    expect((await ledgerService.verifyChain('access')).valid).toBe(true);
    expect(await ledgerService.verifyAnchor('access')).toMatchObject({ valid: false, problem: 'anchored_entry_missing' });
  });

  test('the admin verify endpoint reports the anchors', async () => {
    fakeChain();
    const admin = await login(await createUser('admin'));
    await anchorService.anchorAll('manual');
    const res = await as(admin).get('/api/ledger/verify');
    expect(res.status).toBe(200);
    expect(res.body.data.anchors.map((a) => a.chain).sort()).toEqual(['access', 'records']);
  });

  test('without a configured chain nothing is anchored and nothing breaks', async () => {
    await someAccessEntries(2);
    const result = await anchorService.anchorHead('access');
    expect(result.status).toBe('disabled');
    expect((await ledgerService.verifyAnchor('access')).checked).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------- 12 */
describe('Problem 12: AUDIT_EVERY_REQUEST switch (experiment only)', () => {
  test('false skips the allow entry; denials are still written', async () => {
    const session = await login(await createUser('patient'));
    config.audit.everyRequest = false;
    const before = await LedgerEntry.countDocuments({ chain: 'access', entityType: 'access_decision', action: 'ALLOW' });
    await as(session).get('/api/users/me');
    expect(await LedgerEntry.countDocuments({ chain: 'access', entityType: 'access_decision', action: 'ALLOW' })).toBe(before);
    await request(app).get('/api/users/me').set('Authorization', 'Bearer nope');
    expect(await LedgerEntry.countDocuments({ chain: 'access', action: 'DENY' })).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------------------- 26 */
describe('Problem 26: staff roles must be held in the on-chain k-of-n registry', () => {
  let onChain;
  beforeEach(() => {
    onChain = new Map();
    Object.defineProperty(roleService, 'enabled', { get: () => true, configurable: true });
    jest.spyOn(roleService, 'hasRole').mockImplementation(async (userId, role) => onChain.get(String(userId)) === role);
  });
  afterEach(() => { delete roleService.enabled; });

  test('a doctor made in the database only (direct edit) is refused; after the on-chain grant it works', async () => {
    const doctorUser = await createUser('doctor');
    const doctor = await login(doctorUser);
    const refused = await as(doctor).get('/api/users/me');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ROLE_NOT_REGISTERED');
    onChain.set(doctorUser._id.toString(), 'doctor'); // k approvals reached on-chain
    expect((await as(doctor).get('/api/users/me')).status).toBe(200);
  });

  test('patients are not checked against the registry', async () => {
    const patient = await login(await createUser('patient'));
    expect((await as(patient).get('/api/users/me')).status).toBe(200);
  });

  test('emergency sign-in needs the on-chain role too', async () => {
    const doctor = await createUser('doctor', { loginCount: 3 });
    const res = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: doctor.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(res.body.code).toBe('TOTP_NOT_ENROLLED'); // not eligible for emergency: not in the registry
  });

  test('if the registry cannot be reached and nothing is cached, staff requests fail closed (503)', async () => {
    roleService.hasRole.mockRejectedValue(new Error('ROLE_REGISTRY_UNAVAILABLE'));
    const admin = await login(await createUser('admin'));
    const res = await as(admin).get('/api/users/me');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ROLE_REGISTRY_UNAVAILABLE');
  });
});
