"""
Problem 15, part A: calibrate CARMA's device, network and time weights on the RBA dataset
(Wiefling et al.; download rba-dataset.zip from https://zenodo.org/record/6782156 or
https://github.com/das-group/rba-dataset releases, unzip to data/).

Only the CALIBRATION users (70%, fixed split) are used here; evaluate.py uses the other 30%.

For every level of every signal:   LR = P(level | account takeover) / P(level | legitimate login)
(the statistical idea of Freeman et al. that Wiefling et al. evaluate), with 95% confidence
intervals for ln LR. A signal's evidence is the spread of ln LR between its best and worst
level. The non-location budget (100 - location weight; location comes from the AHP survey,
part B, because the dataset has no GPS) is shared in proportion to that evidence, and each
level gets points by linear interpolation of its ln LR between the worst level (0) and the
best level (full weight). The result is still a small, explainable points table.

    python calibrate.py data/rba-dataset.csv
    python calibrate.py data/rba-dataset.csv --location-weight 31 --sample 25

Output (small, no personal data): out/lr_table.csv, out/weights_rba.json, out/weights_rba.txt
The labelled account takeovers are few, so the confidence intervals are reported and matter.
"""
import argparse, json, math, os, sys
import numpy as np
import pandas as pd
from rba_common import load, features

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
SIGNALS = {'device': ['trusted', 'new'], 'network': ['known', 'new'], 'time': ['duty', 'off']}
CARMA = {'device': {'trusted': 25, 'new': 10}, 'network': {'known': 15, 'new': 5}, 'time': {'duty': 20, 'off': 10}}


def lr_rows(df, attacker_label):
    att = df[df['label'] == attacker_label]
    leg = df[df['label'] == 'legit']
    rows = []
    for sig, levels in SIGNALS.items():
        for lv in levels:
            a, n1 = int((att[sig] == lv).sum()), len(att)
            b, n2 = int((leg[sig] == lv).sum()), len(leg)
            # +0.5 (Haldane) so that empty cells give a finite ratio
            p1, p2 = (a + 0.5) / (n1 + 1), (b + 0.5) / (n2 + 1)
            ln = math.log(p1 / p2)
            se = math.sqrt(1 / (a + 0.5) - 1 / (n1 + 1) + 1 / (b + 0.5) - 1 / (n2 + 1))
            rows.append({'attacker': attacker_label, 'signal': sig, 'level': lv, 'attacker_count': a, 'attacker_n': n1,
                         'legit_count': b, 'legit_n': n2, 'p_attacker': round(p1, 5), 'p_legit': round(p2, 5),
                         'LR': round(math.exp(ln), 4), 'lnLR': round(ln, 4),
                         'lnLR_ci_low': round(ln - 1.96 * se, 4), 'lnLR_ci_high': round(ln + 1.96 * se, 4)})
    return rows


def points(rows, budget):
    by = {}
    for r in rows:
        by.setdefault(r['signal'], {})[r['level']] = r['lnLR']
    evidence = {s: max(v.values()) - min(v.values()) for s, v in by.items()}
    total = sum(evidence.values()) or 1
    weights, table = {}, {}
    for s, v in by.items():
        w = budget * evidence[s] / total
        worst, best = max(v.values()), min(v.values())        # higher ln LR = more attacker-like
        weights[s] = round(w)
        table[s] = {lv: round(w * (worst - ln) / (worst - best)) if worst > best else round(w) for lv, ln in v.items()}
    return evidence, weights, table


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('--location-weight', type=float, default=35, help='from the AHP survey (part B); default 35')
    ap.add_argument('--sample', type=float, default=100, help='percent of users to read (all account takeovers are always kept)')
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    print('Reading the dataset (this takes a while for the full file)...', file=sys.stderr)
    df = features(load(args.csv, sample_pct=args.sample))
    print(f"{len(df):,} logins of {df['user'].nunique():,} users; labels: {df['label'].value_counts().to_dict()}")
    cal = df[df['calibration'] & ~df['first_login']]   # a first login has no history (CARMA's bootstrap flow)

    rows = lr_rows(cal, 'ato') + lr_rows(cal, 'attack_ip')
    pd.DataFrame(rows).to_csv(os.path.join(OUT, 'lr_table.csv'), index=False)

    budget = 100 - args.location_weight
    result = {'location_weight': args.location_weight, 'calibration_users': int(cal['user'].nunique()), 'carma_current': CARMA}
    lines = []
    for attacker in ('ato', 'attack_ip'):
        sub = [r for r in rows if r['attacker'] == attacker]
        n = sub[0]['attacker_n']
        if n == 0:
            lines.append(f"\nAttacker = {attacker}: no such logins in the calibration users, skipped")
            continue
        evidence, weights, table = points(sub, budget)
        result[attacker] = {'attacker_logins': n, 'evidence_lnLR_spread': {k: round(v, 3) for k, v in evidence.items()},
                            'weights': weights, 'level_points': table}
        lines.append(f"\nAttacker = {attacker} ({n:,} logins in the calibration users)")
        for r in sub:
            lines.append(f"  {r['signal']:8} {r['level']:8} LR {r['LR']:>8}  ln LR {r['lnLR']:>7} [{r['lnLR_ci_low']}, {r['lnLR_ci_high']}]")
        lines.append(f"  weights (budget {budget:g}): {weights}   level points: {table}")
    lines.append(f"\nCurrent CARMA points: {CARMA}")
    lines.append('Primary result: attacker = ato (account takeovers). attack_ip is a larger, noisier cross-check.')
    text = '\n'.join(lines)
    print(text)
    open(os.path.join(OUT, 'weights_rba.txt'), 'w').write(text + '\n')
    json.dump(result, open(os.path.join(OUT, 'weights_rba.json'), 'w'), indent=2)
    # weights file in the format derive.py --weights expects
    w = result['ato']['weights']
    json.dump({'L': args.location_weight, 'D': w['device'], 'T': w['time'], 'N': w['network']},
              open(os.path.join(OUT, 'weights_for_derive.json'), 'w'))
    print(f"\nWritten to {OUT}. Send me weights_rba.txt and lr_table.csv.")


if __name__ == '__main__':
    main()
