/**
 * Tamper demonstration: plays a malicious insider with direct database
 * access. It edits a medical record straight in MongoDB, bypassing the API,
 * so no ledger entry is written. "Verify ledger" in the admin dashboard (or
 * npm run ledger:verify) then flags the record as tampered.
 *
 *   npm run demo:tamper              change Arjun Mehta's hypertension diagnosis
 *   npm run demo:tamper -- --restore put the original text back (verification passes again)
 *   npm run demo:tamper -- --ledger  edit a ledger entry instead (breaks the hash chain)
 *
 * Attacks that the hash chain alone cannot detect; the blockchain anchor does (Problem 10):
 *   npm run demo:tamper -- --rewrite   change an old sign-in decision in the access chain (DENY -> ALLOW)
 *                                      AND recompute every later hash, so the chain looks valid again
 *   npm run demo:tamper -- --truncate  delete the newest 5 entries of the access chain
 *   npm run demo:tamper -- --restore   undoes any of the above
 * Run "npm run chain:anchor-pending" (or wait for the scheduler) BEFORE the attack so a head is
 * anchored, then "npm run ledger:verify": the access chain no longer matches its on-chain anchor.
 */
const fs = require('fs');
const path = require('path');
require('../src/config/config');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const MedicalRecord = require('../src/models/MedicalRecord');
const LedgerEntry = require('../src/models/LedgerEntry');
const { computeEntryHash } = require('../src/services/ledgerService');

const STATE = path.join(__dirname, '.tamper-state.json');

async function main() {
  await connectMongo();

  if (process.argv.includes('--restore')) {
    if (!fs.existsSync(STATE)) throw new Error('Nothing to restore.');
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (state.recordId) await MedicalRecord.collection.updateOne({ _id: new MedicalRecord.base.Types.ObjectId(state.recordId) }, { $set: { diagnosis: state.original } });
    if (state.ledgerId) await LedgerEntry.collection.updateOne({ _id: new LedgerEntry.base.Types.ObjectId(state.ledgerId) }, { $set: { action: state.original } });
    // rewrite / truncate: put the saved original documents back exactly as they were
    for (const doc of state.originals || []) {
      const original = { ...doc, _id: new LedgerEntry.base.Types.ObjectId(doc._id), timestamp: new Date(doc.timestamp) };
      await LedgerEntry.collection.replaceOne({ _id: original._id }, original, { upsert: true });
    }
    fs.unlinkSync(STATE);
    console.log('Restored the original value. Verification will pass again.');
    return;
  }

  if (process.argv.includes('--rewrite')) {
    // An insider who knows the hashing scheme: edit one old entry, then recompute every later hash.
    const target = await LedgerEntry.findOne({ chain: 'access', action: 'DENY' }).sort({ seq: 1 }).lean()
      || await LedgerEntry.findOne({ chain: 'access' }).sort({ seq: 1 }).lean();
    if (!target) throw new Error('The access chain is empty. Sign in a few times first.');
    const later = await LedgerEntry.find({ chain: 'access', seq: { $gte: target.seq } }).sort({ seq: 1 }).lean();
    fs.writeFileSync(STATE, JSON.stringify({ originals: later }));
    let previousHash = target.previousEntryHash;
    for (const entry of later) {
      const changed = { ...entry, previousEntryHash: previousHash };
      if (entry.seq === target.seq) changed.action = target.action === 'DENY' ? 'ALLOW' : 'DENY';
      changed.entryHash = computeEntryHash(changed);
      await LedgerEntry.collection.updateOne({ _id: entry._id }, { $set: { action: changed.action, previousEntryHash: changed.previousEntryHash, entryHash: changed.entryHash } });
      previousHash = changed.entryHash;
    }
    console.log(`Rewrote access entry #${target.seq} (${target.action} -> ${target.action === 'DENY' ? 'ALLOW' : 'DENY'}) and recomputed ${later.length} hashes.`);
    console.log('The hash chain alone now looks valid. "npm run ledger:verify" detects it through the on-chain anchor.');
    return;
  }

  if (process.argv.includes('--truncate')) {
    const newest = await LedgerEntry.find({ chain: 'access' }).sort({ seq: -1 }).limit(5).lean();
    if (!newest.length) throw new Error('The access chain is empty. Sign in a few times first.');
    fs.writeFileSync(STATE, JSON.stringify({ originals: newest }));
    await LedgerEntry.collection.deleteMany({ _id: { $in: newest.map((e) => e._id) } });
    console.log(`Deleted the newest ${newest.length} access entries (#${newest[newest.length - 1].seq}-#${newest[0].seq}).`);
    console.log('The remaining chain is still internally valid. "npm run ledger:verify" detects it if an anchor covered them.');
    return;
  }

  if (process.argv.includes('--ledger')) {
    const entry = await LedgerEntry.findOne({ chain: 'records', entityType: 'record', action: 'CREATE' }).sort({ seq: 1 });
    fs.writeFileSync(STATE, JSON.stringify({ ledgerId: entry._id.toString(), original: entry.action }));
    await LedgerEntry.collection.updateOne({ _id: entry._id }, { $set: { action: 'DELETE' } });
    console.log(`Rewrote ledger entry #${entry.seq}: action CREATE -> DELETE (directly in MongoDB).`);
    console.log('Now click "Verify ledger" in the admin dashboard: the records chain breaks at this entry.');
    return;
  }

  const record = await MedicalRecord.findOne({ title: 'Stage 1 essential hypertension' });
  if (!record) throw new Error('Seeded record not found. Run "npm run seed -- --reset" first.');
  fs.writeFileSync(STATE, JSON.stringify({ recordId: record._id.toString(), original: record.diagnosis }));
  // updateOne on the raw collection: no API, no validation, no ledger entry. What an insider with DB access could do.
  await MedicalRecord.collection.updateOne({ _id: record._id }, { $set: { diagnosis: 'No hypertension. Patient healthy.' } });
  console.log(`Changed record ${record._id} directly in MongoDB:`);
  console.log(`  before: "${record.diagnosis}"`);
  console.log('  after:  "No hypertension. Patient healthy."');
  console.log('Now click "Verify ledger" in the admin dashboard, or "Verify integrity" on the record.');
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(disconnectMongo);
