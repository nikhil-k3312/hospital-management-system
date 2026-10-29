const redis = require('redis');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * One shared Redis connection for the whole API. Redis holds short-lived
 * security state: hashed OTPs, refresh-token validity, the access-token
 * blacklist, attempt counters and the 5-minute session cache.
 */
const redisClient = redis.createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
    // Give up quickly at start-up so a missing Redis fails loudly.
    reconnectStrategy: (retries) => (retries > 20 ? new Error('Redis reconnect limit reached') : Math.min(retries * 200, 2000)),
  },
  database: config.redis.db,
});

redisClient.on('error', (error) => logger.error(`Redis error: ${error.message}`));
redisClient.on('ready', () => logger.info('Redis connected'));

/**
 * Connects and verifies Redis with a PING. Throws if Redis is unreachable so
 * the server refuses to start (fixes the old "swallowed connection error").
 */
async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  await redisClient.ping();
  return redisClient;
}

async function disconnectRedis() {
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
}

module.exports = redisClient;
module.exports.connectRedis = connectRedis;
module.exports.disconnectRedis = disconnectRedis;
