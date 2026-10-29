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

  /** Short-lived access token. The random jti lets us revoke this exact token. */
  generateAccessToken(user) {
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role, jti },
      this.config.jwt.secret,
      { expiresIn: this.config.jwt.expiry }
    );
    return { token, jti, expiresIn: this.config.jwt.expiry };
  }

  /**
   * Long-lived refresh token, signed with a different secret. It is valid only
   * while its Redis key exists, so the server can revoke it at any time.
   */
  async generateRefreshToken(user) {
    const userId = user._id.toString();
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { userId, jti, type: 'refresh' },
      this.config.jwt.refreshSecret,
      { expiresIn: `${this.config.jwt.refreshExpiryDays}d` }
    );
    try {
      await this.redis.setEx(this.refreshKey(userId, jti), this.refreshTTLSeconds, '1');
    } catch (error) {
      logger.error(`Error storing refresh token: ${error.message}`);
      throw new Error(REDIS_UNAVAILABLE);
    }
    return { token, jti, jtiHash: this.hashJTI(jti) };
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
