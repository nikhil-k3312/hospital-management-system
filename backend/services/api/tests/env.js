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
// CARMA settings used by the test suite
process.env.IP_HASH_SECRET = 'test-ip-hash-secret-0123456789abcdef0123456789';
process.env.TOTP_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
// Staff are not forced to set up an authenticator in the general tests; carma.test.js switches it on.
process.env.TOTP_REQUIRED_ROLES = '';
process.env.CONTEXT_PROFILE = 'carma';
// The worked examples in the tests use the paper's reference model, not the adopted defaults
// (calibrated points, 70/50): pin it, so a developer's .env cannot change what the tests check.
// tests/unit/adoptedPolicy.test.js checks the adopted defaults against rules.csv.
process.env.CONTEXT_POINTS = JSON.stringify({
  location: { near: 35, mid: 20, unknown: 15, far: 5 }, device: { trusted: 25, new: 10 },
  time: { duty: 20, off: 10 }, network: { hospital: 20, known: 15, new: 5 }, penalty: { perFailure: 10, max: 30 },
});
Object.entries({ PATIENT: [65, 50], INSURANCE_AGENT: [70, 55], DOCTOR: [70, 55], ADMIN: [80, 60] }).forEach(([role, [u, l]]) => {
  process.env[`RISK_${role}_UPPER`] = String(u);
  process.env[`RISK_${role}_LOWER`] = String(l);
});
process.env.LEDGER_ANCHORING = 'false';
// Never write to the developer's blockchain: the anchoring and role tests use in-memory stand-ins
// (ipfs-blockchain.test.js has its own CHAIN_TEST_RPC switch).
process.env.CHAIN_CONTRACT_ADDRESS = '';
process.env.CHAIN_PRIVATE_KEY = '';
process.env.ROLE_REGISTRY_ADDRESS = '';
process.env.EMERGENCY_REVIEW_ADDRESS = '';
