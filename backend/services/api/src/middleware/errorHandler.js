const multer = require('multer');
const config = require('../config/config');
const logger = require('../utils/logger');

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Route not found', path: req.path, method: req.method });
}

/**
 * The single place where errors become HTTP responses, so every endpoint
 * fails with the same JSON shape: { success:false, message, code?, details? }.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = err.message || 'Internal server error';
  let code = err.code;

  if (err.message === 'REDIS_UNAVAILABLE') {
    status = 503;
    message = 'Security service temporarily unavailable. Please try again.';
    code = 'SERVICE_UNAVAILABLE';
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message;
    code = err.code;
  } else if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    message = 'A record with these details already exists';
    code = 'DUPLICATE';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  }

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${err.stack || err.message}`);
    if (config.isProduction) message = 'Internal server error';
  }

  res.status(status).json({
    success: false,
    message,
    code: typeof code === 'string' ? code : undefined,
    details: err.details,
    stack: config.nodeEnv === 'development' && status >= 500 ? err.stack : undefined,
  });
}

module.exports = { notFoundHandler, errorHandler };
