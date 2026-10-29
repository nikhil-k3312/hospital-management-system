const LedgerEntry = require('../models/LedgerEntry');
const { sha256, canonicalJSON, hashObject } = require('../utils/hash');

/**
 * Computes an entry's hash from every field except the hash itself.
 * Any change to any field (or to the link to the previous entry) changes it.
 */
function computeEntryHash(entry) {
  return sha256(canonicalJSON({
    chain: entry.chain,
    seq: entry.seq,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    action: entry.action,
    actorId: entry.actorId ?? null,
    actorRole: entry.actorRole ?? null,
    payloadHash: entry.payloadHash ?? null,
    meta: entry.meta || {},
    timestamp: new Date(entry.timestamp).toISOString(),
    previousEntryHash: entry.previousEntryHash ?? null,
  }));
}

// Appends are serialised per chain inside this process so concurrent requests
// do not race for the same sequence number. The unique (chain, seq) index is
// the safety net across processes: on a duplicate we re-read and retry.
const queues = new Map();

function enqueue(chain, task) {
  const previous = queues.get(chain) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(chain, next.catch(() => {}));
  return next;
}

async function appendOnce({ chain, entityType, entityId, action, actorId, actorRole, payload, payloadHash, meta }) {
  const last = await LedgerEntry.findOne({ chain }).sort({ seq: -1 }).select('seq entryHash').lean();
  const entry = {
    chain,
    seq: last ? last.seq + 1 : 0,
    entityType,
    entityId: entityId ? String(entityId) : null,
    action,
    actorId: actorId ? String(actorId) : null,
    actorRole: actorRole || null,
    payloadHash: payloadHash || (payload !== undefined ? hashObject(payload) : null),
    // JSON round-trip drops undefined values, which MongoDB would otherwise
    // store as null and so change the hash on read-back.
    meta: meta ? JSON.parse(JSON.stringify(meta)) : {},
    timestamp: new Date(),
    previousEntryHash: last ? last.entryHash : null,
  };
  entry.entryHash = computeEntryHash(entry);
  return LedgerEntry.create(entry);
}

/**
 * Appends one entry to a chain and returns it.
 *
 * @param {object} params
 * @param {'records'|'access'} params.chain
 * @param {string} params.entityType  e.g. 'record', 'consent', 'claim'
 * @param {string} params.entityId
 * @param {string} params.action      e.g. 'CREATE', 'UPDATE', 'GRANT_ACCESS'
 * @param {object} [params.payload]   entity content; its canonical SHA-256 is stored
 * @param {string} [params.payloadHash] pre-computed hash (e.g. of a file)
 */
function append(params) {
  return enqueue(params.chain, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await appendOnce(params);
      } catch (error) {
        if (error.code !== 11000) throw error; // not a sequence collision
      }
    }
    throw new Error('LEDGER_APPEND_CONFLICT');
  });
}

/** Records-chain shortcut used by every module that changes clinical or financial data. */
function recordEvent({ entityType, entity, action, actor, meta, payloadHash }) {
  return append({
    chain: 'records',
    entityType,
    entityId: entity._id,
    action,
    actorId: actor ? actor.userId || actor._id : null,
    actorRole: actor ? actor.role : 'system',
    payload: typeof entity.ledgerPayload === 'function' ? entity.ledgerPayload() : undefined,
    payloadHash,
    meta,
  });
}

/**
 * Walks a chain from the genesis entry and checks two things for every entry:
 *   1. its stored entryHash equals a fresh recomputation (content not edited)
 *   2. its previousEntryHash equals the previous entry's entryHash (no gaps,
 *      no re-ordering, nothing removed)
 * Returns the first problem found, or { valid: true }.
 */
async function verifyChain(chain) {
  const cursor = LedgerEntry.find({ chain }).sort({ seq: 1 }).lean().cursor();
  let previous = null;
  let checked = 0;

  for await (const entry of cursor) {
    const expectedSeq = previous ? previous.seq + 1 : 0;
    if (entry.seq !== expectedSeq) {
      return { chain, valid: false, entriesChecked: checked, brokenAtSeq: expectedSeq, problem: 'missing_entry' };
    }
    if (entry.previousEntryHash !== (previous ? previous.entryHash : null)) {
      return { chain, valid: false, entriesChecked: checked, brokenAtSeq: entry.seq, problem: 'broken_link' };
    }
    if (computeEntryHash(entry) !== entry.entryHash) {
      return { chain, valid: false, entriesChecked: checked, brokenAtSeq: entry.seq, problem: 'entry_modified' };
    }
    previous = entry;
    checked += 1;
  }

  return { chain, valid: true, entriesChecked: checked, headHash: previous ? previous.entryHash : null };
}

/** All ledger entries for one entity, oldest first (the entity's audit trail). */
function history(entityType, entityId) {
  return LedgerEntry.find({ chain: 'records', entityType, entityId: String(entityId) }).sort({ seq: 1 }).lean();
}

/**
 * Checks whether an entity still matches what the ledger last recorded for it.
 * A direct database edit changes the entity's payload hash but cannot change
 * the ledger (doing so would break the chain), so the two no longer agree.
 */
async function verifyEntity(entityType, entity) {
  const latest = await LedgerEntry.findOne({
    chain: 'records', entityType, entityId: String(entity._id), payloadHash: { $ne: null },
    action: { $nin: ['FILE_ATTACHED', 'VIEW', 'BREAK_GLASS_ACCESS'] },
  }).sort({ seq: -1 }).lean();

  if (!latest) {
    return { entityId: String(entity._id), matches: false, reason: 'no_ledger_entry' };
  }
  const currentHash = hashObject(entity.ledgerPayload());
  return {
    entityId: String(entity._id),
    matches: currentHash === latest.payloadHash,
    currentHash,
    ledgerHash: latest.payloadHash,
    ledgerSeq: latest.seq,
  };
}

async function stats() {
  const [records, access] = await Promise.all(['records', 'access'].map(async (chain) => {
    const count = await LedgerEntry.countDocuments({ chain });
    const head = await LedgerEntry.findOne({ chain }).sort({ seq: -1 }).lean();
    return { chain, entries: count, headHash: head ? head.entryHash : null, lastEntryAt: head ? head.timestamp : null };
  }));
  return { records, access };
}

module.exports = { append, recordEvent, verifyChain, verifyEntity, history, stats, computeEntryHash };
