// Runs before any module is loaded, so config.js sees the test settings.
// Tests use their own MongoDB database and Redis DB index, never the dev data.
process.env.NODE_ENV = 'test';
// Each parallel Jest worker gets its own database and Redis DB index.
const worker = Number(process.env.JEST_WORKER_ID || 1);
process.env.MONGODB_URI = `${process.env.TEST_MONGODB_BASE || 'mongodb://127.0.0.1:27017/medichain_test'}_${worker}`;
process.env.REDIS_DB = String(15 - ((worker - 1) % 8));
process.env.JWT_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-fedcba9876543210';
process.env.EMAIL_TRANSPORT = 'json';
process.env.EMAIL_FROM = 'MediChain Test <test@medichain.local>';
process.env.MIN_TRUST_SCORE = '50';
process.env.HIGH_SENSITIVITY_TRUST_SCORE = '70';
