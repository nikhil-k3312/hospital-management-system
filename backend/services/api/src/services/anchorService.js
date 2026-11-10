const config = require('../config/config');
const logger = require('../utils/logger');
const LedgerEntry = require('../models/LedgerEntry');
const LedgerAnchor = require('../models/LedgerAnchor');
const ledgerService = require('./ledgerService');
const blockchainService = require('./blockchainService');

/**
 * Anchors the heads of the "access" and "records" ledger chains on the blockchain
 * (Problem 10): every ANCHOR_INTERVAL_MINUTES, or as soon as ANCHOR_EVERY_ENTRIES new
 * entries were appended to a chain, whichever comes first.
 *
 * Before a head is anchored, the entry at the latest ON-CHAIN head and everything after it are
 * verified, so content changed behind the API's back is never sealed on-chain. If the chain is
 * down the attempt is stored as pending and the next run (or scripts/anchor-pending.js) tries
 * again; the head anchored then covers everything before it.
 */
const CHAINS = ['access', 'records'];
const sinceLast = { access: 0, records: 0 };
const running = new Map();
let timer = null;

async function record(chain, head, trigger, result) {
  if (result.status === 'refused') {
    // tampering found: every administrator is told at once (the dashboard bell and the ledger page)
    require('./notificationService').notifyRole('admin', {
      type: 'danger', title: 'Ledger tampering detected',
      message: `The "${chain}" ledger no longer matches its blockchain anchor (${result.problem}). New anchoring is stopped. Run "Verify ledger" now.`,
      page: 'ledger',
    }).catch((error) => logger.error(`Tamper notification failed: ${error.message}`));
  }
  return LedgerAnchor.create({
    chain, seq: head.seq, headHash: head.entryHash, status: result.status, trigger,
    txHash: result.txHash || null, blockNumber: result.blockNumber ?? null, gasUsed: result.gasUsed ?? null,
    latencyMs: result.latencyMs ?? null, error: result.error || result.problem || null,
    anchoredAt: result.status === 'anchored' ? new Date() : null,
  });
}

/**
 * The starting point is read from the CONTRACT, never from MongoDB: the LedgerAnchor collection
 * is only a convenience record and a database insider could edit or delete it. If the entry at
 * the latest on-chain head no longer matches, or anything after it is broken, nothing is anchored
 * and the refusal is recorded, so a rewritten ledger can never be sealed.
 */
async function anchorOnce(chain, trigger) {
  const head = await LedgerEntry.findOne({ chain }).sort({ seq: -1 }).select('seq entryHash').lean();
  if (!head) return { chain, status: 'empty' };
  if (!blockchainService.enabled) {
    await record(chain, head, trigger, { status: 'disabled' });
    return { chain, status: 'disabled', seq: head.seq };
  }

  const onchain = await blockchainService.latestLedgerHead(chain);
  if (!onchain.checked) {
    await record(chain, head, trigger, { status: 'pending', error: onchain.reason });
    return { chain, status: 'pending', seq: head.seq, error: onchain.reason };
  }

  let fromSeq = 0;
  if (onchain.exists) {
    if (onchain.seq >= head.seq) return { chain, status: 'up_to_date', seq: onchain.seq };
    const anchored = await LedgerEntry.findOne({ chain, seq: onchain.seq }).select('entryHash').lean();
    const problem = !anchored ? 'anchored_entry_missing' : anchored.entryHash !== onchain.headHash ? 'anchored_entry_changed' : null;
    if (problem) {
      logger.error(`Ledger "${chain}" no longer matches its on-chain anchor at #${onchain.seq} (${problem}): head NOT anchored`);
      await record(chain, head, trigger, { status: 'refused', problem });
      return { chain, status: 'refused', problem, brokenAtSeq: onchain.seq };
    }
    fromSeq = onchain.seq + 1;
  }

  const check = await ledgerService.verifyChain(chain, { fromSeq });
  if (!check.valid) {
    logger.error(`Ledger "${chain}" broken at #${check.brokenAtSeq} (${check.problem}): head NOT anchored`);
    await record(chain, head, trigger, { status: 'refused', problem: check.problem });
    return { chain, status: 'refused', problem: check.problem, brokenAtSeq: check.brokenAtSeq };
  }

  sinceLast[chain] = 0;
  const result = await blockchainService.anchorLedgerHead(chain, head.seq, head.entryHash);
  const doc = await record(chain, head, trigger, result);
  if (result.status === 'anchored') logger.info(`Anchored ${chain} head #${head.seq} (gas ${result.gasUsed}, ${result.latencyMs} ms)`);
  return { chain, status: result.status, seq: head.seq, anchorId: doc._id, txHash: result.txHash || null };
}

/** Anchors one chain's head; concurrent calls for the same chain share one run. */
function anchorHead(chain, trigger = 'manual') {
  if (!running.has(chain)) {
    lastRun[chain] = Date.now();
    running.set(chain, anchorOnce(chain, trigger)
      .catch((error) => { logger.error(`Anchoring ${chain} failed: ${error.message}`); return { chain, status: 'error', error: error.message }; })
      .finally(() => running.delete(chain)));
  }
  return running.get(chain);
}

const anchorAll = (trigger = 'manual') => Promise.all(CHAINS.map((chain) => anchorHead(chain, trigger)));

// Every authenticated request adds an access entry, so under load "every 100 entries" could mean
// an anchor every second. ANCHOR_MIN_SECONDS caps the rate; the interval timer catches up.
const lastRun = { access: 0, records: 0 };
function onAppended(chain) {
  sinceLast[chain] = (sinceLast[chain] || 0) + 1;
  const tooSoon = Date.now() - (lastRun[chain] || 0) < config.anchoring.minSecondsBetween * 1000;
  if (sinceLast[chain] >= config.anchoring.everyEntries && !tooSoon) anchorHead(chain, 'entries');
}

/** Started by server.js (not by the tests). */
function start() {
  if (!config.anchoring.enabled || !blockchainService.enabled || timer) return false;
  ledgerService.events.on('appended', onAppended);
  timer = setInterval(() => anchorAll('interval'), config.anchoring.intervalMinutes * 60 * 1000);
  timer.unref();
  anchorAll('interval'); // seal whatever happened while the server was down
  logger.info(`Ledger anchoring every ${config.anchoring.intervalMinutes} min or ${config.anchoring.everyEntries} entries`);
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  ledgerService.events.off('appended', onAppended);
}

module.exports = { anchorHead, anchorAll, start, stop, CHAINS };
