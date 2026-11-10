/**
 * Problem 20 (pilot): exports ONLY what the analysis needs from the pilot deployment's ledger.
 * Run it on the pilot server, against the pilot database (the API .env), NOT the experiment one:
 *
 *   node export_pilot.js                 -> out/pilot_logins.csv, out/pilot_summary.txt
 *   node export_pilot.js --since 2026-11-20
 *
 * Kept: participant code (P01, P02, ...; the mapping to accounts is NOT written anywhere), role,
 * day, hour, decision, reason, trust score, tier, factors, gate, the four signal CATEGORIES,
 * emergency yes/no. Dropped: names, emails, ids, IP hashes, distances, GPS, emergency reasons.
 */
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const apiRequire = createRequire(path.join(__dirname, '../../backend/services/api/package.json'));
const config = apiRequire('./src/config/config');
const { connectMongo, disconnectMongo } = apiRequire('./src/db/mongo');
const LedgerEntry = apiRequire('./src/models/LedgerEntry');

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; }

async function main() {
  await connectMongo(config.mongodb.uri);
  const since = arg('since') ? new Date(arg('since')) : new Date(0);
  const entries = await LedgerEntry.find({ chain: 'access', entityType: { $in: ['login_context', 'session_refresh'] }, timestamp: { $gte: since } })
    .sort({ seq: 1 }).lean();
  const codes = new Map();
  const code = (id) => { if (!codes.has(id)) codes.set(id, `P${String(codes.size + 1).padStart(2, '0')}`); return codes.get(id); };
  const rows = entries.filter((e) => e.actorId).map((e) => ({
    participant: code(e.actorId), role: e.actorRole || '', day: e.timestamp.toISOString().slice(0, 10),
    hour: new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: config.context.timezone }).format(e.timestamp),
    event: e.entityType, decision: e.action, reason: e.meta?.reason || '', score: e.meta?.trustScore ?? '', tier: e.meta?.risk || '',
    factors: (e.meta?.factors || []).join('+'), gate: e.meta?.gate || '', location: e.meta?.location || '', device: e.meta?.device || '',
    time: e.meta?.time || '', network: e.meta?.network || '', emergency: e.meta?.reason === 'emergency_login' ? 'yes' : 'no',
  }));
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const cols = Object.keys(rows[0] || { participant: '' });
  fs.writeFileSync(path.join(__dirname, 'out', 'pilot_logins.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => `"${String(r[c]).replace(/"/g, '""')}"`).join(','))].join('\n') + '\n');

  // completed sign-ins per role and how they were completed
  const done = rows.filter((r) => r.event === 'login_context' && r.decision === 'ALLOW');
  const lines = [`${rows.length} events, ${codes.size} participants, ${done.length} completed sign-ins`];
  for (const role of [...new Set(done.map((r) => r.role))]) {
    const mine = done.filter((r) => r.role === role);
    const by = (t) => mine.filter((r) => r.tier === t).length;
    lines.push(`${role.padEnd(16)} n=${mine.length}  password-only ${by('low')}  +code ${by('medium')}  +authenticator ${by('high') - mine.filter((r) => r.emergency === 'yes').length}  emergency ${mine.filter((r) => r.emergency === 'yes').length}`);
  }
  const refused = rows.filter((r) => r.decision === 'DENY');
  lines.push(`refusals: ${refused.length} (${[...new Set(refused.map((r) => r.reason))].join(', ')})`);
  fs.writeFileSync(path.join(__dirname, 'out', 'pilot_summary.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  console.log('\nWritten to out/pilot_logins.csv and out/pilot_summary.txt. Check them, then send them with sus_responses.csv.');
  await disconnectMongo();
}

main().catch(async (e) => { console.error(e); await disconnectMongo().catch(() => {}); process.exit(1); });
