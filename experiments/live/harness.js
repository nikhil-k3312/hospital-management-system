/**
 * Shared harness for the live experiments (Problems 16-19).
 *
 * Starts the REAL MediChain API (same code, Express, MongoDB, Redis) on a free local port and
 * talks to it over HTTP. It uses its own database and Redis index, so your development data is
 * never touched:
 *   EXPERIMENT_MONGODB_URI   default mongodb://127.0.0.1:27017/medichain_experiments (wiped at start)
 *   EXPERIMENT_REDIS_DB      default 14 (flushed at start)
 * Emails are not sent: the one-time codes are captured in memory.
 * Requests come from localhost with an X-Forwarded-For header, which the API trusts only from
 * localhost ("trust proxy: loopback"), so each experiment can choose the client network.
 */
const path = require('path');
const { createRequire } = require('module');

const API_DIR = path.join(__dirname, '../../backend/services/api');
const apiRequire = createRequire(path.join(API_DIR, 'package.json'));

// Settings must be in place before the API's config module is loaded.
process.env.NODE_ENV = 'test'; // quiet logs, no rate limiting (the experiments send many requests)
process.env.MONGODB_URI = process.env.EXPERIMENT_MONGODB_URI || 'mongodb://127.0.0.1:27017/medichain_experiments';
process.env.REDIS_DB = process.env.EXPERIMENT_REDIS_DB || '14';
process.env.EMAIL_TRANSPORT = 'json';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'experiment-access-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'experiment-refresh-secret-fedcba9876543210fedcba98';
process.env.IP_HASH_SECRET = process.env.IP_HASH_SECRET || 'experiment-ip-hash-secret-0123456789abcdef0123';
process.env.TOTP_REQUIRED_ROLES = process.env.TOTP_REQUIRED_ROLES ?? '';
process.env.LEDGER_ANCHORING = 'false'; // chain_cost.js anchors explicitly

const api = {
  config: apiRequire('./src/config/config'),
  app: null,
  User: apiRequire('./src/models/User'),
  LedgerEntry: apiRequire('./src/models/LedgerEntry'),
  emailService: apiRequire('./src/services/emailService'),
  contextService: apiRequire('./src/services/contextService'),
  totpService: apiRequire('./src/services/totpService'),
  ledgerService: apiRequire('./src/services/ledgerService'),
  redis: apiRequire('./src/db/redis'),
  mongo: apiRequire('./src/db/mongo'),
  mongoose: apiRequire('mongoose'),
  require: apiRequire,
};

const PASSWORD = 'Exp3riment!Pass';
const codes = new Map(); // email -> last emailed code
let server = null;
let baseUrl = '';

async function start() {
  await api.mongo.connectMongo();
  await api.redis.connectRedis();
  await api.mongoose.connection.db.dropDatabase();
  await api.redis.flushDb();
  await Promise.all(Object.values(api.mongoose.models).map((m) => m.syncIndexes()));
  await apiRequire('./src/models/HospitalSettings').create({ key: 'hospital', insuranceProviders: ['Star Health'], departments: ['Cardiology'] });
  api.emailService.sendOTP = async (email, code) => { codes.set(email, code); };
  api.emailService.sendWelcome = () => {};
  api.app = apiRequire('./src/app');
  await new Promise((resolve) => { server = api.app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stop() {
  if (server) await new Promise((r) => server.close(r));
  await Promise.allSettled([api.mongo.disconnectMongo(), api.redis.disconnectRedis()]);
}

/** Cookies from Set-Cookie headers as "name=value" strings (replaces same-name cookies). */
function mergeCookies(jar, response) {
  const set = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const map = new Map(jar.map((c) => [c.split('=')[0], c]));
  set.forEach((c) => { const pair = c.split(';')[0]; map.set(pair.split('=')[0], pair); });
  return [...map.values()].filter((c) => c.split('=')[1] !== '');
}

/**
 * One HTTP request. Returns { status, body, cookies, ms }.
 *   ip       client address (X-Forwarded-For)     ua      User-Agent
 *   cookies  ["name=value", ...] to send            token   Bearer access token
 */
async function http(method, url, { ip = '49.207.5.10', ua = 'Experiment/1.0', cookies = [], token, body } = {}) {
  const headers = { 'User-Agent': ua, 'X-Forwarded-For': ip };
  if (cookies.length) headers.Cookie = cookies.join('; ');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const started = process.hrtime.bigint();
  const res = await fetch(baseUrl + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
  return { status: res.status, body: parsed, cookies: mergeCookies(cookies, res), ms };
}

let counter = 0;
/** Creates an approved account directly in the database (like the test helper). */
async function createUser(role, extra = {}) {
  counter += 1;
  const user = new api.User({
    email: `${role}${counter}@experiment.local`, fullName: `${role} ${counter}`, passwordHash: PASSWORD, role, approvalStatus: 'approved', ...extra,
  });
  if (role === 'doctor') Object.assign(user.doctorProfile, { specialization: 'Cardiology', licenseNumber: `LIC-${counter}` });
  if (role === 'insurance_agent') user.agentProfile = { company: 'Star Health' };
  await user.save();
  return user;
}

/** First (bootstrap) login from a given network and browser: makes the browser trusted and the network known. */
async function firstLogin(user, { ip, ua }) {
  const step1 = await http('POST', '/api/auth/login/dynamic', { ip, ua, body: { email: user.email, password: PASSWORD, context: { gps: null } } });
  if (step1.body?.data?.mode !== 'otp') throw new Error(`first login of ${user.email}: ${JSON.stringify(step1.body)}`);
  const step2 = await http('POST', '/api/auth/login/verify-otp', { ip, ua, body: { email: user.email, otp: codes.get(user.email) } });
  if (step2.status !== 200) throw new Error(`verify-otp of ${user.email}: ${JSON.stringify(step2.body)}`);
  return { cookies: step2.cookies, token: step2.body.data.token };
}

async function enrolTotp(userId) {
  const secret = api.totpService.newSecret();
  await api.User.updateOne({ _id: userId }, { $set: { totpEnabled: true, totpSecretEnc: api.totpService.encryptSecret(secret), totpLastStep: null } });
  return secret;
}

/** Snapshot / restore of the fields a login changes, so every trial starts from the same state. */
async function snapshot(userId) {
  return api.User.findById(userId).select('knownNetworks trustedDevices failedLoginAttempts loginCount totpLastStep').lean();
}
async function restore(userId, snap) {
  await api.User.updateOne({ _id: userId }, { $set: {
    knownNetworks: snap.knownNetworks, trustedDevices: snap.trustedDevices, failedLoginAttempts: 0,
    accountLockedUntil: null, loginCount: snap.loginCount, refreshTokens: [], totpLastStep: snap.totpLastStep ?? null,
  } });
  const u = await api.User.findById(userId).select('email').lean();
  await api.redis.del([`otp:attempts:${u.email}`, `otp:${u.email}`, `session:active:${userId}`]);
}

/** GPS position at a chosen distance band from where the IP is (offline GeoIP, same database as the API). */
function gpsFor(ip, band) {
  const geo = api.contextService.lookupGeo(ip);
  if (!geo) throw new Error(`GeoIP has no position for ${ip}: choose another address`);
  if (band === 'unknown') return null;
  const shift = { near: 0.05, mid: 1.5, far: 10 }[band]; // about 6 km, 167 km, 1110 km north
  return { lat: Math.min(89, geo.lat + shift), lon: geo.lon };
}

function setDuty(on) {
  Object.assign(api.config.context, on ? { dutyStartHour: 0, dutyEndHour: 24 } : { dutyStartHour: 0, dutyEndHour: 0 });
}

function writeCsv(file, rows) {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!rows.length) { fs.writeFileSync(file, ''); return; }
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(file, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
}

function args() {
  const out = {};
  process.argv.slice(2).forEach((a, i, all) => {
    if (a.startsWith('--')) out[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true;
  });
  return out;
}

// Networks used by the experiments (all placed in Hyderabad by the GeoIP database; the
// script checks this at start). Different /24 prefixes = different networks for CARMA.
const NETWORKS = {
  hospital: '49.207.0.10', // HOSPITAL_NETWORKS is set to 49.207.0.0/24
  known: '49.207.5.10', // the user's home network (first login from here)
  new: '49.207.77.10', // a network the user never used
  foreign: '81.2.69.142', // United Kingdom
};

module.exports = {
  api, start, stop, http, createUser, firstLogin, enrolTotp, snapshot, restore, gpsFor, setDuty, writeCsv, args,
  codes, PASSWORD, NETWORKS, OUT: path.join(__dirname, 'out'),
};
