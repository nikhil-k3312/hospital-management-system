const LedgerEntry = require('../../src/models/LedgerEntry');
const ledgerService = require('../../src/services/ledgerService');
const { setupDatabase, resetDatabase, teardownDatabase } = require('../helpers');

beforeAll(setupDatabase);
beforeEach(resetDatabase);
afterAll(teardownDatabase);

const append = (n, chain = 'records') => ledgerService.append({
  chain, entityType: 'record', entityId: `rec${n}`, action: 'CREATE', actorId: 'u1', actorRole: 'doctor', payload: { n },
});

describe('ledgerService', () => {
  test('the first entry is the genesis block and each entry links to the previous hash', async () => {
    const a = await append(1);
    const b = await append(2);
    expect(a.seq).toBe(0);
    expect(a.previousEntryHash).toBeNull();
    expect(b.seq).toBe(1);
    expect(b.previousEntryHash).toBe(a.entryHash);
    expect(b.entryHash).toBe(ledgerService.computeEntryHash(b.toObject()));
  });

  test('concurrent appends never fork the chain', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => append(i)));
    const entries = await LedgerEntry.find({ chain: 'records' }).sort({ seq: 1 }).lean();
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(await ledgerService.verifyChain('records')).toMatchObject({ valid: true, entriesChecked: 25 });
  });

  test('chains are independent', async () => {
    await append(1, 'records');
    const accessEntry = await append(1, 'access');
    expect(accessEntry.seq).toBe(0);
  });

  test('editing an entry directly in the database is detected', async () => {
    for (let i = 0; i < 5; i += 1) await append(i);
    await LedgerEntry.updateOne({ chain: 'records', seq: 2 }, { $set: { action: 'DELETE' } });
    expect(await ledgerService.verifyChain('records')).toMatchObject({ valid: false, brokenAtSeq: 2, problem: 'entry_modified' });
  });

  test('re-hashing an edited entry still breaks the next link', async () => {
    for (let i = 0; i < 5; i += 1) await append(i);
    const entry = await LedgerEntry.findOne({ chain: 'records', seq: 2 }).lean();
    entry.action = 'DELETE';
    await LedgerEntry.updateOne({ _id: entry._id }, { $set: { action: 'DELETE', entryHash: ledgerService.computeEntryHash(entry) } });
    expect(await ledgerService.verifyChain('records')).toMatchObject({ valid: false, brokenAtSeq: 3, problem: 'broken_link' });
  });

  test('a deleted entry is detected as a gap', async () => {
    for (let i = 0; i < 4; i += 1) await append(i);
    await LedgerEntry.deleteOne({ chain: 'records', seq: 1 });
    expect(await ledgerService.verifyChain('records')).toMatchObject({ valid: false, brokenAtSeq: 1, problem: 'missing_entry' });
  });

  test('verifyEntity compares a document with its last ledger payload', async () => {
    const doc = { _id: 'rec42', diagnosis: 'Hypertension', ledgerPayload() { return { diagnosis: this.diagnosis }; } };
    await ledgerService.recordEvent({ entityType: 'record', entity: doc, action: 'CREATE', actor: { userId: 'u1', role: 'doctor' } });
    expect((await ledgerService.verifyEntity('record', doc)).matches).toBe(true);
    doc.diagnosis = 'Healthy';
    expect((await ledgerService.verifyEntity('record', doc)).matches).toBe(false);
  });
});
