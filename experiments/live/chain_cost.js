/**
 * Problem 19 (experiment E4): blockchain and ledger cost.
 *
 * Needs a running chain and the deployed contracts, configured in backend/services/api/.env:
 *   CHAIN_RPC_URL, CHAIN_CONTRACT_ADDRESS, CHAIN_PRIVATE_KEY, PATIENT_REF_SECRET
 *   (optional, Problem 26) ROLE_REGISTRY_ADDRESS and GOVERNOR_KEYS=<key1>,<key2>,<key3>
 *   (the private keys of the administrator wallets; local Hardhat or Besu test keys only!)
 *
 *   node chain_cost.js --label hardhat          local Hardhat node
 *   node chain_cost.js --label besu             4-validator Besu QBFT network (Problem 25)
 *   node chain_cost.js --label besu --sizes 1000,10000,100000
 *
 * Measures
 *   1. 100 ledger-head anchors: gas and time until the block is final (Problem 10)
 *   2. role registry: gas and time of one proposal and one approval (k = 2), 20 times
 *   3. full verification time of the access ledger at 1,000 / 10,000 / 100,000 entries
 * Output: out/chain_<label>.csv, out/verify_<label>.csv, out/chain_<label>_summary.txt
 */
const crypto = require('crypto');
const fs = require('fs');
const h = require('./harness');

// CHAIN_*, ROLE_REGISTRY_ADDRESS and GOVERNOR_KEYS come from backend/services/api/.env (loaded by the API's config).

const stats = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const mean = s.reduce((p, x) => p + x, 0) / (s.length || 1);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: Number(mean.toFixed(1)), p50: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] };
};

async function main() {
  const a = h.args();
  const label = a.label || 'chain';
  const sizes = String(a.sizes || '1000,10000,100000').split(',').map(Number);
  await h.start();
  const blockchainService = h.api.require('./src/services/blockchainService');
  const { ethers } = h.api.require('ethers');
  const rows = [];
  const lines = [`label ${label}, RPC ${h.api.config.chain.rpcUrl || '(none)'}`];

  // 1. ledger-head anchors
  if (!blockchainService.enabled) {
    lines.push('Anchoring skipped: CHAIN_* variables are not set in backend/services/api/.env');
  } else {
    const chain = `bench-${Date.now()}`;
    for (let i = 1; i <= 100; i += 1) {
      const r = await blockchainService.anchorLedgerHead(chain, i, crypto.randomBytes(32).toString('hex'));
      rows.push({ operation: 'anchorLedgerHead', i, status: r.status, gas: r.gasUsed ?? '', latency_ms: r.latencyMs ?? '', block: r.blockNumber ?? '' });
      if (r.status !== 'anchored') { lines.push(`anchor ${i} failed: ${r.error}`); break; }
    }
    const ok = rows.filter((r) => r.status === 'anchored');
    lines.push(`anchors: gas ${JSON.stringify(stats(ok.map((r) => r.gas)))}`);
    lines.push(`anchors: time to finality (ms) ${JSON.stringify(stats(ok.map((r) => r.latency_ms)))}`);
    const gas = stats(ok.map((r) => r.gas)).mean;
    [500, 2000, 10000].forEach((loginsPerDay) => {
      // 2 chains x 144 interval anchors + extra anchors when 100 entries accumulate (about 3 access entries per login)
      const anchors = 2 * 144 + Math.ceil((loginsPerDay * 3) / 100);
      lines.push(`  ${loginsPerDay} logins/day -> about ${anchors} anchors/day = ${(anchors * gas / 1e6).toFixed(2)} M gas/day`);
    });
  }

  // 2. role registry (Problem 26)
  const keys = (process.env.GOVERNOR_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (h.api.config.chain.roleRegistryAddress && keys.length >= 2) {
    const provider = new ethers.JsonRpcProvider(h.api.config.chain.rpcUrl);
    const abi = ['function propose(uint8,bytes32,uint8,address,uint8) returns (uint256)', 'function approve(uint256)', 'function proposalCount() view returns (uint256)', 'function threshold() view returns (uint8)'];
    const g1 = new ethers.Contract(h.api.config.chain.roleRegistryAddress, abi, new ethers.NonceManager(new ethers.Wallet(keys[0], provider)));
    const g2 = new ethers.Contract(h.api.config.chain.roleRegistryAddress, abi, new ethers.NonceManager(new ethers.Wallet(keys[1], provider)));
    lines.push(`role registry threshold k = ${await g1.threshold()}`);
    for (let i = 0; i < 20; i += 1) {
      const subject = ethers.keccak256(ethers.toUtf8Bytes(`bench-${Date.now()}-${i}`));
      let t = Date.now();
      const p = await (await g1.propose(0, subject, 1, ethers.ZeroAddress, 0)).wait();
      rows.push({ operation: 'role propose (approval 1)', i, status: 'ok', gas: Number(p.gasUsed), latency_ms: Date.now() - t, block: p.blockNumber });
      const id = Number(await g1.proposalCount()) - 1;
      t = Date.now();
      const ap = await (await g2.approve(id)).wait();
      rows.push({ operation: 'role approve (approval 2, executes)', i, status: 'ok', gas: Number(ap.gasUsed), latency_ms: Date.now() - t, block: ap.blockNumber });
    }
    ['role propose (approval 1)', 'role approve (approval 2, executes)'].forEach((op) => {
      const sel = rows.filter((r) => r.operation === op);
      lines.push(`${op}: gas ${JSON.stringify(stats(sel.map((r) => r.gas)))}, ms ${JSON.stringify(stats(sel.map((r) => r.latency_ms)))}`);
    });
    // login-time cost of the on-chain role check: cache miss vs cache hit
    const roleService = h.api.require('./src/services/roleService');
    const u = await h.createUser('doctor');
    const salt = await roleService.constructor.ensureSalt(u);
    const miss = []; const hit = [];
    for (let i = 0; i < 50; i += 1) {
      await roleService.invalidate(u._id);
      let t = process.hrtime.bigint(); await roleService.hasRole(u._id, 'doctor', salt); miss.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint(); await roleService.hasRole(u._id, 'doctor', salt); hit.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    lines.push(`role check: cache miss ms ${JSON.stringify(stats(miss.map((x) => Number(x.toFixed(2)))))}, cache hit ms ${JSON.stringify(stats(hit.map((x) => Number(x.toFixed(3)))))}`);
  } else {
    lines.push('Role registry skipped: set ROLE_REGISTRY_ADDRESS and GOVERNOR_KEYS (two governor private keys) to measure it');
  }

  // 2b. emergency sign-in review (D12): the hospital opens a case, two administrators close it
  if (h.api.config.chain.emergencyReviewAddress && keys.length >= 2) {
    const provider = new ethers.JsonRpcProvider(h.api.config.chain.rpcUrl);
    const abi = ['function openCase(bytes32,bytes32,bytes32)', 'function review(bytes32,uint8)'];
    const hospital = new ethers.Contract(h.api.config.chain.emergencyReviewAddress, abi, blockchainService.writer());
    const r1 = new ethers.Contract(h.api.config.chain.emergencyReviewAddress, abi, new ethers.NonceManager(new ethers.Wallet(keys[0], provider)));
    const r2 = new ethers.Contract(h.api.config.chain.emergencyReviewAddress, abi, new ethers.NonceManager(new ethers.Wallet(keys[1], provider)));
    for (let i = 0; i < 20; i += 1) {
      const caseId = ethers.keccak256(ethers.toUtf8Bytes(`bench-case-${Date.now()}-${i}`));
      const subject = ethers.keccak256(ethers.toUtf8Bytes(`bench-subject-${i}`));
      const reason = ethers.keccak256(ethers.toUtf8Bytes(`bench-reason-${i}`));
      let t = Date.now();
      const o = await (await hospital.openCase(caseId, subject, reason)).wait();
      rows.push({ operation: 'emergency case open (hospital)', i, status: 'ok', gas: Number(o.gasUsed), latency_ms: Date.now() - t, block: o.blockNumber });
      t = Date.now();
      const v1 = await (await r1.review(caseId, 1)).wait();
      rows.push({ operation: 'emergency review (verdict 1)', i, status: 'ok', gas: Number(v1.gasUsed), latency_ms: Date.now() - t, block: v1.blockNumber });
      t = Date.now();
      const v2 = await (await r2.review(caseId, 1)).wait();
      rows.push({ operation: 'emergency review (verdict 2, closes)', i, status: 'ok', gas: Number(v2.gasUsed), latency_ms: Date.now() - t, block: v2.blockNumber });
    }
    ['emergency case open (hospital)', 'emergency review (verdict 1)', 'emergency review (verdict 2, closes)'].forEach((op) => {
      const sel = rows.filter((r) => r.operation === op);
      lines.push(`${op}: gas ${JSON.stringify(stats(sel.map((r) => r.gas)))}, ms ${JSON.stringify(stats(sel.map((r) => r.latency_ms)))}`);
    });
  } else {
    lines.push('Emergency review skipped: set EMERGENCY_REVIEW_ADDRESS and GOVERNOR_KEYS (two governor private keys) to measure it');
  }

  // 3. verification time vs ledger size (entries written directly, with correct hashes)
  const verifyRows = [];
  const { LedgerEntry, ledgerService } = h.api;
  for (const size of sizes) {
    await LedgerEntry.deleteMany({ chain: 'access' });
    let prev = null;
    const batch = [];
    const flush = async () => { if (batch.length) await LedgerEntry.collection.insertMany(batch.splice(0)); };
    for (let seq = 0; seq < size; seq += 1) {
      const e = { chain: 'access', seq, entityType: 'access_decision', entityId: `GET /api/x/${seq}`, action: seq % 7 ? 'ALLOW' : 'DENY',
        actorId: null, actorRole: 'patient', payloadHash: null, meta: { reason: 'bench', trustScore: 100 }, timestamp: new Date(), previousEntryHash: prev };
      e.entryHash = ledgerService.computeEntryHash(e);
      prev = e.entryHash;
      batch.push(e);
      if (batch.length === 5000) await flush();
    }
    await flush();
    const t = process.hrtime.bigint();
    const r = await ledgerService.verifyChain('access');
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    verifyRows.push({ entries: size, valid: r.valid, verify_ms: ms.toFixed(0), ms_per_1000_entries: (ms / (size / 1000)).toFixed(1) });
    lines.push(`verify ${size} entries: ${ms.toFixed(0)} ms (${r.valid ? 'valid' : 'INVALID'})`);
  }

  h.writeCsv(`${h.OUT}/chain_${label}.csv`, rows);
  h.writeCsv(`${h.OUT}/verify_${label}.csv`, verifyRows);
  fs.writeFileSync(`${h.OUT}/chain_${label}_summary.txt`, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  console.log(`\nWritten to ${h.OUT}/chain_${label}*.csv and chain_${label}_summary.txt. Send me these files.`);
  await h.stop();
}

main().catch(async (e) => { console.error(e); await h.stop(); process.exit(1); });
