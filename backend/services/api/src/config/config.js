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
  },

  files: {
    maxBytes: toInt(env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
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

  if (rawEnv.JWT_SECRET === rawEnv.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }

  return true;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
