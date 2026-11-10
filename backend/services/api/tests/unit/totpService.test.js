const totp = require('../../src/services/totpService');

// RFC 6238 Appendix B test vectors (SHA-1). The secret is the ASCII string "12345678901234567890".
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

describe('totpService (Problem 2)', () => {
  test('matches the RFC 6238 test vectors (8 digits)', () => {
    const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
    vectors.forEach(([seconds, expected]) => {
      expect(totp.hotp(totp.base32Decode(RFC_SECRET), Math.floor(seconds / 30), 8)).toBe(expected);
    });
  });

  test('base32 round trip', () => {
    const secret = totp.newSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.base32Encode(totp.base32Decode(secret))).toBe(secret);
  });

  test('accepts the current code and one step of drift, rejects others', () => {
    const secret = totp.newSecret();
    const now = Date.now();
    expect(totp.check(secret, totp.codeAt(secret, now), { timeMs: now }).ok).toBe(true);
    expect(totp.check(secret, totp.codeAt(secret, now - 30000), { timeMs: now }).ok).toBe(true);
    expect(totp.check(secret, totp.codeAt(secret, now + 30000), { timeMs: now }).ok).toBe(true);
    const old = totp.codeAt(secret, now - 120000);
    if (old !== totp.codeAt(secret, now) && old !== totp.codeAt(secret, now - 30000) && old !== totp.codeAt(secret, now + 30000)) {
      expect(totp.check(secret, old, { timeMs: now })).toEqual({ ok: false, reason: 'wrong' });
    }
    expect(totp.check(secret, '12ab56', { timeMs: now })).toEqual({ ok: false, reason: 'format' });
  });

  test('a code whose step was already used is rejected (replay)', () => {
    const secret = totp.newSecret();
    const now = Date.now();
    const first = totp.check(secret, totp.codeAt(secret, now), { timeMs: now });
    expect(first.ok).toBe(true);
    expect(totp.check(secret, totp.codeAt(secret, now), { timeMs: now, lastStep: first.step })).toEqual({ ok: false, reason: 'reused' });
    expect(totp.check(secret, totp.codeAt(secret, now - 30000), { timeMs: now, lastStep: first.step }).ok).toBe(false); // older step
  });

  test('secrets are stored encrypted (AES-256-GCM) and tampering is detected', () => {
    const secret = totp.newSecret();
    const stored = totp.encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(totp.decryptSecret(stored)).toBe(secret);
    const [iv, tag, data] = stored.split('.');
    const flipped = `${iv}.${tag}.${(parseInt(data[0], 16) ^ 1).toString(16)}${data.slice(1)}`;
    expect(() => totp.decryptSecret(flipped)).toThrow();
  });

  test('otpauth URI for authenticator apps', () => {
    expect(totp.otpauthUri('ABCDEF', 'a@b.com')).toBe('otpauth://totp/MediChain%3Aa%40b.com?secret=ABCDEF&issuer=MediChain&algorithm=SHA1&digits=6&period=30');
  });
});
