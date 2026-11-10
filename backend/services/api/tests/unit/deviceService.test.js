const { uaFamily } = require('../../src/services/deviceService');
const { ipHash, hmac } = require('../../src/utils/hash');

const CHROME_WIN_130 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('browser family + OS (review issue 7)', () => {
  test('a browser update keeps the same family, so the trusted device is not forgotten', () => {
    expect(uaFamily(CHROME_WIN_130)).toBe('Chrome|Windows');
    expect(uaFamily(CHROME_WIN_130.replace('Chrome/130', 'Chrome/131'))).toBe('Chrome|Windows');
  });
  test('different browsers and systems stay different', () => {
    expect(uaFamily('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Firefox|Linux');
    expect(uaFamily(`${CHROME_WIN_130} Edg/130.0.0.0`)).toBe('Edge|Windows');
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari|iOS');
    expect(uaFamily('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Chrome|Android');
  });
  test('an unrecognised user-agent is kept whole', () => {
    expect(uaFamily('jest')).toBe('jest');
    expect(uaFamily('')).toBe('');
  });
});

describe('IP hashes are the same everywhere (review issue 12)', () => {
  test('an IPv4-mapped address hashes like the plain address', () => {
    expect(ipHash('::ffff:49.207.0.1')).toBe(ipHash('49.207.0.1'));
    expect(ipHash('49.207.0.1')).toBe(hmac('49.207.0.1'));
  });
});
