/**
 * End-to-end storage test against a real IPFS (Kubo) node and a real EVM chain.
 * Runs only when both are available:
 *   IPFS_TEST_API=http://127.0.0.1:5001  CHAIN_TEST_RPC=http://127.0.0.1:8545  npx jest ipfs-blockchain
 * (start them with `ipfs daemon --offline` and `npx hardhat node` in blockchain/).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('../../src/config/config');
const blockchainService = require('../../src/services/blockchainService');
const { setupDatabase, resetDatabase, teardownDatabase, createUser, login, as } = require('../helpers');
const MedicalRecord = require('../../src/models/MedicalRecord');

const IPFS = process.env.IPFS_TEST_API;
const RPC = process.env.CHAIN_TEST_RPC;
// Account #0 of every local Hardhat node: public, for local testing only.
const HARDHAT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ARTIFACT = path.join(__dirname, '../../../../../blockchain/artifacts/contracts/HealthRecordRegistry.sol/HealthRecordRegistry.json');

const suite = IPFS && RPC ? describe : describe.skip;

suite('IPFS storage with hash-only blockchain anchoring', () => {
  let contract;

  beforeAll(async () => {
    await setupDatabase();
    const { abi, bytecode } = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
    const wallet = new ethers.NonceManager(new ethers.Wallet(HARDHAT_KEY, new ethers.JsonRpcProvider(RPC)));
    contract = await new ethers.ContractFactory(abi, bytecode, wallet).deploy();
    await contract.waitForDeployment();

    Object.assign(config.ipfs, { apiUrl: IPFS, encryptionKey: crypto.randomBytes(32).toString('hex') });
    Object.assign(config.chain, {
      rpcUrl: RPC, contractAddress: await contract.getAddress(), privateKey: HARDHAT_KEY, patientRefSecret: 'test-patient-ref-secret',
    });
    blockchainService.contract = null;
  }, 60000);
  beforeEach(resetDatabase);
  afterAll(async () => {
    Object.assign(config.ipfs, { apiUrl: '', encryptionKey: '' });
    Object.assign(config.chain, { rpcUrl: '', contractAddress: '', privateKey: '', patientRefSecret: '' });
    await teardownDatabase();
  });

  async function world() {
    const doctorUser = await createUser('doctor');
    const patientUser = await createUser('patient');
    const doctor = await login(doctorUser);
    const patient = await login(patientUser);
    const req = await as(doctor).post('/api/consents/request').send({ patientId: String(patientUser._id), purpose: 'Diabetes follow-up' });
    await as(patient).post(`/api/consents/${req.body.data._id}/approve`).send({ durationDays: 7 });
    const rec = await as(doctor).post('/api/records').send({
      patientId: String(patientUser._id), recordType: 'lab_result', title: 'HbA1c panel', findings: 'HbA1c 7.9%',
    });
    return { doctor, patient, patientUser, record: rec.body.data };
  }

  test('a new record version is anchored on-chain as a hash, with no patient data', async () => {
    const { record, patientUser } = await world();
    const stored = await MedicalRecord.findById(record._id);
    expect(stored.chain.status).toBe('anchored');
    expect(stored.chain.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const anchor = await contract.getAnchor(stored.chain.key);
    expect(anchor.kind).toBe(1n);
    // What is on-chain is only 32-byte hashes: no id, name or finding appears anywhere.
    const onChain = JSON.stringify([anchor.dataHash, anchor.patientRef]);
    expect(onChain).not.toContain(String(patientUser._id));
    expect(anchor.patientRef).not.toBe(ethers.ZeroHash);
  });

  test('upload: encrypted bytes go to IPFS, only the CID stays in MongoDB, download returns the original', async () => {
    const { doctor, record } = await world();
    const pdf = Buffer.from('%PDF-1.4 lab report HbA1c 7.9% for this patient');

    const up = await as(doctor).post(`/api/records/${record._id}/files`).attach('file', pdf, { filename: 'hba1c.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.data.storage).toBe('ipfs');
    expect(up.body.data.chain).toBe('anchored');
    const { cid, fileId, sha256 } = up.body.data;
    expect(sha256).toBe(crypto.createHash('sha256').update(pdf).digest('hex'));

    // The raw IPFS object is ciphertext, not the PDF.
    const raw = Buffer.from(await (await fetch(`${IPFS}/api/v0/cat?arg=${cid}`, { method: 'POST' })).arrayBuffer());
    expect(raw.includes(Buffer.from('HbA1c'))).toBe(false);

    const down = await as(doctor).get(`/api/files/${fileId}`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(down.status).toBe(200);
    expect(down.body.equals(pdf)).toBe(true);

    const verify = await as(doctor).get(`/api/records/${record._id}/verify`);
    expect(verify.body.data.intact).toBe(true);
    expect(verify.body.data.chain.matches).toBe(true);
    expect(verify.body.data.files[0].chain.matches).toBe(true);
  }, 60000);

  test('an edit made directly in MongoDB no longer matches the blockchain', async () => {
    const { doctor, record } = await world();
    await MedicalRecord.collection.updateOne({ _id: new MedicalRecord.base.Types.ObjectId(record._id) }, { $set: { findings: 'HbA1c 5.2%' } });

    const verify = await as(doctor).get(`/api/records/${record._id}/verify`);
    expect(verify.body.data.intact).toBe(false);
    expect(verify.body.data.chain.anchored).toBe(true);
    expect(verify.body.data.chain.matches).toBe(false);
  });

  test('a CID swapped in the database is refused on download', async () => {
    const { doctor, record } = await world();
    const up = await as(doctor).post(`/api/records/${record._id}/files`).attach('file', Buffer.from('original scan'), { filename: 'scan.txt', contentType: 'text/plain' });
    const other = await as(doctor).post(`/api/records/${record._id}/files`).attach('file', Buffer.from('a different file'), { filename: 'other.txt', contentType: 'text/plain' });
    await MedicalRecord.collection.updateOne(
      { _id: new MedicalRecord.base.Types.ObjectId(record._id), 'attachments.fileId': up.body.data.fileId },
      { $set: { 'attachments.$.cid': other.body.data.cid } },
    );
    const down = await as(doctor).get(`/api/files/${up.body.data.fileId}`);
    expect(down.status).toBe(409);
    expect(down.body.code).toBe('FILE_ALTERED');
  }, 60000);
});
