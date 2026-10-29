/**
 * Tamper demonstration: plays a malicious insider with direct database
 * access. It edits a medical record straight in MongoDB, bypassing the API,
 * so no ledger entry is written. "Verify ledger" in the admin dashboard (or
 * npm run ledger:verify) then flags the record as tampered.
 *
 *   npm run demo:tamper              change Arjun Mehta's hypertension diagnosis
 *   npm run demo:tamper -- --restore put the original text back (verification passes again)
 *   npm run demo:tamper -- --ledger  edit a ledger entry instead (breaks the hash chain)
 */
const fs = require('fs');
const path = require('path');
require('../src/config/config');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const MedicalRecord = require('../src/models/MedicalRecord');
const LedgerEntry = require('../src/models/LedgerEntry');

const STATE = path.join(__dirname, '.tamper-state.json');

async function main() {
  await connectMongo();

  if (process.argv.includes('--restore')) {
    if (!fs.existsSync(STATE)) throw new Error('Nothing to restore.');
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (state.recordId) await MedicalRecord.collection.updateOne({ _id: new MedicalRecord.base.Types.ObjectId(state.recordId) }, { $set: { diagnosis: state.original } });
    if (state.ledgerId) await LedgerEntry.collection.updateOne({ _id: new LedgerEntry.base.Types.ObjectId(state.ledgerId) }, { $set: { action: state.original } });
    fs.unlinkSync(STATE);
    console.log('Restored the original value. Verification will pass again.');
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
