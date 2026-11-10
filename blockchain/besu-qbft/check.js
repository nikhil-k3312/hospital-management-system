/**
 * Problem 25 checks for the Besu QBFT network.
 *   node besu-qbft/check.js                     block production and the validator set
 *   node besu-qbft/check.js --watch 60          prints the block height every 2 s for 60 s
 *                                               (use it during the fault tests below)
 * Fault test 1: docker stop medichain-validator4   -> blocks continue (3 of 4 still agree)
 * Fault test 2: docker stop medichain-validator3   -> blocks STOP (no quorum, nothing wrong is finalised)
 *               docker start medichain-validator3 medichain-validator4  -> blocks continue
 */
const { ethers } = require('ethers');

const url = process.env.BESU_RPC_URL || 'http://127.0.0.1:8545';
const provider = new ethers.JsonRpcProvider(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const watch = process.argv.indexOf('--watch');
  let first;
  for (let i = 0; i < 30; i += 1) {
    try { first = await provider.getBlockNumber(); break; } catch (e) { process.stdout.write('.'); await sleep(2000); }
  }
  if (first === undefined) throw new Error(`No answer from ${url}. Is "docker compose up" running?`);
  const validators = await provider.send('qbft_getValidatorsByBlockNumber', ['latest']);
  console.log(`\nRPC ${url}: chain ${Number((await provider.getNetwork()).chainId)}, block ${first}, ${validators.length} validators`);
  validators.forEach((v) => console.log(`  ${v}`));
  if (watch === -1) {
    await sleep(5000);
    const later = await provider.getBlockNumber();
    console.log(later > first ? `Blocks are being produced (${first} -> ${later} in 5 s).` : 'NO new blocks in 5 s: check that at least 3 validators are running.');
    return;
  }
  const seconds = Number(process.argv[watch + 1] || 60);
  const start = Date.now();
  let last = first;
  while (Date.now() - start < seconds * 1000) {
    await sleep(2000);
    let height;
    try { height = await provider.getBlockNumber(); } catch (e) { height = null; }
    console.log(`${new Date().toISOString()}  block ${height ?? 'no answer'}${height !== null && height === last ? '  (stalled)' : ''}`);
    if (height !== null) last = height;
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
