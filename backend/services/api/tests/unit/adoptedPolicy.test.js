// Problem 6 / D10: every rule the guide approved (experiments/thresholds/rules.csv) holds under the
// ADOPTED defaults (calibrated points, derived thresholds), checked through the real tierFor().
const fs = require('fs');
const path = require('path');
const config = require('../../src/config/config');
const contextService = require('../../src/services/contextService');

const RULES = path.resolve(__dirname, '../../../../../experiments/thresholds/rules.csv');
const ROLES = ['patient', 'insurance_agent', 'doctor', 'admin'];
const SIGNALS = ['location', 'device', 'time', 'network'];
const LEVELS = { location: ['near', 'mid', 'unknown', 'far'], device: ['trusted', 'new'], time: ['duty', 'off'], network: ['hospital', 'known', 'new'] };

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const cells = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Every concrete context a rule covers ("*" = every level). */
function contexts(rule) {
  let out = [{}];
  for (const s of SIGNALS) {
    const levels = rule[s] === '*' ? LEVELS[s] : [rule[s]];
    out = out.flatMap((c) => levels.map((l) => ({ ...c, [s]: l })));
  }
  return out;
}

const score = (ctx, failures, p) => Math.max(0, Math.min(100,
  SIGNALS.reduce((sum, s) => sum + p[s][ctx[s]], 0) - Math.min(p.penalty.max, p.penalty.perFailure * failures)));

const meets = {
  at_least_code: (risk) => risk !== 'low',
  third_factor: (risk) => risk === 'high',
  password_only: (risk) => risk === 'low',
  not_third_factor: (risk) => risk !== 'high',
};

describe('adopted policy (guide, 26 Nov 2026)', () => {
  const saved = config.context.riskThresholds;
  beforeAll(() => {
    config.context.riskThresholds = Object.fromEntries(Object.entries(config.DEFAULT_THRESHOLDS).map(([r, [upper, lower]]) => [r, { upper, lower }]));
  });
  afterAll(() => { config.context.riskThresholds = saved; });

  const rules = parseCsv(fs.readFileSync(RULES, 'utf8'));

  test('the approved rules file has the rules the guide kept', () => {
    expect(rules.map((r) => r.rule)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R7', 'R10', 'R12']);
  });

  test.each(rules.map((r) => [r.rule, r]))('%s holds for every role and context it covers', (_, rule) => {
    const roles = rule.roles === 'all' ? ROLES : rule.roles.split(';');
    for (const role of roles) {
      for (const ctx of contexts(rule)) {
        const s = score(ctx, Number(rule.failures || 0), config.DEFAULT_POINTS);
        const { risk } = contextService.tierFor(s, { role, deviceKnown: ctx.device === 'trusted', failures: Number(rule.failures || 0), profile: 'carma' });
        expect({ rule: rule.rule, role, ctx, score: s, ok: meets[rule.requirement](risk) }).toMatchObject({ ok: true });
      }
    }
  });

  test('the adopted points keep the required shape: the best level of each signal adds up to 100', () => {
    const best = SIGNALS.reduce((sum, s) => sum + Math.max(...Object.values(config.DEFAULT_POINTS[s])), 0);
    expect(best).toBe(100);
  });

  test('the stolen-laptop attack (S8: trusted device, attacker network, GPS near, duty) now needs a code for every role', () => {
    const s = score({ location: 'near', device: 'trusted', time: 'duty', network: 'new' }, 0, config.DEFAULT_POINTS);
    for (const role of ROLES) {
      expect(contextService.tierFor(s, { role, deviceKnown: true, profile: 'carma' }).risk).not.toBe('low');
    }
  });
});
