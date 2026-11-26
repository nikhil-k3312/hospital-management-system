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
const contextService = require('../../src/services/contextService');

const HYDERABAD_IP = '49.207.0.1';
const OTHER_HYDERABAD_NET = '49.207.9.1';
const UK_IP = '81.2.69.142';
const GPS_HYDERABAD = { lat: 17.39, lon: 78.49 };
/** A browser position that agrees with where GeoIP places an address (no assumption about the city). */
const gpsAt = (ip) => { const g = contextService.lookupGeo(ip); return g ? { lat: g.lat, lon: g.lon } : null; };
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

    // verify-otp has no password check, so it answers exactly like a wrong code (nothing revealed)
    const req2 = await post('/api/auth/login/verify-otp').send({ email: user.email, otp: '123456' });
    const unknown = await post('/api/auth/login/verify-otp').send({ email: 'nobody@example.com', otp: '123456' });
    expect(req2.status).toBe(401);
    expect(req2.body).toMatchObject({ code: 'INVALID_OTP', message: unknown.body.message });
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

  test('review issue 2: a session proven only with password + emailed code on a NEW browser cannot set up an app', async () => {
    const user = await createUser('patient');
    await firstLogin(user); // bootstrap browser: 'jest' from Hyderabad
    // attacker: other browser, VPN exit in the same city with a matching GPS -> 70, medium (possession gate)
    const codes = captureCodes();
    const ch = await post('/api/auth/login/dynamic', { ip: OTHER_HYDERABAD_NET, ua: 'attacker-browser' }).send({ email: user.email, password: PASSWORD, context: { gps: gpsAt(OTHER_HYDERABAD_NET) } });
    expect(ch.body.data.assessment.risk).toBe('medium');
    const done = await post('/api/auth/login/challenge', { ip: OTHER_HYDERABAD_NET, ua: 'attacker-browser' }).send({ challengeId: ch.body.data.challengeId, otp: codes[0] });
    expect(done.status).toBe(200);
    const setup = await post('/api/auth/totp/setup', { ip: OTHER_HYDERABAD_NET, ua: 'attacker-browser', token: done.body.data.token }).send({});
    expect(setup.status).toBe(403);
    expect(setup.body.code).toBe('TOTP_SETUP_NOT_TRUSTED');

    // the same attacker browser is now trusted ('otp'), but still may not set up an app at the next sign-in
    const again = await post('/api/auth/login/dynamic', { ip: OTHER_HYDERABAD_NET, ua: 'attacker-browser', cookies: cookiesOf(done) })
      .send({ password: PASSWORD, context: { gps: gpsAt(OTHER_HYDERABAD_NET) } });
    expect(again.body.data.mode).toBe('redirect');
    expect((await post('/api/auth/totp/setup', { ip: OTHER_HYDERABAD_NET, ua: 'attacker-browser', token: again.body.data.token }).send({})).body.code).toBe('TOTP_SETUP_NOT_TRUSTED');
  });

  test('the browser of the first login may set up the app later, and the owner is told by email', async () => {
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    const login2 = await post('/api/auth/login/dynamic', { cookies }).send({ password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(login2.body.data.mode).toBe('redirect');
    const notice = jest.spyOn(emailService, 'sendSecurityNotice').mockImplementation(async () => null);
    const setup = await post('/api/auth/totp/setup', { token: login2.body.data.token }).send({});
    expect(setup.status).toBe(200);
    expect((await post('/api/auth/totp/confirm', { token: login2.body.data.token }).send({ code: totpService.codeAt(setup.body.data.secret) })).status).toBe(200);
    expect(notice).toHaveBeenCalledWith(user.email, expect.any(String), expect.stringContaining('authenticator app was set up'));
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
    const after = await User.findById(patient._id);
    expect(after.totpEnabled).toBe(false);
    expect(after.totpEnrolAllowedUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000); // one set-up allowed for 24 h
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
    // a scored sign-in (after the first login) writes a login_context entry with the network hash
    captureCodes(); // the emailed code is not needed; the mock is restored after each test
    await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: user.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(await LedgerEntry.countDocuments({ chain: 'access', entityType: 'login_context' })).toBeGreaterThan(0);
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

  test('review issue 6: a changed network continues silently when the new context is low risk', async () => {
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    // new network, trusted browser, GPS agrees with the new IP: 35 + 25 + 20 + 5 = 85 -> low
    const gps = gpsAt(OTHER_HYDERABAD_NET);
    expect(gps).not.toBeNull(); // the test needs GeoIP to know this address
    const ok = await post('/api/auth/refresh-token', { cookies, ip: OTHER_HYDERABAD_NET }).send({ context: { gps } });
    expect(ok.status).toBe(200);
    const entry = await LedgerEntry.findOne({ chain: 'access', entityType: 'session_refresh', 'meta.reason': 'network_changed_rescored' }).lean();
    expect(entry).toMatchObject({ action: 'ALLOW', meta: { risk: 'low' } });
    // the new token is bound to the new network: refreshing from there works without another check
    expect((await post('/api/auth/refresh-token', { cookies: cookiesOf(ok), ip: OTHER_HYDERABAD_NET }).send()).status).toBe(200);
  });

  test('REFRESH_ON_NETWORK_CHANGE=reauth always asks for a new sign-in', async () => {
    config.context.refreshOnNetworkChange = 'reauth';
    const user = await createUser('patient');
    const { cookies } = await firstLogin(user);
    const res = await post('/api/auth/refresh-token', { cookies, ip: OTHER_HYDERABAD_NET }).send({ context: { gps: GPS_HYDERABAD } });
    expect(res.body).toMatchObject({ code: 'REAUTH_REQUIRED', reason: 'network_changed' });
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
    jest.spyOn(blockchainService, 'ledgerHeads').mockImplementation(async (chain) => ({ checked: true, heads: heads[chain].map((h) => ({ ...h, anchoredAt: new Date().toISOString() })) }));
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
    await createUser('admin'); // the tampering alert goes to every active administrator
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
    const Notification = require('../../src/models/Notification');
    await new Promise((r) => setTimeout(r, 50)); // the alert is written without blocking anchoring
    expect(await Notification.countDocuments({ title: 'Ledger tampering detected' })).toBeGreaterThan(0);

    // review issue 1: deleting the server's own anchor records does not help the insider, because
    // the starting point is read from the contract
    await LedgerAnchor.deleteMany({});
    await someAccessEntries(1);
    expect((await anchorService.anchorHead('access')).status).toBe('refused');
    expect(await ledgerService.verifyAnchor('access')).toMatchObject({ valid: false, brokenAtSeq: 5 });
  });

  test('every anchored head is checked, not only the newest', async () => {
    const heads = fakeChain();
    await someAccessEntries(3);
    await anchorService.anchorHead('access'); // head #2
    await someAccessEntries(3);
    await anchorService.anchorHead('access'); // head #5
    expect(heads.access.map((h) => h.seq)).toEqual([2, 5]);
    // pretend the newest head itself was forged to match a rewritten chain: the older head still exposes it
    heads.access[0].headHash = 'f'.repeat(64);
    expect(await ledgerService.verifyAnchor('access')).toMatchObject({ valid: false, problem: 'anchored_entry_changed', brokenAtSeq: 2 });
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

/* ------------------------------------------------------------------- D12: emergency reviews */
describe('D12: every emergency sign-in becomes a case that k of n administrators close on-chain', () => {
  const emergencyService = require('../../src/services/emergencyReviewService');
  const EmergencyCase = require('../../src/models/EmergencyCase');
  const { RoleService } = require('../../src/services/roleService');
  const { sha256 } = require('../../src/utils/hash');
  const { ethers } = require('ethers');
  const REASON = 'Cardiac arrest in ICU bed 4, need history';

  async function emergencySignIn() {
    const doctor = await createUser('doctor', { loginCount: 3 });
    const codes = captureCodes();
    const ch = await post('/api/auth/login/dynamic', { ip: UK_IP }).send({ email: doctor.email, password: PASSWORD, context: { gps: GPS_HYDERABAD } });
    expect(ch.body.data.emergencyOnly).toBe(true);
    const em = await post('/api/auth/login/challenge', { ip: UK_IP }).send({ challengeId: ch.body.data.challengeId, otp: codes[0], emergencyReason: REASON });
    expect(em.status).toBe(200);
    return doctor;
  }
  /** A stand-in for the contract: the hospital key opens cases, k = 2 of 3. */
  function fakeContract({ reachable = true } = {}) {
    Object.defineProperty(emergencyService, 'enabled', { get: () => true, configurable: true });
    const opened = new Map();
    const openCase = jest.fn(async (caseId, subject, reasonHash) => {
      if (!reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
      opened.set(caseId, { subject, reasonHash });
      return { wait: async () => ({ hash: `0x${'b'.repeat(64)}` }) };
    });
    jest.spyOn(emergencyService, 'writeContract').mockImplementation(() => ({ openCase }));
    jest.spyOn(emergencyService, 'status').mockResolvedValue({ enabled: true, address: `0x${'c'.repeat(40)}`, chainId: 1337, threshold: 2, governorCount: 3, governorEpoch: 0 });
    jest.spyOn(emergencyService, 'onChain').mockImplementation(async (caseId) => (opened.has(caseId)
      ? { recorded: true, verdict: null, justifiedVotes: 1, misuseVotes: 0, epoch: 0, closedAt: null, reasonHash: opened.get(caseId).reasonHash }
      : { recorded: false }));
    return { openCase, opened, setReachable: (v) => { reachable = v; } };
  }
  afterEach(() => { delete emergencyService.enabled; });
  const settle = () => new Promise((r) => setTimeout(r, 50)); // the on-chain write runs in the background

  test('the case is linked to the ledger entry of the sign-in and holds only hashes', async () => {
    const doctor = await emergencySignIn();
    const entry = await LedgerEntry.findOne({ chain: 'access', entityType: 'login_context', 'meta.reason': 'emergency_login' }).lean();
    const c = await EmergencyCase.findOne({ user: doctor._id }).lean();
    expect(c).toMatchObject({ caseId: `0x${entry.entryHash}`, ledgerSeq: entry.seq, reason: REASON, reasonHash: `0x${sha256(REASON)}`, chainStatus: 'disabled' });
    const salt = (await User.findById(doctor._id).lean()).roleSalt;
    expect(c.subject).toBe(RoleService.subjectOf(doctor._id.toString(), salt)); // salted, as in the RoleRegistry
  });

  test('with the contract: the hospital key opens the case on-chain; the admin page lists it', async () => {
    const chain = fakeContract();
    const doctor = await emergencySignIn();
    await settle();
    const c = await EmergencyCase.findOne({ user: doctor._id }).lean();
    expect(c.chainStatus).toBe('recorded');
    expect(chain.openCase).toHaveBeenCalledWith(c.caseId, c.subject, c.reasonHash);

    const admin = await login(await createUser('admin'));
    const list = await as(admin).get('/api/admin/emergency-reviews');
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ enabled: true, threshold: 2 });
    expect(list.body.data.cases[0]).toMatchObject({ caseId: c.caseId, reasonIntact: true, onChain: { recorded: true, verdict: null } });
  });

  test("the verdict transaction is built for the administrator's own wallet and encodes exactly that case and verdict", async () => {
    fakeContract();
    await emergencySignIn();
    await settle();
    const c = await EmergencyCase.findOne().lean();
    const admin = await login(await createUser('admin'));
    const res = await as(admin).post(`/api/admin/emergency-reviews/${c.caseId}/review`).send({ verdict: 'misuse' });
    expect(res.status).toBe(200);
    const decoded = new ethers.Interface(['function review(bytes32 caseId, uint8 verdict)']).decodeFunctionData('review', res.body.data.tx.data);
    expect(decoded.caseId).toBe(c.caseId);
    expect(Number(decoded.verdict)).toBe(2); // misuse
    expect(res.body.data.verify).toMatchObject({ caseId: c.caseId, verdict: 'misuse' });
    const bad = await as(admin).post(`/api/admin/emergency-reviews/${c.caseId}/review`).send({ verdict: 'close' });
    expect(bad.status).toBe(400);
  });

  test('a changed reason text in the database is flagged (the chain holds the original hash)', async () => {
    fakeContract();
    await emergencySignIn();
    await settle();
    await EmergencyCase.collection.updateOne({}, { $set: { reason: 'Routine check', reasonHash: `0x${sha256('Routine check')}` } });
    const admin = await login(await createUser('admin'));
    const list = await as(admin).get('/api/admin/emergency-reviews');
    expect(list.body.data.cases[0].reasonIntact).toBe(false);
  });

  test('chain down: the sign-in still works, the case waits, and the retry puts it on-chain', async () => {
    const chain = fakeContract({ reachable: false });
    const doctor = await emergencySignIn();
    await settle();
    expect((await EmergencyCase.findOne({ user: doctor._id }).lean()).chainStatus).toBe('pending');
    const admin = await login(await createUser('admin'));
    const early = await as(admin).post(`/api/admin/emergency-reviews/${(await EmergencyCase.findOne().lean()).caseId}/review`).send({ verdict: 'justified' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('CASE_PENDING');
    chain.setReachable(true);
    expect(await emergencyService.retryPending()).toEqual({ retried: 1, recorded: 1 });
    expect((await EmergencyCase.findOne({ user: doctor._id }).lean()).chainStatus).toBe('recorded');
  });

  test('only administrators see and review cases', async () => {
    await emergencySignIn();
    const doctor = await login(await createUser('doctor'));
    expect((await as(doctor).get('/api/admin/emergency-reviews')).status).toBe(403);
  });
});
