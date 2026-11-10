"""
Problem 21: evaluate CARMA and the baselines on the HELD-OUT 30% of RBA users (never used
for calibration). Location is "unknown" for every login (no GPS in the dataset).

    python evaluate.py data/rba-dataset.csv
    python evaluate.py data/rba-dataset.csv --weights out/weights_rba.json --thresholds ../thresholds/out/derived.env

For each configuration and role it reports, for labelled account takeovers (ato) and for
legitimate returning logins: the share that would be password-only (low), need the emailed
code (medium) or need the authenticator app / be refused (high). Also the ROC AUC of the
trust score (how well it separates takeovers from legitimate logins).
Configurations: B1 static 2FA, B2 Version 3 (80/50, no gates, CARMA weights), CARMA.
Output: out/eval_tiers.csv, out/eval_summary.txt (aggregated numbers only).
"""
import argparse, json, os, re, sys
import numpy as np
import pandas as pd
from rba_common import load, features

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
ROLES = ['patient', 'insurance_agent', 'doctor', 'admin']
DEFAULT_T = {'patient': (65, 50), 'insurance_agent': (70, 55), 'doctor': (70, 55), 'admin': (80, 60)}
CARMA_POINTS = {'device': {'trusted': 25, 'new': 10}, 'network': {'known': 15, 'new': 5}, 'time': {'duty': 20, 'off': 10}}
LOCATION_UNKNOWN = 15


def read_env_thresholds(path):
    t = {r: list(v) for r, v in DEFAULT_T.items()}
    for line in open(path):
        m = re.match(r'RISK_([A-Z_]+)_(UPPER|LOWER)=(\d+)', line.strip())
        if m:
            t[m.group(1).lower()][0 if m.group(2) == 'UPPER' else 1] = int(m.group(3))
    return {r: tuple(v) for r, v in t.items()}


def score(df, pts, location_points):
    s = location_points + df['device'].map(pts['device']) + df['network'].map(pts['network']) + df['time'].map(pts['time'])
    s = s - np.minimum(30, 10 * df['failures'])
    return s.clip(0, 100)


def tiers(df, s, upper, lower, gates):
    low = s > upper
    if gates:
        low &= (df['device'] == 'trusted') & (df['failures'] < 2)
    return np.where(low, 'low', np.where(s >= lower, 'medium', 'high'))


def auc(pos_scores, neg_scores):
    """P(score of a legitimate login > score of a takeover), ties count half (Mann-Whitney)."""
    if len(pos_scores) == 0 or len(neg_scores) == 0:
        return float('nan')
    allv = np.concatenate([neg_scores, pos_scores])
    ranks = pd.Series(allv).rank().values
    r_pos = ranks[len(neg_scores):].sum()
    n1, n0 = len(pos_scores), len(neg_scores)
    return (r_pos - n1 * (n1 + 1) / 2) / (n1 * n0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('--weights', help='out/weights_rba.json from calibrate.py (uses its "ato" level points)')
    ap.add_argument('--thresholds', help='derived.env from ../thresholds/derive.py')
    ap.add_argument('--sample', type=float, default=100)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    pts = CARMA_POINTS
    location_points = LOCATION_UNKNOWN
    if args.weights:
        cal = json.load(open(args.weights))
        pts = {s: cal['ato']['level_points'][s] for s in ('device', 'network', 'time')}
        location_points = round(cal['location_weight'] * 15 / 35)
    thresholds = read_env_thresholds(args.thresholds) if args.thresholds else DEFAULT_T

    df = features(load(args.csv, sample_pct=args.sample))
    test = df[~df['calibration'] & ~df['first_login'] & df['label'].isin(['ato', 'legit'])].copy()
    print(f"held-out users: {test['user'].nunique():,}; account takeovers: {(test['label'] == 'ato').sum():,}; legitimate: {(test['label'] == 'legit').sum():,}")

    rows = []
    s_carma = score(test, pts, location_points)
    s_v3 = score(test, CARMA_POINTS, LOCATION_UNKNOWN)
    configs = {
        'B1 static 2FA': {r: None for r in ROLES},
        'B2 Version 3 (80/50, no gates)': {r: (s_v3, 80, 50, False) for r in ROLES},
        'CARMA': {r: (s_carma, *thresholds[r], True) for r in ROLES},
    }
    for name, per_role in configs.items():
        for role in ROLES:
            spec = per_role[role]
            t = np.full(len(test), 'medium') if spec is None else tiers(test, spec[0], spec[1], spec[2], spec[3])
            for label in ('ato', 'legit'):
                m = (test['label'] == label).values
                n = int(m.sum())
                c = pd.Series(t[m]).value_counts()
                rows.append({'config': name, 'role': role, 'logins': label, 'n': n,
                             'low_pct': round(100 * c.get('low', 0) / max(n, 1), 2),
                             'medium_pct': round(100 * c.get('medium', 0) / max(n, 1), 2),
                             'high_pct': round(100 * c.get('high', 0) / max(n, 1), 2)})
    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(OUT, 'eval_tiers.csv'), index=False)
    a = auc(s_carma[test['label'] == 'legit'].values, s_carma[test['label'] == 'ato'].values)
    a_v3 = auc(s_v3[test['label'] == 'legit'].values, s_v3[test['label'] == 'ato'].values)
    text = res.to_string(index=False) + f"\n\nROC AUC of the trust score: CARMA weights {a:.3f}, Version 3 weights {a_v3:.3f}\n" \
        "(ato low_pct = takeovers that would have succeeded with the password alone; legit low_pct = password-only rate)\n"
    print(text)
    open(os.path.join(OUT, 'eval_summary.txt'), 'w').write(text)


if __name__ == '__main__':
    main()
