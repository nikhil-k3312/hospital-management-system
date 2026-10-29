const crypto = require('crypto');
const config = require('../config/config');
const redisClient = require('../db/redis');
const logger = require('../utils/logger');

const REDIS_UNAVAILABLE = 'REDIS_UNAVAILABLE';

// Every Redis failure becomes REDIS_UNAVAILABLE so callers can fail closed (503).
const guard = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    logger.error(`OTP ${label} failed: ${error.message}`);
    throw new Error(REDIS_UNAVAILABLE);
  }
};

const otpKey = (email) => `otp:${email}`;
const attemptsKey = (email) => `otp:attempts:${email}`;

class OTPService {
  /** Only the hash is stored: a Redis dump cannot be used to log in. */
  hashOTP(otp) {
    return crypto.createHash('sha256').update(String(otp)).digest('hex');
  }

  /** Cryptographically secure, uniformly random code with no leading zero. */
  generateOTP(length = config.otp.length) {
    return crypto.randomInt(10 ** (length - 1), 10 ** length).toString();
  }

  /** Stores the hashed code with a TTL; a new request overwrites the old code. */
  storeOTP(email, otp) {
    return guard('store', () => redisClient.setEx(otpKey(email), config.otp.expiryMinutes * 60, this.hashOTP(otp)));
  }

  /** Single use: a matching code is deleted immediately. */
  verifyOTP(email, otp) {
    return guard('verify', async () => {
      const stored = await redisClient.get(otpKey(email));
      if (!stored) return { success: false, message: 'OTP expired or not found' };

      const expected = Buffer.from(stored, 'hex');
      const actual = Buffer.from(this.hashOTP(otp), 'hex');
      // Constant-time comparison: response time does not leak how many characters matched.
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return { success: false, message: 'Invalid OTP' };
      }
      await redisClient.del(otpKey(email));
      return { success: true, message: 'OTP verified successfully' };
    });
  }

  /** Per-email budget of OTP requests + failed verifications, sliding 15 minutes. */
  incrementAttempts(email) {
    return guard('increment', async () => {
      const [count] = await redisClient.multi().incr(attemptsKey(email)).expire(attemptsKey(email), 15 * 60).exec();
      return Number(count);
    });
  }

  getAttempts(email) {
    return guard('read attempts', async () => Number(await redisClient.get(attemptsKey(email))) || 0);
  }

  clearAttempts(email) {
    return guard('clear attempts', () => redisClient.del(attemptsKey(email)));
  }
}

module.exports = new OTPService();
module.exports.REDIS_UNAVAILABLE = REDIS_UNAVAILABLE;
