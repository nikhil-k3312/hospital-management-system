const contextService = require('../../src/services/contextService');

describe('contextService', () => {
  test('tiers follow the zero-trust thresholds: >80 low, 50-80 medium, <50 high', () => {
    expect(contextService.tierFor(81)).toMatchObject({ risk: 'low', factors: ['password'] });
    expect(contextService.tierFor(80)).toMatchObject({ risk: 'medium', factors: ['password', 'otp'] });
    expect(contextService.tierFor(50)).toMatchObject({ risk: 'medium' });
    expect(contextService.tierFor(49)).toMatchObject({ risk: 'high', factors: ['password', 'otp', 'security_question'] });
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

  test('the hour is read in the hospital time zone', () => {
    // 03:30 UTC is 09:00 in India
    expect(contextService.localHour(new Date('2026-11-03T03:30:00Z'), 'Asia/Kolkata')).toBe(9);
  });
});
