/**
 * Re-sends blockchain anchors that could not be written when the chain was down,
 * then anchors the current head of the records ledger.
 *   npm run chain:anchor-pending        (safe to run from cron every few minutes)
 *
 * A pending record is anchored only if it still matches the hash-chain ledger:
 * content changed behind the API's back must never be "blessed" on-chain.
 */
require('../src/config/config');
const { connectMongo, disconnectMongo } = require('../src/db/mongo');
const ledgerService = require('../src/services/ledgerService');
const blockchainService = require('../src/services/blockchainService');
const MedicalRecord = require('../src/models/MedicalRecord');
const { hashObject } = require('../src/utils/hash');

async function main() {
  if (!blockchainService.enabled) {
    console.log('Blockchain anchoring is not configured (CHAIN_* variables). Nothing to do.');
    return;
  }
  await connectMongo();

  const records = await MedicalRecord.find({ $or: [{ 'chain.status': 'pending' }, { 'attachments.chain.status': 'pending' }] });
  let anchored = 0;
  let refused = 0;

  for (const record of records) {
    if (record.chain.status === 'pending') {
      const check = await ledgerService.verifyEntity('record', record);
      if (!check.matches) {
        refused += 1;
        console.log(`record ${record._id}: does NOT match the ledger, not anchored`);
      } else {
        const result = await blockchainService.anchor({
          entityType: 'record', entityId: record._id.toString(), version: record.version,
          dataHash: hashObject(record.ledgerPayload()), patientId: record.patientId.toString(),
        });
        record.chain = { status: result.status, key: result.key, txHash: result.txHash || null, blockNumber: result.blockNumber || null, version: record.version };
        if (result.status === 'anchored') anchored += 1;
      }
    }
    for (const attachment of record.attachments.filter((a) => a.chain.status === 'pending')) {
      const result = await blockchainService.anchor({
        entityType: 'file', entityId: attachment.fileId, version: 1, dataHash: attachment.sha256, patientId: record.patientId.toString(),
      });
      attachment.chain = { status: result.status, key: result.key, txHash: result.txHash || null, blockNumber: result.blockNumber || null, version: 1 };
      if (result.status === 'anchored') anchored += 1;
    }
    await record.save();
  }

  // One more anchor seals the whole ledger up to now: its head hash depends on every entry before it.
  const head = await ledgerService.verifyChain('records');
  if (head.valid && head.headHash) {
    const result = await blockchainService.anchor({ entityType: 'ledger', entityId: 'records', version: head.entriesChecked, dataHash: head.headHash });
    console.log(`ledger head (${head.entriesChecked} entries): ${result.status}`);
  } else if (!head.valid) {
    console.log(`records ledger is BROKEN at entry #${head.brokenAtSeq}: head not anchored`);
  }

  console.log(`anchored ${anchored}, refused ${refused}`);
  await disconnectMongo();
  if (refused > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
