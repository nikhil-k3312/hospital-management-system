/**
 * Command-line ledger audit, the same checks as GET /api/ledger/verify.
 *   npm run ledger:verify
 * Exits with code 1 if anything was tampered with (usable in CI or cron).
 */
require('../src/config/config');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const ledgerService = require('../src/services/ledgerService');
const MedicalRecord = require('../src/models/MedicalRecord');
const Prescription = require('../src/models/Prescription');
const Claim = require('../src/models/Claim');
const Bill = require('../src/models/Bill');
const AccessGrant = require('../src/models/AccessGrant');
const Appointment = require('../src/models/Appointment');

const PROTECTED = [
  ['record', MedicalRecord], ['prescription', Prescription], ['consent', AccessGrant],
  ['appointment', Appointment], ['claim', Claim], ['bill', Bill],
];

async function main() {
  await connectMongo();
  let ok = true;

  for (const chain of ['records', 'access']) {
    const result = await ledgerService.verifyChain(chain);
    ok = ok && result.valid;
    console.log(result.valid
      ? `chain "${chain}": valid, ${result.entriesChecked} entries, head ${result.headHash ? `${result.headHash.slice(0, 16)}...` : "(empty)"}`
      : `chain "${chain}": BROKEN at entry #${result.brokenAtSeq} (${result.problem})`);
  }

  for (const [entityType, model] of PROTECTED) {
    const docs = await model.find();
    const results = await Promise.all(docs.map((d) => ledgerService.verifyEntity(entityType, d)));
    const bad = results.filter((r) => !r.matches);
    ok = ok && bad.length === 0;
    console.log(`${entityType.padEnd(12)} ${docs.length} checked, ${bad.length ? `TAMPERED: ${bad.map((b) => b.entityId).join(', ')}` : 'all match the ledger'}`);
  }

  console.log(ok ? '\nLEDGER VALID' : '\nTAMPERING DETECTED');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(disconnectMongo);
