"""CARMA decision-model experiments E1 (context grid), E2a (attack tiers, analytic)
and E5 (sensitivity and ablation).

The scoring rules re-implement contextService.assess() and tierFor() exactly as
documented in MediChain Version 3.  Run:   python decision_model.py
Outputs go to ./out/ (CSV tables, PNG figures, summary.txt).

IMPORTANT: these results describe the DECISION FUNCTION.  The same scenarios must
also be replayed against the running API (scripts in ../live/) and the two must
agree before the numbers are reported as system results.
"""
import itertools, csv, os, json
from collections import Counter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- model ----
LOC = {'near': 35, 'mid': 20, 'unknown': 15, 'far': 5}       # Haversine bands
DEV = {'trusted': 25, 'new': 10}
TIME = {'duty': 20, 'off': 10}
NET = {'hospital': 20, 'known': 15, 'new': 5}
W0 = {'L': 35, 'D': 25, 'T': 20, 'N': 20}                    # nominal weights
LEVEL = {'L': {k: v / 35 for k, v in LOC.items()},
         'D': {k: v / 25 for k, v in DEV.items()},
         'T': {k: v / 20 for k, v in TIME.items()},
         'N': {k: v / 20 for k, v in NET.items()}}
ROLES = ['patient', 'insurance', 'doctor', 'admin']
UNIFORM = {r: (80, 50) for r in ROLES}                        # Version 3 / baseline B2
DRAFT_T = {'patient': (80, 50), 'insurance': (80, 55),         # first draft of Table III
           'doctor': (85, 55), 'admin': (90, 60)}
ROLE_T = {'patient': (65, 50), 'insurance': (70, 55),          # CARMA, recalibrated (Table III)
          'doctor': (70, 55), 'admin': (80, 60)}

def score(ctx, w=W0, penalty_step=10, penalty_cap=30):
    loc, dev, tim, net, f = ctx
    s = (w['L'] * LEVEL['L'][loc] + w['D'] * LEVEL['D'][dev] +
         w['T'] * LEVEL['T'][tim] + w['N'] * LEVEL['N'][net])
    s -= min(penalty_cap, penalty_step * f)
    return max(0.0, min(100.0, round(s, 6)))

def tier(T, dev, role, thresholds, gate, f=0):
    hi, lo = thresholds[role]
    # possession gate: trusted device; failure gate: fewer than 2 recent failures
    if T > hi and ((dev == 'trusted' and f < 2) or not gate):
        return 'low'
    if T >= lo:
        return 'medium'
    return 'high'

CONFIGS = {   # name: (thresholds, possession gate)
    'B2 uniform 80/50 (Version 3)': (UNIFORM, False),
    'Draft role thresholds + gate': (DRAFT_T, True),
    'CARMA (gate + role thresholds)': (ROLE_T, True),
}
# returning user on the enrolled device: trusted device, no failures, no VPN-style mismatch
RETURNING = None
FACTORS = {'low': 'password + trusted device', 'medium': 'password + emailed code',
           'high': 'password + code + TOTP (or emergency for doctor/admin)'}

GRID = list(itertools.product(LOC, DEV, TIME, NET, range(4)))   # 4*2*2*3*4 = 192

# legitimate contexts: no VPN-style distance mismatch, at most one typo
LEGIT = [c for c in GRID if c[0] != 'far' and c[4] <= 1]
RETURNING = [c for c in GRID if c[1] == 'trusted' and c[0] != 'far' and c[4] == 0]

# ------------------------------------------------------------ E1 grid ------
def tier_dist(contexts, thresholds, gate, role, w=W0):
    return Counter(tier(score(c, w), c[1], role, thresholds, gate, c[4]) for c in contexts)

rows = []
for name, (th, gate) in CONFIGS.items():
    for role in ROLES:
        for label, ctxs in (('all 192 contexts', GRID), (f'legitimate ({len(LEGIT)})', LEGIT),
                            (f'returning user ({len(RETURNING)})', RETURNING)):
            d = tier_dist(ctxs, th, gate, role)
            n = len(ctxs)
            rows.append({'config': name, 'role': role, 'set': label, 'n': n,
                         'low_%': round(100 * d['low'] / n, 1),
                         'medium_%': round(100 * d['medium'] / n, 1),
                         'high_%': round(100 * d['high'] / n, 1),
                         'needs_code_%': round(100 * (d['medium'] + d['high']) / n, 1)})
with open(os.path.join(OUT, 'E1_tier_distribution.csv'), 'w', newline='') as fh:
    wr = csv.DictWriter(fh, fieldnames=rows[0].keys()); wr.writeheader(); wr.writerows(rows)

# no-device contexts that reach the password-only tier (the insider gap)
gap = []
for name, (th, gate) in CONFIGS.items():
    for role in ROLES:
        bad = [c for c in GRID if c[1] == 'new' and tier(score(c), c[1], role, th, gate, c[4]) == 'low']
        gap.append({'config': name, 'role': role, 'no_device_low_tier_contexts': len(bad),
                    'examples': '; '.join('/'.join(map(str, b)) for b in bad[:3])})
with open(os.path.join(OUT, 'E1_possession_gap.csv'), 'w', newline='') as fh:
    wr = csv.DictWriter(fh, fieldnames=gap[0].keys()); wr.writeheader(); wr.writerows(gap)

# score extremes (used in the propositions)
max_no_dev = max(score(c) for c in GRID if c[1] == 'new')
max_no_dev_offsite = max(score(c) for c in GRID if c[1] == 'new' and c[3] != 'hospital')

# --------------------------------------------------- E2a attack tiers ------
# each adversary takes the BEST context it can produce (highest score)
ATTACKS = {
    'A1 naive (any IP, unknown browser)':          [('far', 'new', t, 'new', 0) for t in TIME] + [('unknown', 'new', t, 'new', 0) for t in TIME],
    'A2 VPN + forged GPS':                         [('near', 'new', t, 'new', 0) for t in TIME],
    'A3 targeted (known network, duty hours)':     [('near', 'new', 'duty', 'known', 0)],
    'A4 insider (hospital network, ward PC)':      [('near', 'new', 'duty', 'hospital', 0)],
    'A5 device thief (trusted browser)':           [('near', 'trusted', 'duty', 'known', 0)],
    'A2 after 2 failed guesses':                   [('near', 'new', 'duty', 'new', 2)],
    'A5 guessing on trusted device (2 failures)':  [('near', 'trusted', 'duty', 'hospital', 2)],
}
att = []
for a, ctxs in ATTACKS.items():
    best = max(ctxs, key=score)
    T = score(best)
    rec = {'adversary': a, 'best_context': '/'.join(map(str, best)), 'score': T,
           'B1 static 2FA': 'code (always)'}
    for name, (th, gate) in CONFIGS.items():
        tiers = {r: tier(T, best[1], r, th, gate, best[4]) for r in ROLES}
        rec[name] = ', '.join(f'{r}:{t}' for r, t in tiers.items())
    att.append(rec)
with open(os.path.join(OUT, 'E2a_attack_tiers.csv'), 'w', newline='') as fh:
    wr = csv.DictWriter(fh, fieldnames=att[0].keys()); wr.writeheader(); wr.writerows(att)

# --------------------------------------------- E5 sensitivity / ablation ---
def renorm(w):
    s = sum(w.values()); return {k: 100 * v / s for k, v in w.items()}

def changed_share(w, th, gate, role, base_w=W0):
    ch = sum(tier(score(c, w), c[1], role, th, gate, c[4]) != tier(score(c, base_w), c[1], role, th, gate, c[4]) for c in GRID)
    return 100 * ch / len(GRID)

def legit_friction(w, th, gate, role):
    d = tier_dist(RETURNING, th, gate, role, w)
    return 100 * d['low'] / len(RETURNING)      # share of returning-user logins that are password-only

def nodev_low(w, th, gate, role):
    return sum(1 for c in GRID if c[1] == 'new' and tier(score(c, w), c[1], role, th, gate, c[4]) == 'low')

sens = []
for name, (th, gate) in CONFIGS.items():
    for k in W0:
        for delta in (-0.2, +0.2):
            w = dict(W0); w[k] = W0[k] * (1 + delta); w = renorm(w)
            for role in ROLES:
                sens.append({'config': name, 'perturbation': f'w_{k} {delta:+.0%}', 'role': role,
                             'tier_changed_%': round(changed_share(w, th, gate, role), 1),
                             'returning_password_only_%': round(legit_friction(w, th, gate, role), 1),
                             'no_device_low_tier': nodev_low(w, th, gate, role)})
    for dth in (-5, +5):
        for which in ('high', 'low'):
            th2 = {r: ((h + dth, l) if which == 'high' else (h, l + dth)) for r, (h, l) in th.items()}
            for role in ROLES:
                sens.append({'config': name, 'perturbation': f'theta_{which} {dth:+d}', 'role': role,
                             'tier_changed_%': round(100 * sum(tier(score(c), c[1], role, th2, gate, c[4]) != tier(score(c), c[1], role, th, gate, c[4]) for c in GRID) / len(GRID), 1),
                             'returning_password_only_%': round(legit_friction(W0, th2, gate, role), 1),
                             'no_device_low_tier': nodev_low(W0, th2, gate, role)})
    for k in W0:   # ablation: drop one signal, renormalise the rest to 100
        w = {kk: (0 if kk == k else v) for kk, v in W0.items()}; w = renorm(w)
        for role in ROLES:
            sens.append({'config': name, 'perturbation': f'ablate {k}', 'role': role,
                         'tier_changed_%': round(changed_share(w, th, gate, role), 1),
                         'returning_password_only_%': round(legit_friction(w, th, gate, role), 1),
                         'no_device_low_tier': nodev_low(w, th, gate, role)})
with open(os.path.join(OUT, 'E5_sensitivity_ablation.csv'), 'w', newline='') as fh:
    wr = csv.DictWriter(fh, fieldnames=sens[0].keys()); wr.writeheader(); wr.writerows(sens)

json.dump({'max_score_without_device': max_no_dev,
           'max_score_without_device_off_hospital_network': max_no_dev_offsite,
           'grid_size': len(GRID), 'legit_size': len(LEGIT)},
          open(os.path.join(OUT, 'summary.json'), 'w'), indent=2)
print('done', len(GRID), len(LEGIT), max_no_dev, max_no_dev_offsite)
