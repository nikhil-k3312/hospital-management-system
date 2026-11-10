const path = require('path');

// Load .env from the service folder regardless of the current working directory.
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const env = process.env;
const nodeEnv = env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};
// A list variable that may be set to an empty string on purpose (empty list).
const toList = (value, fallback) => (value === undefined ? fallback : value).split(',').map((v) => v.trim()).filter(Boolean);
const toBool = (value, fallback) => (value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()));

// CARMA role thresholds (upper, lower): low risk if T > upper, medium if T >= lower, high otherwise.
// Starting values from the plan (Problem 6); the final values come from experiments/thresholds/derive.py (decision D10).
// Trust-score points per signal level (Problem 15, review issue 5). CONTEXT_POINTS (JSON, same shape)
// replaces them, e.g. with the values calibrated on the RBA dataset (experiments/rba/calibrate.py).
const DEFAULT_POINTS = {
  location: { near: 35, mid: 20, unknown: 15, far: 5 },
  device: { trusted: 25, new: 10 },
  time: { duty: 20, off: 10 },
  network: { hospital: 20, known: 15, new: 5 },
  penalty: { perFailure: 10, max: 30 },
};
function parsePoints(raw) {
  if (!raw) return DEFAULT_POINTS;
  const given = JSON.parse(raw);
  return Object.fromEntries(Object.entries(DEFAULT_POINTS).map(([k, v]) => [k, { ...v, ...(given[k] || {}) }]));
}

const threshold = (role, upper, lower) => ({
  upper: toInt(env[`RISK_${role.toUpperCase()}_UPPER`], upper),
  lower: toInt(env[`RISK_${role.toUpperCase()}_LOWER`], lower),
});

// 'smtp' sends real mail, 'console' prints mail to the server log (development only),
// 'json' renders mail in memory (used by the test suite).
const emailTransport = env.EMAIL_TRANSPORT || 'smtp';

const config = {
  port: toInt(env.PORT, 8001),
  nodeEnv,
  isProduction,
  isTest,

  mongodb: {
    uri: env.MONGODB_URI,
  },

  jwt: {
    secret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    expiry: env.JWT_EXPIRY || '15m',
    refreshExpiryDays: toInt(env.JWT_REFRESH_EXPIRY_DAYS, 7),
  },

  email: {
    transport: emailTransport,
    service: env.EMAIL_SERVICE,
    user: env.EMAIL_USER,
    password: env.EMAIL_PASSWORD,
    from: env.EMAIL_FROM || env.EMAIL_USER,
  },

  otp: {
    expiryMinutes: toInt(env.OTP_EXPIRY_MINUTES, 10),
    length: toInt(env.OTP_LENGTH, 6),
    maxAttempts: toInt(env.OTP_MAX_ATTEMPTS, 10),
  },

  redis: {
    host: env.REDIS_HOST || 'localhost',
    port: toInt(env.REDIS_PORT, 6379),
    db: toInt(env.REDIS_DB, 0),
  },

  cors: {
    origins: (env.ALLOWED_ORIGINS || 'http://localhost:8001').split(',').map((o) => o.trim()),
  },

  rateLimit: {
    windowMinutes: toInt(env.RATE_LIMIT_WINDOW_MINUTES, 15),
    max: toInt(env.RATE_LIMIT_MAX, 1000),
    authMax: toInt(env.AUTH_RATE_LIMIT_MAX, 30),
  },

  security: {
    minTrustScore: toInt(env.MIN_TRUST_SCORE, 50),
    highSensitivityTrustScore: toInt(env.HIGH_SENSITIVITY_TRUST_SCORE, 70),
    maxFailedLogins: toInt(env.MAX_FAILED_LOGINS, 5),
    lockMinutes: toInt(env.ACCOUNT_LOCK_MINUTES, 30),
    // emergency sign-in (doctor/admin): how long the session lasts before a full login is needed
    emergencySessionMinutes: toInt(env.EMERGENCY_SESSION_MINUTES, 30),
    // Problem 7 / D2: a session may be refreshed for at most this long after the sign-in itself.
    maxSessionHours: toInt(env.MAX_SESSION_HOURS, 12),
    // Problem 2 / D1: roles that must have an authenticator app (TOTP) before using the system.
    totpRequiredRoles: toList(env.TOTP_REQUIRED_ROLES, 'doctor,admin,insurance_agent'),
    // AES-256-GCM key (64 hex characters) that encrypts TOTP secrets at rest.
    totpEncryptionKey: env.TOTP_ENC_KEY || '',
    // TOTP setup is allowed only this many minutes after a (non-emergency) sign-in.
    totpSetupFreshMinutes: toInt(env.TOTP_SETUP_FRESH_MINUTES, 15),
  },

  // Problem 3: every stored IP address and network prefix is HMAC-SHA256(IP_HASH_SECRET, value).
  privacy: {
    ipHashSecret: env.IP_HASH_SECRET || '',
  },

  // Problem 12: write an "allow" ledger entry for every authenticated request (denials are always written).
  // Switching it off is for the performance experiment only (Problem 18), never for a real deployment.
  audit: {
    everyRequest: toBool(env.AUDIT_EVERY_REQUEST, true),
  },

  // Problem 10: the heads of the two ledger chains are anchored on the blockchain.
  anchoring: {
    enabled: toBool(env.LEDGER_ANCHORING, true),
    intervalMinutes: toInt(env.ANCHOR_INTERVAL_MINUTES, 10),
    everyEntries: toInt(env.ANCHOR_EVERY_ENTRIES, 100),
    minSecondsBetween: toInt(env.ANCHOR_MIN_SECONDS, 60), // at most one entry-triggered anchor per chain per minute
  },

  files: {
    maxBytes: toInt(env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
  },

  // Attachments are encrypted with AES-256-GCM and stored on IPFS (Kubo HTTP API).
  ipfs: {
    apiUrl: (env.IPFS_API_URL || '').replace(/\/$/, ''),
    encryptionKey: env.IPFS_ENCRYPTION_KEY || '', // 64 hex characters = 32 bytes
    timeoutMs: toInt(env.IPFS_TIMEOUT_MS, 15000),
  },

  // Fingerprints (hashes only) are anchored in the HealthRecordRegistry contract.
  chain: {
    rpcUrl: env.CHAIN_RPC_URL || '',
    contractAddress: env.CHAIN_CONTRACT_ADDRESS || '',
    privateKey: env.CHAIN_PRIVATE_KEY || '',
    patientRefSecret: env.PATIENT_REF_SECRET || '',
    // Problem 26: on-chain k-of-n register of staff roles (empty = not used, MongoDB decides).
    roleRegistryAddress: env.ROLE_REGISTRY_ADDRESS || '',
    roleCacheSeconds: toInt(env.ROLE_CACHE_SECONDS, 60),
    // if the chain cannot be reached, a cached answer may be used for this long before failing closed
    roleStaleSeconds: toInt(env.ROLE_STALE_SECONDS, 15 * 60),
  },

  // A browser that completed a full password + OTP login is remembered for this long.
  devices: {
    trustDays: toInt(env.TRUSTED_DEVICE_DAYS, 30),
  },

  // Dynamic (context-aware) login used from the second login on.
  context: {
    hospitalNetworks: (env.HOSPITAL_NETWORKS || '').split(',').map((c) => c.trim()).filter(Boolean), // CIDR list
    timezone: env.HOSPITAL_TIMEZONE || 'Asia/Kolkata',
    dutyStartHour: toInt(env.DUTY_START_HOUR, 8),
    dutyEndHour: toInt(env.DUTY_END_HOUR, 20),
    // Problem 6: carma = gates + role thresholds + TOTP (default)
    //            v3     = Version 3 as published before the fixes: 80/50 for everyone, no gates,
    //                     security question at high risk (baseline B2, experiments only)
    //            static = password + emailed code at every login (baseline B1, experiments only)
    profile: env.CONTEXT_PROFILE || 'carma',
    riskThresholds: {
      patient: threshold('patient', 65, 50),
      insurance_agent: threshold('insurance_agent', 70, 55),
      doctor: threshold('doctor', 70, 55),
      admin: threshold('admin', 80, 60),
    },
    // Problem 5: the low tier needs fewer than this many failed attempts since the last sign-in.
    failureGate: toInt(env.FAILURE_GATE, 2),
    points: parsePoints(env.CONTEXT_POINTS),
    // Problem 8 / review issue 6: when a session's network changes at refresh, "rescore" re-checks the
    // new context and continues silently if it is low risk; "reauth" always asks for a new sign-in.
    refreshOnNetworkChange: env.REFRESH_ON_NETWORK_CHANGE || 'rescore',
  },

  frontendDir: path.resolve(__dirname, '../../../../../frontend'),
};

/**
 * Fails fast at start-up when configuration is missing or unsafe, instead of
 * failing later on the first request that needs it.
 */
function validateConfig(cfg = config, rawEnv = env) {
  const required = ['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
  if (cfg.email.transport === 'smtp') {
    required.push('EMAIL_USER', 'EMAIL_PASSWORD');
  }

  const missing = required.filter((key) => !rawEnv[key] || String(rawEnv[key]).trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!['smtp', 'console', 'json'].includes(cfg.email.transport)) {
    throw new Error(`EMAIL_TRANSPORT must be smtp, console or json (got "${cfg.email.transport}")`);
  }

  // Printing OTPs to a log is only acceptable on a developer machine.
  if (cfg.isProduction && cfg.email.transport !== 'smtp') {
    throw new Error('EMAIL_TRANSPORT must be "smtp" in production');
  }

  const p = cfg.context.points;
  const levels = ['location', 'device', 'time', 'network'];
  const allValues = [...levels.flatMap((k) => Object.values(p[k])), p.penalty.perFailure, p.penalty.max];
  if (!allValues.every((v) => Number.isInteger(v) && v >= 0)) throw new Error('CONTEXT_POINTS: every value must be a whole number >= 0');
  const best = levels.reduce((sum, k) => sum + Math.max(...Object.values(p[k])), 0);
  if (best !== 100) throw new Error(`CONTEXT_POINTS: the best level of each signal must add up to 100 (got ${best})`);
  if (!['rescore', 'reauth'].includes(cfg.context.refreshOnNetworkChange)) throw new Error('REFRESH_ON_NETWORK_CHANGE must be rescore or reauth');

  if (!['carma', 'v3', 'static'].includes(cfg.context.profile)) {
    throw new Error(`CONTEXT_PROFILE must be carma, v3 or static (got "${cfg.context.profile}")`);
  }
  Object.entries(cfg.context.riskThresholds).forEach(([role, t]) => {
    if (!(t.lower >= 0 && t.lower <= t.upper && t.upper <= 100)) throw new Error(`Risk thresholds for ${role} must satisfy 0 <= lower <= upper <= 100`);
  });

  // The experiment-only settings must never reach a real deployment.
  if (cfg.isProduction && (cfg.context.profile !== 'carma' || !cfg.audit.everyRequest)) {
    throw new Error('CONTEXT_PROFILE=carma and AUDIT_EVERY_REQUEST=true are required in production');
  }
  if (cfg.isProduction && !rawEnv.IP_HASH_SECRET) {
    throw new Error('IP_HASH_SECRET is required in production (addresses are stored only as keyed hashes)');
  }
  if (rawEnv.IP_HASH_SECRET && String(rawEnv.IP_HASH_SECRET).length < 32) {
    throw new Error('IP_HASH_SECRET must be at least 32 characters');
  }
  if (rawEnv.TOTP_ENC_KEY && !/^[0-9a-fA-F]{64}$/.test(rawEnv.TOTP_ENC_KEY)) {
    throw new Error('TOTP_ENC_KEY must be 64 hex characters (32 bytes)');
  }
  if (cfg.isProduction && !rawEnv.TOTP_ENC_KEY) {
    throw new Error('TOTP_ENC_KEY is required in production');
  }
  if (rawEnv.ROLE_REGISTRY_ADDRESS && !rawEnv.CHAIN_RPC_URL) {
    throw new Error('ROLE_REGISTRY_ADDRESS needs CHAIN_RPC_URL');
  }

  if (rawEnv.JWT_SECRET === rawEnv.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }

  if (cfg.ipfs?.apiUrl && !/^[0-9a-fA-F]{64}$/.test(cfg.ipfs.encryptionKey)) {
    throw new Error('IPFS_ENCRYPTION_KEY must be 64 hex characters when IPFS_API_URL is set');
  }

  const chainVars = ['CHAIN_RPC_URL', 'CHAIN_CONTRACT_ADDRESS', 'CHAIN_PRIVATE_KEY', 'PATIENT_REF_SECRET'];
  const chainSet = chainVars.filter((key) => rawEnv[key]);
  if (chainSet.length > 0 && chainSet.length < chainVars.length) {
    throw new Error(`Blockchain anchoring needs all of: ${chainVars.join(', ')}`);
  }

  return true;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
