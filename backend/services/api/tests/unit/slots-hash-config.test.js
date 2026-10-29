const { buildDaySlots, isValidSlot } = require('../../src/modules/appointments/slots');
const { canonicalJSON, hashObject } = require('../../src/utils/hash');
const { validateConfig } = require('../../src/config/config');
const { findAbnormal } = require('../../src/models/VitalReading');

describe('buildDaySlots', () => {
  const availability = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 12, slotMinutes: 30 };
  const now = new Date(2030, 0, 1, 0, 0); // a Tuesday, midnight

  test('creates slots every slotMinutes between start and end on working days', () => {
    const slots = buildDaySlots(availability, '2030-01-01', 60, now);
    expect(slots).toHaveLength(6);
    expect(slots[0].start).toEqual(new Date(2030, 0, 1, 9, 0));
    expect(slots[5].end).toEqual(new Date(2030, 0, 1, 12, 0));
  });

  test('returns nothing on a non-working day or beyond the booking window', () => {
    expect(buildDaySlots(availability, '2030-01-05', 60, now)).toEqual([]); // Saturday
    expect(buildDaySlots(availability, '2030-06-03', 60, now)).toEqual([]); // > 60 days ahead
  });

  test('skips slots that are already in the past', () => {
    const lateMorning = new Date(2030, 0, 1, 10, 15);
    expect(buildDaySlots(availability, '2030-01-01', 60, lateMorning).map((s) => s.start.getHours() * 60 + s.start.getMinutes()))
      .toEqual([10 * 60 + 30, 11 * 60, 11 * 60 + 30]);
  });

  test('isValidSlot accepts only exact slot boundaries', () => {
    expect(isValidSlot(availability, new Date(2030, 0, 1, 9, 30), 60, now)).toBe(true);
    expect(isValidSlot(availability, new Date(2030, 0, 1, 9, 45), 60, now)).toBe(false);
    expect(isValidSlot(availability, new Date(2030, 0, 1, 13, 0), 60, now)).toBe(false);
  });
});

describe('canonical hashing', () => {
  test('key order does not change the hash', () => {
    expect(hashObject({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashObject({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });

  test('any value change does', () => {
    expect(hashObject({ diagnosis: 'Hypertension' })).not.toBe(hashObject({ diagnosis: 'hypertension' }));
  });

  test('dates serialise as ISO strings and undefined keys are dropped', () => {
    expect(canonicalJSON({ when: new Date('2030-01-01T00:00:00Z'), skip: undefined })).toBe('{"when":"2030-01-01T00:00:00.000Z"}');
  });
});

describe('validateConfig', () => {
  const base = { MONGODB_URI: 'mongodb://x', JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'b' };
  const cfg = (transport, isProduction = false) => ({ email: { transport }, isProduction });

  test('passes with the required variables', () => {
    expect(validateConfig(cfg('console'), base)).toBe(true);
  });

  test('fails fast on a missing variable', () => {
    expect(() => validateConfig(cfg('console'), { ...base, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
  });

  test('requires SMTP credentials for the smtp transport', () => {
    expect(() => validateConfig(cfg('smtp'), base)).toThrow(/EMAIL_USER, EMAIL_PASSWORD/);
  });

  test('refuses console email in production', () => {
    expect(() => validateConfig(cfg('console', true), base)).toThrow(/production/);
  });

  test('refuses identical access and refresh secrets', () => {
    expect(() => validateConfig(cfg('console'), { ...base, JWT_REFRESH_SECRET: 'a' })).toThrow(/different/);
  });
});

describe('findAbnormal', () => {
  test('flags only out-of-range vitals', () => {
    expect(findAbnormal({ heartRate: 72, systolic: 150, spo2: 91, temperature: null })).toEqual(['systolic', 'spo2']);
  });
});
