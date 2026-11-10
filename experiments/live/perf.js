/**
 * Problem 18 (experiment E3): latency and throughput, measured on your laptop.
 *
 *   npm install           (in backend/services/api: installs autocannon, a dev dependency)
 *   node perf.js                         full run (about 25 minutes)
 *   node perf.js --quick                 one repetition, 5 s per point (a few minutes)
 *
 * Measures
 *   1. contextService.assess() alone, 10,000 calls (the cost of the trust score itself)
 *   2. over HTTP, at 1, 10, 50 and 100 concurrent clients, 3 repetitions x 10 s:
 *        GET  /api/users/me              protected request, audit write ON and OFF (Problem 12)
 *        POST /api/auth/login/dynamic    low tier (trusted browser, password only)
 *        POST /api/auth/login/dynamic    medium tier (new browser: code e-mailed, step 1 only)
 *        POST /api/auth/login/dynamic    baseline B1 static 2FA (step 1 only)
 * Output: out/perf.csv, out/perf_environment.json. Send me both.
 * Close other heavy programs while it runs; keep the laptop on mains power.
 */
const os = require('os');
const fs = require('fs');
const h = require('./harness');

async function main() {
  const a = h.args();
  const quick = Boolean(a.quick);
  const autocannon = h.api.require('autocannon');
  const LEVELS = quick ? [1, 10, 50] : [1, 10, 50, 100];
  const REPS = quick ? 1 : 3;
  const DURATION = quick ? 5 : 10;

  const url = await h.start();
  const cfg = h.api.config;
  cfg.context.hospitalNetworks = ['49.207.0.0/24'];
  h.setDuty(true);
  cfg.otp.maxAttempts = 1e9; // the medium tier sends a code on every request
  cfg.security.maxFailedLogins = 1e9;

  // 1. the trust score alone
  const user = await h.createUser('doctor');
  const first = await h.firstLogin(user, { ip: h.NETWORKS.known, ua: 'Perf/1.0' });
  const fresh = await h.api.User.findById(user._id);
  const req = { ip: h.NETWORKS.known, get: () => 'Perf/1.0' };
  const gps = h.gpsFor(h.NETWORKS.known, 'near');
  for (let i = 0; i < 1000; i += 1) h.api.contextService.assess({ req, user: fresh, deviceKnown: true, gps }); // warm-up
  const N = 10000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) h.api.contextService.assess({ req, user: fresh, deviceKnown: true, gps });
  const assessUs = Number(process.hrtime.bigint() - t0) / 1e3 / N;
  console.log(`assess(): ${assessUs.toFixed(2)} microseconds per call`);

  const deviceCookie = first.cookies.filter((c) => c.startsWith('mcDevice='));
  const token = first.token; // valid 15 minutes; refreshed below when needed

  // One account per connection for the login endpoints: real users do not sign in to the same
  // account 100 times in parallel, and parallel saves of one account would collide.
  const POOL = Math.max(...LEVELS);
  const pool = [];
  for (let i = 0; i < POOL; i += 1) {
    const u = await h.createUser(i % 2 ? 'patient' : 'doctor');
    const f = await h.firstLogin(u, { ip: h.NETWORKS.known, ua: 'Perf/1.0' });
    pool.push({ email: u.email, cookie: f.cookies.filter((c) => c.startsWith('mcDevice=')).join('; ') });
  }
  console.log(`${POOL} accounts ready`);

  const headers = (extra = {}) => ({ 'X-Forwarded-For': h.NETWORKS.known, 'User-Agent': 'Perf/1.0', 'Content-Type': 'application/json', ...extra });
  const loginBody = (email, gpsPos) => JSON.stringify({ email, password: h.PASSWORD, context: { gps: gpsPos } });
  let currentToken = token;
  /** autocannon setupClient: every connection signs in to its own account of the pool. */
  const perClient = (withCookie, ip) => {
    let next = 0;
    return (client) => {
      const acct = pool[next % pool.length];
      next += 1;
      client.setHeaders(headers({ 'X-Forwarded-For': ip, ...(withCookie ? { Cookie: acct.cookie } : {}) }));
      client.setBody(loginBody(acct.email, gps)); // GPS agrees: new browser -> 35+10+20+5 = 70, medium for every role
    };
  };
  const endpoints = [
    { name: 'GET /api/users/me (audit on)', before: () => { cfg.audit.everyRequest = true; }, opts: () => ({ method: 'GET', path: '/api/users/me', headers: headers({ Authorization: `Bearer ${currentToken}` }) }) },
    { name: 'GET /api/users/me (audit off)', before: () => { cfg.audit.everyRequest = false; }, opts: () => ({ method: 'GET', path: '/api/users/me', headers: headers({ Authorization: `Bearer ${currentToken}` }) }) },
    { name: 'login, low tier (password only)', before: () => { cfg.audit.everyRequest = true; cfg.context.profile = 'carma'; },
      opts: () => ({ method: 'POST', path: '/api/auth/login/dynamic', setupClient: perClient(true, h.NETWORKS.known) }) },
    { name: 'login, medium tier (step 1: code e-mailed)', before: () => { cfg.context.profile = 'carma'; },
      opts: () => ({ method: 'POST', path: '/api/auth/login/dynamic', setupClient: perClient(false, h.NETWORKS.new) }) },
    { name: 'login, B1 static 2FA (step 1: code e-mailed)', before: () => { cfg.context.profile = 'static'; },
      opts: () => ({ method: 'POST', path: '/api/auth/login/dynamic', setupClient: perClient(true, h.NETWORKS.known) }) },
  ];

  const rows = [];
  for (const ep of endpoints) {
    for (const connections of LEVELS) {
      for (let rep = 0; rep < REPS; rep += 1) {
        // a new access token for each run, so none expires during a measurement
        const refreshed = await h.firstLoginFresh(user, deviceCookie, gps);
        currentToken = refreshed || currentToken;
        ep.before();
        const r = await autocannon({ url, connections, duration: DURATION, ...ep.opts() });
        const errors = r.errors + r.timeouts + (r.non2xx || 0);
        rows.push({ endpoint: ep.name, connections, rep, requests_per_s: r.requests.average.toFixed(1), latency_mean_ms: r.latency.average.toFixed(2),
          latency_p50_ms: r.latency.p50, latency_p90_ms: r.latency.p90, latency_p97_5_ms: r.latency.p97_5, latency_p99_ms: r.latency.p99,
          latency_max_ms: r.latency.max, total_requests: r.requests.total, errors_or_non2xx: errors });
        console.log(`${ep.name.padEnd(46)} c=${String(connections).padStart(3)} rep ${rep}: ${r.requests.average.toFixed(0)} req/s, mean ${r.latency.average.toFixed(1)} ms, p99 ${r.latency.p99} ms${errors ? `, ${errors} errors/non-2xx` : ''}`);
      }
    }
  }
  cfg.audit.everyRequest = true;
  cfg.context.profile = 'carma';

  h.writeCsv(`${h.OUT}/perf.csv`, rows);
  const mongoVersion = (await h.api.mongoose.connection.db.admin().serverInfo()).version;
  const redisInfo = await h.api.redis.info('server');
  fs.writeFileSync(`${h.OUT}/perf_environment.json`, JSON.stringify({
    cpu: os.cpus()[0].model, cores: os.cpus().length, memoryGB: (os.totalmem() / 2 ** 30).toFixed(1), platform: `${os.type()} ${os.release()}`,
    node: process.version, mongodb: mongoVersion, redis: (redisInfo.match(/redis_version:(\S+)/) || [])[1], assessMicroseconds: Number(assessUs.toFixed(2)),
    connections: LEVELS, repetitions: REPS, durationSeconds: DURATION, date: new Date().toISOString(),
  }, null, 2));
  console.log(`\nWritten to ${h.OUT}/perf.csv and perf_environment.json`);
  await h.stop();
}

/** Signs the doctor in again on the trusted browser to get a fresh access token. */
h.firstLoginFresh = async (user, deviceCookie, gps) => {
  const prev = h.api.config.context.profile;
  h.api.config.context.profile = 'carma';
  const res = await h.http('POST', '/api/auth/login/dynamic', { ip: h.NETWORKS.known, ua: 'Perf/1.0', cookies: deviceCookie, body: { email: user.email, password: h.PASSWORD, context: { gps } } });
  h.api.config.context.profile = prev;
  return res.body?.data?.token || null;
};

main().catch(async (e) => { console.error(e); await h.stop(); process.exit(1); });
