const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Logs live in backend/logs (git-ignored). Tests log only errors to the console.
const logsDir = path.join(__dirname, '../../../../logs');
const isTest = process.env.NODE_ENV === 'test';

const transports = [
  new winston.transports.Console({
    level: isTest ? 'error' : 'info',
    silent: isTest && !process.env.TEST_LOGS,
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
    ),
  }),
];

if (!isTest) {
  fs.mkdirSync(logsDir, { recursive: true });
  transports.push(
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log') })
  );
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports,
});

module.exports = logger;
