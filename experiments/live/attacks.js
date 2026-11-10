/**
 * Problem 17 (experiment E2): attacks executed against the running API, for three
 * configurations of the SAME code: B1 static 2FA (CONTEXT_PROFILE=static), B2 Version 3
 * (CONTEXT_PROFILE=v3: 80/50, no gates, security question) and CARMA.
 *
 *   node attacks.js                 all scenarios, all profiles, 10 repetitions each
 *   node attacks.js --reps 50
 * Output: out/attacks.csv (one row per scenario x role x profile) and out/attacks_raw.csv.
 *
 * The attacker always knows the victim's password. Whether they also control the victim's
 * mailbox, device, cookie or a seen authenticator code is part of each scenario. A scenario
 * "succeeds" when the attacker obtains a session (an access token). Victims have an
 * authenticator app (TOTP) and, for the V3 baseline, a security question the attacker does
 * not know. Scenarios marked "code fix" test a fix that applies to every profile (refresh
 * binding, replay, downgrade, emergency rules); for them the "before" result is the
 * Version 3 behaviour from the code review, given in the "v3_code_before_fixes" column.
 */
const h = require('./harness');

const ROLES = ['patient', 'insurance_agent', 'doctor', 'admin'];
const PROFILES = ['static', 'v3', 'carma'];
const VICTIM_UA = 'VictimBrowser/1.0';
const ATTACKER_UA = 'AttackerBrowser/1.0';
const REASON = 'Cardiac arrest in ICU bed 4, need medication history now';
const { NETWORKS } = h;

/** Runs the dynamic login as an attacker and tries to finish it with what they have. */
async function attempt({ user, ip, ua = ATTACKER_UA, cookies = [], gps = null, mailbox = false, totpCode = null, tryEmergency = mailbox, forceEmergency = false }) {
  const res = await h.http('POST', '/api/auth/login/dynamic', { ip, ua, cookies, body: { email: user.email, password: h.PASSWORD, context: { gps } } });
  const d = res.body?.data;
  const tier = d?.assessment?.risk || (res.body?.code === 'TOTP_NOT_ENROLLED' ? 'high (refused)' : '');
  if (d?.mode === 'redirect') return { session: true, how: 'password only', tier };
  if (d?.mode !== 'challenge') return { session: false, how: res.body?.code || `HTTP ${res.status}`, tier };
  if (!mailbox) return { session: false, how: 'needs the emailed code', tier };
  const otp = h.codes.get(user.email);
  const body = { challengeId: d.challengeId, otp };
  if (forceEmergency || d.emergencyOnly || (d.emergencyAllowed && tryEmergency && !totpCode)) body.emergencyReason = REASON;
  else if (d.totpRequired) { if (!totpCode) return { session: false, how: 'needs the authenticator app', tier }; body.totp = totpCode; } else if (d.securityQuestion) body.securityAnswer = 'attacker guess';
  const done = await h.http('POST', '/api/auth/login/challenge', { ip, ua, cookies, body });
  if (done.status === 200) return { session: true, how: body.emergencyReason ? 'emergency sign-in (30 min, audited)' : 'code', tier };
  return { session: false, how: done.body?.code || `HTTP ${done.status}`, tier };
}

const SCENARIOS = [
  { id: 'S1', name: 'Stolen password, new browser, foreign IP, no mailbox', run: ({ user }) => attempt({ user, ip: NETWORKS.foreign }) },
  { id: 'S2', name: 'Stolen password + mailbox (phishing), new browser, foreign IP', run: ({ user }) => attempt({ user, ip: NETWORKS.foreign, mailbox: true }) },
  { id: 'S3', name: 'VPN exit in the victim\'s city + matching forged GPS, new browser, no mailbox', run: ({ user }) => attempt({ user, ip: NETWORKS.new, gps: h.gpsFor(NETWORKS.new, 'near') }) },
  { id: 'S4', name: 'Same as S3 + mailbox', run: ({ user }) => attempt({ user, ip: NETWORKS.new, gps: h.gpsFor(NETWORKS.new, 'near'), mailbox: true }) },
  { id: 'S5', name: 'Insider at a ward PC: hospital network, duty hours, GPS agrees, new browser, no mailbox', run: ({ user }) => attempt({ user, ip: NETWORKS.hospital, gps: h.gpsFor(NETWORKS.hospital, 'near') }) },
  { id: 'S6', name: 'Insider on the victim\'s home network (known), duty, GPS agrees, new browser, no mailbox', run: ({ user }) => attempt({ user, ip: NETWORKS.known, gps: h.gpsFor(NETWORKS.known, 'near') }) },
  { id: 'S7', name: 'Device cookie copied into another browser (different user-agent), new network', run: ({ user, device }) => attempt({ user, ip: NETWORKS.new, cookies: device, gps: h.gpsFor(NETWORKS.new, 'near') }) },
  { id: 'S8', name: 'Stolen laptop (cookie + same browser) + password, attacker\'s own network, GPS agrees', run: ({ user, device }) => attempt({ user, ip: NETWORKS.new, ua: VICTIM_UA, cookies: device, gps: h.gpsFor(NETWORKS.new, 'near') }) },
  { id: 'S9', name: 'Password guessing on the victim\'s own browser: 2 wrong guesses, then the right one', run: async ({ user, device }) => {
    for (let i = 0; i < 2; i += 1) await h.http('POST', '/api/auth/login/dynamic', { ip: NETWORKS.known, ua: VICTIM_UA, cookies: device, body: { email: user.email, password: `Guess!${i}x`, context: { gps: null } } });
    return attempt({ user, ip: NETWORKS.known, ua: VICTIM_UA, cookies: device, gps: h.gpsFor(NETWORKS.known, 'near') });
  } },
  { id: 'S10', name: 'Credential stuffing: 1 guess per account from a foreign IP, no mailbox', run: ({ user }) => attempt({ user, ip: NETWORKS.foreign, ua: 'python-requests/2.31' }) },
  { id: 'S11', name: 'Emailed-code guessing until lock-out (medium-tier challenge)', run: async ({ user }) => {
    const res = await h.http('POST', '/api/auth/login/dynamic', { ip: NETWORKS.new, ua: ATTACKER_UA, body: { email: user.email, password: h.PASSWORD, context: { gps: h.gpsFor(NETWORKS.new, 'near') } } });
    const d = res.body?.data;
    if (d?.mode === 'redirect') return { session: true, how: 'password only', tier: d.assessment.risk };
    if (d?.mode !== 'challenge') return { session: false, how: res.body?.code, tier: '' };
    const real = h.codes.get(user.email);
    for (let i = 0; i < 20; i += 1) {
      let guess = String(100000 + Math.floor(Math.random() * 900000));
      if (guess === real) guess = String(((Number(real) - 100000 + 1) % 900000) + 100000); // the attacker does not know it
      const r = await h.http('POST', '/api/auth/login/challenge', { ip: NETWORKS.new, ua: ATTACKER_UA, body: { challengeId: d.challengeId, otp: guess, totp: d.totpRequired ? '000000' : undefined } });
      if (r.status === 200) return { session: true, how: `guessed after ${i + 1}`, tier: d.assessment.risk };
      if (['ACCOUNT_LOCKED', 'CHALLENGE_EXPIRED', 'TOO_MANY_REQUESTS'].includes(r.body?.code)) return { session: false, how: `${r.body.code} after ${i + 1} guesses`, tier: d.assessment.risk };
    }
    return { session: false, how: '20 wrong guesses', tier: d.assessment.risk };
  } },
  { id: 'S12', name: 'Authenticator code seen over the shoulder, reused at once (+ mailbox), foreign IP', fix: true, v3: 'n/a (no TOTP in V3)', run: async ({ user, secret }) => {
    const seen = h.api.totpService.codeAt(secret);
    // the victim uses the code first (a high-risk sign-in of their own)
    await h.api.User.updateOne({ _id: user._id }, { $set: { totpLastStep: h.api.totpService.stepAt() } });
    return attempt({ user, ip: NETWORKS.foreign, gps: h.gpsFor(NETWORKS.foreign, 'far'), mailbox: true, totpCode: seen, tryEmergency: false });
  } },
  { id: 'S13', name: 'Replay of a rotated (already used) refresh token', fix: true, v3: 'blocked (rotation existed)', run: async ({ session }) => {
    const r1 = await h.http('POST', '/api/auth/refresh-token', { ip: NETWORKS.known, ua: VICTIM_UA, cookies: session.cookies });
    if (r1.status !== 200) return { session: false, how: `victim refresh failed ${r1.body?.code}`, tier: '' };
    const replay = await h.http('POST', '/api/auth/refresh-token', { ip: NETWORKS.known, ua: VICTIM_UA, cookies: session.cookies });
    return { session: replay.status === 200, how: replay.body?.code || 'refreshed', tier: '' };
  } },
  { id: 'S14', name: 'Stolen refresh cookie used from another network and browser', fix: true, v3: 'succeeded (no binding before Problem 8)', run: async ({ session }) => {
    const r = await h.http('POST', '/api/auth/refresh-token', { ip: NETWORKS.foreign, ua: ATTACKER_UA, cookies: session.cookies });
    return { session: r.status === 200, how: r.body?.code || 'refreshed', tier: '' };
  } },
  { id: 'S15', name: 'Emergency claim (+ mailbox) by a patient or a doctor awaiting verification', fix: true, v3: 'unverified doctor succeeded (Problem 9)', run: async ({ user, role }) => {
    if (role === 'doctor') await h.api.User.updateOne({ _id: user._id }, { $set: { approvalStatus: 'pending' } });
    const out = await attempt({ user, ip: NETWORKS.foreign, gps: h.gpsFor(NETWORKS.foreign, 'far'), mailbox: true, forceEmergency: true });
    if (role === 'doctor') await h.api.User.updateOne({ _id: user._id }, { $set: { approvalStatus: 'approved' } });
    return out;
  }, roles: ['patient', 'doctor'] },
  { id: 'S16', name: 'Downgrade to the bootstrap endpoints (password + mailbox)', fix: true, v3: 'succeeded and made the browser trusted (Problem 1)', run: async ({ user }) => {
    const r1 = await h.http('POST', '/api/auth/login/request-otp', { ip: NETWORKS.foreign, ua: ATTACKER_UA, body: { email: user.email, password: h.PASSWORD } });
    if (r1.status !== 200) return { session: false, how: r1.body?.code, tier: '' };
    const r2 = await h.http('POST', '/api/auth/login/verify-otp', { ip: NETWORKS.foreign, ua: ATTACKER_UA, body: { email: user.email, otp: h.codes.get(user.email) } });
    return { session: r2.status === 200, how: r2.body?.code || 'session', tier: '' };
  } },
];

async function main() {
  const a = h.args();
  const reps = Number(a.reps || 10);
  await h.start();
  h.api.config.context.hospitalNetworks = ['49.207.0.0/24'];
  h.setDuty(true);

  const victims = {};
  for (const role of ROLES) {
    const user = await h.createUser(role, { securityQuestion: 'In which city were you born?', securityAnswerHash: 'Mangaluru' });
    const first = await h.firstLogin(user, { ip: NETWORKS.known, ua: VICTIM_UA });
    const secret = await h.enrolTotp(user._id);
    victims[role] = { user, role, secret, device: first.cookies.filter((c) => c.startsWith('mcDevice=')), snap: await h.snapshot(user._id) };
  }

  const raw = [];
  const summary = [];
  for (const sc of SCENARIOS) {
    for (const profile of (sc.fix ? ['carma'] : PROFILES)) {
      h.api.config.context.profile = profile;
      for (const role of (sc.roles || ROLES)) {
        const v = victims[role];
        let wins = 0;
        const hows = {};
        let tier = '';
        for (let r = 0; r < reps; r += 1) {
          await h.restore(v.user._id, v.snap);
          const session = sc.id === 'S13' || sc.id === 'S14' ? await h.firstLoginAgain(v) : null;
          const out = await sc.run({ ...v, session });
          wins += out.session ? 1 : 0;
          hows[out.how] = (hows[out.how] || 0) + 1;
          tier = out.tier || tier;
          raw.push({ scenario: sc.id, profile, role, rep: r, session: out.session, how: out.how, tier: out.tier });
        }
        summary.push({ scenario: sc.id, description: sc.name, profile, role, tier, success_rate: (wins / reps).toFixed(2),
          outcome: Object.entries(hows).map(([k, n]) => `${k} (${n})`).join('; '), v3_code_before_fixes: sc.v3 || '' });
      }
    }
    console.log(`${sc.id} done`);
  }
  h.writeCsv(`${h.OUT}/attacks.csv`, summary);
  h.writeCsv(`${h.OUT}/attacks_raw.csv`, raw);
  console.log(`\nWritten to ${h.OUT}/attacks.csv. Send me that file.`);
  await h.stop();
}

/** A fresh, legitimate session of the victim from their usual place (for the refresh-token scenarios). */
h.firstLoginAgain = async (v) => {
  h.api.config.context.profile = 'carma';
  const res = await h.http('POST', '/api/auth/login/dynamic', { ip: NETWORKS.known, ua: VICTIM_UA, cookies: v.device, body: { email: v.user.email, password: h.PASSWORD, context: { gps: h.gpsFor(NETWORKS.known, 'near') } } });
  if (res.body?.data?.mode !== 'redirect') throw new Error(`victim could not sign in: ${JSON.stringify(res.body).slice(0, 200)}`);
  return { cookies: res.cookies.filter((c) => c.startsWith('refreshToken=')), token: res.body.data.token };
};

main().catch(async (e) => { console.error(e); await h.stop(); process.exit(1); });
