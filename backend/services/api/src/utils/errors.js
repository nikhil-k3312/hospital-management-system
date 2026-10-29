/**
 * An error that maps directly to an HTTP response. Throw it anywhere in a
 * request handler; the central error handler turns it into JSON.
 */
class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || undefined;
    this.details = details || undefined;
  }
}

const badRequest = (message, details) => new AppError(400, message, 'BAD_REQUEST', details);
const unauthorized = (message, code = 'UNAUTHORIZED') => new AppError(401, message, code);
const forbidden = (message, code = 'FORBIDDEN') => new AppError(403, message, code);
const notFound = (message = 'Resource not found') => new AppError(404, message, 'NOT_FOUND');
const conflict = (message, code = 'CONFLICT') => new AppError(409, message, code);
const tooMany = (message) => new AppError(429, message, 'TOO_MANY_REQUESTS');
const unavailable = (message = 'Security service temporarily unavailable. Please try again.') =>
  new AppError(503, message, 'SERVICE_UNAVAILABLE');

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * handler instead of becoming an unhandled rejection.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  unavailable,
  asyncHandler,
};
