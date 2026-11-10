const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const redisClient = require('../db/redis');
const config = require('../config/config');
const logger = require('../utils/logger');

const REDIS_UNAVAILABLE = 'REDIS_UNAVAILABLE';

class TokenService {
  constructor(client, appConfig) {
    this.redis = client;
    this.config = appConfig;
    this.refreshTTLSeconds = appConfig.jwt.refreshExpiryDays * 24 * 60 * 60;
  }

  /** Token IDs are stored hashed so a Redis or Mongo dump reveals nothing usable. */
  hashJTI(jti) {
    return crypto.createHash('sha256').update(String(jti)).digest('hex');
  }

  refreshKey(userId, jti) {
    return `refresh:${userId}:${this.hashJTI(jti)}`;
  }

  /** End of the maximum session (Problem 7, D2): authTime + MAX_SESSION_HOURS, epoch seconds. */
  sessionEnd(authTime) {
    return authTime + this.config.security.maxSessionHours * 3600;
  }

  /**
   * Short-lived access token. The random jti lets us revoke this exact token.
   *   authTime  epoch seconds of the sign-in that started this session (Problem 7); it is
   *             carried unchanged through every refresh, so the per-request trust score can
   *             measure the real age of the session
   *   amr       how the sign-in was proven, e.g. ['pwd', 'device'] or ['pwd', 'otp', 'totp']
   * An emergency session ({ emergencyUntil }, epoch seconds) carries emergency: true
   * and never outlives the emergency window.
   */
  generateAccessToken(user, { emergencyUntil, authTime, amr } = {}) {
    const jti = crypto.randomUUID();
    const claims = {
      userId: user._id.toString(), email: user.email, role: user.role, jti,
      authTime: authTime || Math.floor(Date.now() / 1000), amr: amr || ['pwd'],
    };
    if (emergencyUntil) claims.emergency = true;
    let token = jwt.sign(claims, this.config.jwt.secret, { expiresIn: this.config.jwt.expiry });
    if (emergencyUntil && jwt.decode(token).exp > emergencyUntil) {
      token = jwt.sign({ ...claims, exp: emergencyUntil }, this.config.jwt.secret);
    }
    return { token, jti, expiresIn: this.config.jwt.expiry };
  }

  /**
   * Long-lived refresh token, signed with a different secret. It is valid only
   * while its Redis key exists, so the server can revoke it at any time.
   *   netHash, uaHash  keyed hash of the network prefix and hash of the user-agent at sign-in
   *                    (Problem 8): a refresh from another network or browser is refused
   *   authTime         sign-in time; the token never lives past authTime + MAX_SESSION_HOURS
   */
  async generateRefreshToken(user, { emergencyUntil, emergencyReason, authTime, amr, netHash, uaHash } = {}) {
    const userId = user._id.toString();
    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const signedInAt = authTime || now;
    // An emergency session keeps its fixed end time through every rotation; no session outlives
    // the maximum session length.
    const end = Math.min(emergencyUntil || Infinity, this.sessionEnd(signedInAt), now + this.refreshTTLSeconds);
    const ttl = Math.max(1, end - now);
    const payload = { userId, jti, type: 'refresh', authTime: signedInAt, amr: amr || ['pwd'], netHash: netHash || null, uaHash: uaHash || null };
    if (emergencyUntil) Object.assign(payload, { emergencyUntil, emergencyReason });
    const token = jwt.sign(payload, this.config.jwt.refreshSecret, { expiresIn: ttl });
    try {
      await this.redis.setEx(this.refreshKey(userId, jti), ttl, '1');
    } catch (error) {
      logger.error(`Error storing refresh token: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
    return { token, jti, jtiHash: this.hashJTI(jti), ttl };
  }

  async verifyAccessToken(token) {
    const decoded = jwt.verify(token, this.config.jwt.secret);
    if (!decoded.jti) throw new Error('INVALID_TOKEN');

    let blacklisted;
    try {
      blacklisted = await this.redis.exists(`jwt:blacklist:${decoded.jti}`);
    } catch (error) {
      logger.error(`Error checking token blacklist: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
    if (blacklisted) throw new Error('TOKEN_REVOKED');
    return decoded;
  }

  async verifyRefreshToken(token) {
    const decoded = jwt.verify(token, this.config.jwt.refreshSecret);
    // The type check stops an access token being replayed as a refresh token.
    if (decoded.type !== 'refresh' || !decoded.jti || !decoded.userId) {
      throw new Error('INVALID_REFRESH_TOKEN');
    }

    let exists;
    try {
      exists = await this.redis.exists(this.refreshKey(decoded.userId, decoded.jti));
    } catch (error) {
      logger.error(`Error checking refresh token: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
    if (!exists) throw new Error('REFRESH_REVOKED');
    return decoded;
  }

  /** Blacklists an access token until it would have expired anyway. */
  async blacklistAccessToken(decodedPayload) {
    if (!decodedPayload?.jti || !decodedPayload?.exp) throw new Error('INVALID_TOKEN');
    const ttl = decodedPayload.exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return;
    try {
      await this.redis.setEx(`jwt:blacklist:${decodedPayload.jti}`, ttl, '1');
    } catch (error) {
      logger.error(`Error blacklisting token: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
  }

  async revokeRefreshToken(userId, jti) {
    try {
      await this.redis.del(this.refreshKey(userId, jti));
    } catch (error) {
      logger.error(`Error revoking refresh token: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
  }

  /** Revokes every refresh token of a user (deactivation, password change). */
  async revokeAllRefreshTokens(userId) {
    try {
      const keys = [];
      for await (const key of this.redis.scanIterator({ MATCH: `refresh:${userId}:*`, COUNT: 100 })) {
        keys.push(key);
      }
      if (keys.length) await this.redis.del(keys);
      return keys.length;
    } catch (error) {
      logger.error(`Error revoking refresh tokens: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
  }
}

module.exports = new TokenService(redisClient, config);
module.exports.TokenService = TokenService;
module.exports.REDIS_UNAVAILABLE = REDIS_UNAVAILABLE;
