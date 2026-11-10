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
 * Before a head is anchored, the part of the chain since the last anchor is verified, so
 * content changed behind the API's back is never sealed on-chain. If the chain is down the
 * attempt is stored as pending and the next run (or scripts/anchor-pending.js) tries again;
 * the head anchored then covers everything before it.
 */
const CHAINS = ['access', 'records'];
const sinceLast = { access: 0, records: 0 };
const running = new Map();
let timer = null;

async function lastAnchored(chain) {
  return LedgerAnchor.findOne({ chain, status: 'anchored' }).sort({ seq: -1 }).lean();
}

async function anchorOnce(chain, trigger) {
  const head = await LedgerEntry.findOne({ chain }).sort({ seq: -1 }).select('seq entryHash').lean();
  if (!head) return { chain, status: 'empty' };
  const previous = await lastAnchored(chain);
  if (previous && previous.seq >= head.seq) return { chain, status: 'up_to_date', seq: previous.seq };

  const check = await ledgerService.verifyChain(chain, { fromSeq: previous ? previous.seq + 1 : 0 });
  if (!check.valid) {
    logger.error(`Ledger "${chain}" broken at #${check.brokenAtSeq} (${check.problem}): head NOT anchored`);
    return { chain, status: 'refused', problem: check.problem, brokenAtSeq: check.brokenAtSeq };
  }
  // A previous anchor older than the stored copy must also still match (rewrite before it).
  if (previous) {
    const stillThere = await LedgerEntry.findOne({ chain, seq: previous.seq }).select('entryHash').lean();
    if (!stillThere || stillThere.entryHash !== previous.headHash) {
      logger.error(`Ledger "${chain}" no longer matches its anchor at #${previous.seq}: head NOT anchored`);
      return { chain, status: 'refused', problem: 'anchored_entry_changed', brokenAtSeq: previous.seq };
    }
  }

  sinceLast[chain] = 0;
  const result = await blockchainService.anchorLedgerHead(chain, head.seq, head.entryHash);
  const doc = await LedgerAnchor.create({
    chain, seq: head.seq, headHash: head.entryHash, status: result.status, trigger,
    txHash: result.txHash || null, blockNumber: result.blockNumber ?? null, gasUsed: result.gasUsed ?? null,
    latencyMs: result.latencyMs ?? null, error: result.error || null,
    anchoredAt: result.status === 'anchored' ? new Date() : null,
  });
  if (result.status === 'anchored') logger.info(`Anchored ${chain} head #${head.seq} (gas ${result.gasUsed}, ${result.latencyMs} ms)`);
  return { chain, status: result.status, seq: head.seq, anchorId: doc._id, txHash: result.txHash || null };
}

/** Anchors one chain's head; concurrent calls for the same chain share one run. */
function anchorHead(chain, trigger = 'manual') {
  if (!running.has(chain)) {
    running.set(chain, anchorOnce(chain, trigger)
      .catch((error) => { logger.error(`Anchoring ${chain} failed: ${error.message}`); return { chain, status: 'error', error: error.message }; })
      .finally(() => running.delete(chain)));
  }
  return running.get(chain);
}

const anchorAll = (trigger = 'manual') => Promise.all(CHAINS.map((chain) => anchorHead(chain, trigger)));

function onAppended(chain) {
  sinceLast[chain] = (sinceLast[chain] || 0) + 1;
  if (sinceLast[chain] >= config.anchoring.everyEntries) anchorHead(chain, 'entries');
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
