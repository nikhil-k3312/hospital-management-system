/**
 * Problem 16 (experiment E1): the running API must decide exactly like the model in the paper.
 *
 * Replays all 192 contexts (4 location bands x 2 devices x 2 times x 3 networks x 0-3 failed
 * attempts) for one account of each role, over HTTP, and compares the score and tier the API
 * returns with an independent re-implementation of Eq. (1)-(8) of the paper.
 *
 *   node replay_grid.js                     CARMA (default profile)
 *   node replay_grid.js --profile v3        baseline B2;  --profile static  baseline B1
 * Output: out/replay_<profile>.csv (768 rows) and a summary on screen. Send me the CSV.
 */
const h = require('./harness');

// level names; the points come from the API's configuration (CONTEXT_POINTS or the defaults)
const LEVELS = { location: ['near', 'mid', 'unknown', 'far'], device: ['trusted', 'new'], time: ['duty', 'off'], network: ['hospital', 'known', 'new'] };
const ROLES = ['patient', 'insurance_agent', 'doctor', 'admin'];

/** The paper's decision function, written independently of contextService. */
function model({ loc, dev, time, net, f }, role, profile, thresholds, P) {
  const T = Math.max(0, Math.min(100, P.location[loc] + P.device[dev] + P.time[time] + P.network[net] - Math.min(P.penalty.max, P.penalty.perFailure * f)));
  if (profile === 'static') return { T, tier: 'medium' };
  const [U, L] = profile === 'v3' ? [80, 50] : [thresholds[role].upper, thresholds[role].lower];
  const gatesOk = profile === 'v3' || (dev === 'trusted' && f < 2);
  return { T, tier: T > U && gatesOk ? 'low' : T >= L ? 'medium' : 'high' };
}

async function main() {
  const a = h.args();
  const profile = a.profile || 'carma';
  await h.start();
  h.api.config.context.profile = profile;
  h.api.config.context.hospitalNetworks = ['49.207.0.0/24'];
  Object.values(h.NETWORKS).forEach((ip) => h.gpsFor(ip, 'near')); // every address must have a GeoIP position
  const thresholds = JSON.parse(JSON.stringify(h.api.config.context.riskThresholds));
  const points = JSON.parse(JSON.stringify(h.api.config.context.points));
  console.log(`points: ${JSON.stringify(points)}\nthresholds: ${JSON.stringify(thresholds)}`);
  const UA = 'Replay/1.0';

  const users = {};
  for (const role of ROLES) {
    const user = await h.createUser(role);
    const first = await h.firstLogin(user, { ip: h.NETWORKS.known, ua: UA }); // trusted browser + known network
    await h.enrolTotp(user._id); // so a high tier shows as a challenge instead of a refusal
    users[role] = { user, device: first.cookies.filter((c) => c.startsWith('mcDevice=')), snap: await h.snapshot(user._id) };
  }

  const rows = [];
  let mismatches = 0;
  for (const role of ROLES) {
    const { user, device, snap } = users[role];
    for (const loc of LEVELS.location) for (const dev of LEVELS.device) for (const time of LEVELS.time) for (const net of LEVELS.network) for (let f = 0; f <= 3; f += 1) {
      await h.restore(user._id, snap);
      h.setDuty(time === 'duty');
      const ip = h.NETWORKS[net];
      const cookies = dev === 'trusted' ? device : [];
      for (let i = 0; i < f; i += 1) { // real failed attempts (below the lock-out limit of 5)
        await h.http('POST', '/api/auth/login/dynamic', { ip, ua: UA, cookies, body: { email: user.email, password: 'Wrong!Pass1', context: { gps: null } } });
      }
      const res = await h.http('POST', '/api/auth/login/dynamic', { ip, ua: UA, cookies, body: { email: user.email, password: h.PASSWORD, context: { gps: h.gpsFor(ip, loc) } } });
      const asmt = res.body?.data?.assessment;
      const apiTier = res.status === 403 && res.body.code === 'TOTP_NOT_ENROLLED' ? 'high' : asmt?.risk;
      const m = model({ loc, dev, time, net, f }, role, profile, thresholds, points);
      const match = asmt && asmt.score === m.T && apiTier === m.tier;
      if (!match) mismatches += 1;
      rows.push({ profile, role, location: loc, device: dev, time, network: net, failures: f, api_status: res.status,
        api_score: asmt?.score ?? '', api_tier: apiTier ?? '', api_gate: asmt?.gate ?? '', api_location: asmt?.breakdown?.location?.category ?? '',
        model_score: m.T, model_tier: m.tier, match, latency_ms: res.ms.toFixed(1), error: asmt ? '' : JSON.stringify(res.body).slice(0, 160) });
    }
    process.stdout.write(`${role} done\n`);
  }
  h.writeCsv(`${h.OUT}/replay_${profile}.csv`, rows);
  const byTier = (r) => rows.filter((x) => x.role === r).reduce((acc, x) => ({ ...acc, [x.api_tier]: (acc[x.api_tier] || 0) + 1 }), {});
  ROLES.forEach((r) => console.log(`${r.padEnd(16)} ${JSON.stringify(byTier(r))}`));
  console.log(`\n${rows.length} checks, ${rows.length - mismatches} match the model, ${mismatches} differ.`);
  console.log(`Written to ${h.OUT}/replay_${profile}.csv`);
  await h.stop();
}

main().catch(async (e) => { console.error(e); await h.stop(); process.exit(1); });
