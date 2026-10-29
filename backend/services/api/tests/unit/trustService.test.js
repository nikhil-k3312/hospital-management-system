const trustService = require('../../src/services/trustService');

const makeReq = ({ userAgent = 'Mozilla/5.0', role = 'doctor', breakGlass, trust = 100, session = {} } = {}) => ({
  ip: '127.0.0.1',
  user: { role },
  trustScore: { score: trust },
  sessionState: { approvalStatus: 'approved', isVerified: true, ...session },
  get: (h) => ({ 'user-agent': userAgent, 'x-break-glass-reason': breakGlass }[h.toLowerCase()]),
});
const nowSec = () => Math.floor(Date.now() / 1000);

describe('calculateTrustScore', () => {
  test('a fresh, verified session with a browser scores 100', () => {
    const result = trustService.calculateTrustScore(makeReq(), { iat: nowSec() }, { isVerified: true });
    expect(result.score).toBe(100);
    expect(result.reasons).toEqual([]);
  });

  test('each risk signal subtracts its penalty', () => {
    const r = trustService.calculateTrustScore(makeReq({ userAgent: '' }), { iat: nowSec() - 2 * 3600 }, { isVerified: false, failedLoginAttempts: 2 });
    // 100 - 15 (unverified) - 12 (2 failures x 6) - 10 (no UA) - 10 (> 1h)
    expect(r.score).toBe(53);
    expect(r.reasons).toEqual(['user_not_verified', 'recent_failed_attempts', 'missing_user_agent', 'older_session']);
  });

  test('the failed-attempt penalty is capped at 30 and the score never drops below 0', () => {
    const r = trustService.calculateTrustScore(makeReq({ userAgent: '' }), { iat: nowSec() - 7 * 3600 }, { isVerified: false, failedLoginAttempts: 50 });
    expect(r.score).toBe(100 - 15 - 30 - 10 - 10 - 15);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  test('the device fingerprint is a hash, not the raw user agent', () => {
    const r = trustService.calculateTrustScore(makeReq({ userAgent: 'SecretBrowser/1.0' }), { iat: nowSec() }, { isVerified: true });
    expect(r.deviceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(r.deviceFingerprint).not.toContain('Secret');
  });
});

describe('evaluatePolicy', () => {
  test('allows a matching role with enough trust', () => {
    expect(trustService.evaluatePolicy(makeReq(), ['doctor'])).toMatchObject({ allowed: true, reason: 'policy_allowed' });
  });

  test('denies the wrong role', () => {
    expect(trustService.evaluatePolicy(makeReq({ role: 'patient' }), ['doctor'])).toMatchObject({ allowed: false, status: 403, reason: 'role_denied' });
  });

  test('denies an unapproved doctor unless the route allows it', () => {
    const req = makeReq({ session: { approvalStatus: 'pending' } });
    expect(trustService.evaluatePolicy(req, ['doctor']).reason).toBe('approval_pending');
    expect(trustService.evaluatePolicy(req, ['doctor'], { allowUnapproved: true }).allowed).toBe(true);
  });

  test('applies a per-route minimum trust score', () => {
    expect(trustService.evaluatePolicy(makeReq({ trust: 65 }), ['doctor'], { minTrustScore: 70 }).reason).toBe('low_trust_score');
    expect(trustService.evaluatePolicy(makeReq({ trust: 75 }), ['doctor'], { minTrustScore: 70 }).allowed).toBe(true);
  });

  test('break-glass needs the route opt-in, an eligible role and a real reason', () => {
    const reason = 'Unconscious patient in ER, allergy check';
    expect(trustService.evaluatePolicy(makeReq({ role: 'doctor', trust: 10, breakGlass: reason }), ['patient'], { allowBreakGlass: true }))
      .toMatchObject({ allowed: true, reason: 'break_glass_allowed', breakGlass: true, breakGlassReason: reason });
    expect(trustService.evaluatePolicy(makeReq({ role: 'doctor', breakGlass: reason }), ['patient']).allowed).toBe(false);
    expect(trustService.evaluatePolicy(makeReq({ role: 'patient', breakGlass: reason }), ['doctor'], { allowBreakGlass: true }).allowed).toBe(false);
    expect(trustService.evaluatePolicy(makeReq({ role: 'doctor', breakGlass: 'short' }), ['patient'], { allowBreakGlass: true }).allowed).toBe(false);
  });
});

describe('isWithinTimeWindow', () => {
  test.each([
    [10, [8, 20], true], [20, [8, 20], false], [7, [8, 20], false],
    [23, [22, 6], true], [3, [22, 6], true], [12, [22, 6], false],
    [5, [9, 9], true],
  ])('hour %i in %j -> %s', (hour, window, expected) => {
    expect(trustService.isWithinTimeWindow(hour, window)).toBe(expected);
  });
});
