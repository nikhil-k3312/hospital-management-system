const contextService = require('../../src/services/contextService');

describe('contextService', () => {
  const trusted = (role, extra = {}) => ({ role, deviceKnown: true, failures: 0, profile: 'carma', ...extra });

  test('role thresholds (Problem 6): low above the upper threshold, high below the lower one', () => {
    // patient 65/50
    expect(contextService.tierFor(66, trusted('patient'))).toMatchObject({ risk: 'low', factors: ['password'] });
    expect(contextService.tierFor(65, trusted('patient'))).toMatchObject({ risk: 'medium', factors: ['password', 'otp'] });
    expect(contextService.tierFor(50, trusted('patient'))).toMatchObject({ risk: 'medium' });
    expect(contextService.tierFor(49, trusted('patient'))).toMatchObject({ risk: 'high', factors: ['password', 'otp', 'totp'] });
    // insurance agent and doctor 70/55
    expect(contextService.tierFor(71, trusted('doctor')).risk).toBe('low');
    expect(contextService.tierFor(70, trusted('doctor')).risk).toBe('medium');
    expect(contextService.tierFor(54, trusted('insurance_agent')).risk).toBe('high');
    // administrator 80/60
    expect(contextService.tierFor(81, trusted('admin')).risk).toBe('low');
    expect(contextService.tierFor(80, trusted('admin')).risk).toBe('medium');
    expect(contextService.tierFor(59, trusted('admin')).risk).toBe('high');
  });

  test('possession gate (Problem 4): without a trusted device the best tier is medium', () => {
    const t = contextService.tierFor(100, trusted('doctor', { deviceKnown: false }));
    expect(t).toMatchObject({ risk: 'medium', gate: 'possession', factors: ['password', 'otp'] });
  });

  test('insider at a ward computer (Problem 4): hospital network + duty + GPS agrees + new browser = 85 is medium', () => {
    // 35 location + 10 new device + 20 duty + 20 hospital network
    expect(contextService.tierFor(85, trusted('doctor', { deviceKnown: false })).risk).toBe('medium');
  });

  test('failure gate (Problem 5): two failed attempts remove the low tier', () => {
    expect(contextService.tierFor(95, trusted('patient', { failures: 1 })).risk).toBe('low');
    expect(contextService.tierFor(95, trusted('patient', { failures: 2 }))).toMatchObject({ risk: 'medium', gate: 'failure' });
  });

  test('baseline profiles (Problem 6): v3 = 80/50, no gates, security question; static = always the emailed code', () => {
    const v3 = (score, extra) => contextService.tierFor(score, { role: 'admin', deviceKnown: false, failures: 3, profile: 'v3', ...extra });
    expect(v3(81)).toMatchObject({ risk: 'low', thresholds: { upper: 80, lower: 50 } }); // no gates in V3
    expect(v3(80).risk).toBe('medium');
    expect(v3(49).factors).toEqual(['password', 'otp', 'security_question']);
    expect(contextService.tierFor(100, trusted('patient', { profile: 'static' }))).toMatchObject({ risk: 'medium', factors: ['password', 'otp'] });
    expect(contextService.tierFor(0, trusted('patient', { profile: 'static' })).risk).toBe('medium');
  });

  test('network hashes are keyed (Problem 3): HMAC, not a plain SHA-256 of the prefix', () => {
    const { sha256 } = require('../../src/utils/hash');
    const h = contextService.networkHash('49.207.0.1');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(sha256('49.207.0.0/24'));
    expect(contextService.networkHash('49.207.0.77')).toBe(h); // same /24
  });

  test('location score from the IP-to-GPS distance (Haversine)', () => {
    const hyd = { lat: 17.385, lon: 78.4867 };
    expect(contextService.locationScore(hyd, { lat: 17.4, lon: 78.5 }).score).toBe(35);           // ~2 km
    expect(contextService.locationScore(hyd, { lat: 15.8, lon: 78.0 }).score).toBe(20);           // ~180 km
    expect(contextService.locationScore(hyd, { lat: 28.61, lon: 77.21 }).score).toBe(5);          // Delhi, ~1250 km
    expect(contextService.locationScore(null, { lat: 1, lon: 1 })).toMatchObject({ score: 15, category: 'Location unknown' });
    expect(contextService.locationScore(hyd, null).score).toBe(15);
  });

  test('Haversine distance Hyderabad - Chennai is about 520 km', () => {
    expect(Math.round(contextService.haversineKm(17.385, 78.4867, 13.0827, 80.2707))).toBeGreaterThan(500);
    expect(Math.round(contextService.haversineKm(17.385, 78.4867, 13.0827, 80.2707))).toBeLessThan(540);
  });

  test('network prefixes and IPv4-mapped addresses', () => {
    expect(contextService.normaliseIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(contextService.networkPrefix('10.1.2.3')).toBe('10.1.2.0/24');
    expect(contextService.networkPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
  });

  test('behaviour penalty: minus 10 per failed attempt since the last login, at most minus 30', () => {
    expect(contextService.behaviourPenalty({ failedLoginAttempts: 0 }).score).toBe(0);
    expect(contextService.behaviourPenalty({ failedLoginAttempts: 1 }).score).toBe(-10);
    expect(contextService.behaviourPenalty({ failedLoginAttempts: 4 }).score).toBe(-30);
    expect(contextService.behaviourPenalty({}).failures).toBe(0);
  });

  test('the hour is read in the hospital time zone', () => {
    // 03:30 UTC is 09:00 in India
    expect(contextService.localHour(new Date('2026-11-03T03:30:00Z'), 'Asia/Kolkata')).toBe(9);
  });
});
