const crypto = require('crypto');
const { IpfsService } = require('../../src/services/ipfsService');

const service = new IpfsService({ apiUrl: 'http://unused', encryptionKey: crypto.randomBytes(32).toString('hex'), timeoutMs: 1000 });

describe('ipfsService encryption', () => {
  test('round-trips bytes and never stores them in the clear', () => {
    const plain = Buffer.from('Lab report: HbA1c 7.9%');
    const blob = service.encrypt(plain);
    expect(blob.includes(plain)).toBe(false);
    expect(blob.length).toBe(plain.length + 12 + 16);
    expect(service.decrypt(blob).equals(plain)).toBe(true);
  });

  test('the same file encrypts differently each time (random IV)', () => {
    const plain = Buffer.from('same bytes');
    expect(service.encrypt(plain).equals(service.encrypt(plain))).toBe(false);
  });

  test('a single changed byte is detected by the GCM tag', () => {
    const blob = service.encrypt(Buffer.from('Prescription: Apixaban 5 mg'));
    blob[blob.length - 1] ^= 0x01;
    expect(() => service.decrypt(blob)).toThrow();
  });

  test('a different key cannot read the file', () => {
    const other = new IpfsService({ apiUrl: 'http://unused', encryptionKey: crypto.randomBytes(32).toString('hex') });
    expect(() => other.decrypt(service.encrypt(Buffer.from('secret')))).toThrow();
  });

  test('is disabled until both the API URL and key are set', () => {
    expect(new IpfsService({ apiUrl: '', encryptionKey: '' }).enabled).toBe(false);
    expect(service.enabled).toBe(true);
  });
});
