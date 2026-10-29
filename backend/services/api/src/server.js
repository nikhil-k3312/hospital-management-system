const config = require('./config/config');
const logger = require('./utils/logger');
const { connectMongo, disconnectMongo } = require('./db/mongo');
const { connectRedis, disconnectRedis } = require('./db/redis');
const emailService = require('./services/emailService');
const HospitalSettings = require('./models/HospitalSettings');

/**
 * Start-up order: validate config, connect MongoDB, connect Redis, check the
 * mail transport, then listen. Any failure exits with code 1, so a
 * misconfigured deployment fails loudly instead of half-working.
 */
async function start() {
  try {
    config.validateConfig();
    await connectMongo();
    await connectRedis();
    await HospitalSettings.getSingleton();
    await emailService.verifyConnection();

    const app = require('./app');
    const server = app.listen(config.port, () => {
      logger.info(`MediChain API listening on http://localhost:${config.port} (${config.nodeEnv})`);
    });

    const shutdown = (signal) => {
      logger.info(`${signal} received, shutting down`);
      server.close(async () => {
        await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error(`Failed to start: ${error.message}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (error) => {
  logger.error(`Unhandled rejection: ${error?.stack || error}`);
  process.exit(1);
});

start();
