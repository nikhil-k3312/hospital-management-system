"""
Problem 20: System Usability Scale (SUS, Brooke 1996) for the pilot.

sus_responses.csv: one row per participant: participant,role,q1,...,q10 (answers 1-5, the
standard 10 SUS statements in the standard order). Use the same participant codes as
pilot_logins.csv if you want to relate usability to the sign-in tiers each person saw.

    python sus.py sus_responses.csv
    python sus.py sus_responses.csv --logins out/pilot_logins.csv

SUS score = 2.5 x [ sum over odd items (answer - 1) + sum over even items (5 - answer) ], 0-100.
Reports mean, SD and 95% confidence interval overall and per role (t distribution).
"""
import argparse, csv, math, statistics, sys

T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
       12: 2.179, 15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042}


def t95(df):
    return T95.get(df) or T95[min((k for k in T95 if k >= df), default=30)]


def sus_score(row):
    q = [int(row[f'q{i}']) for i in range(1, 11)]
    if any(v < 1 or v > 5 for v in q):
        raise ValueError(f"participant {row.get('participant')}: answers must be 1-5")
    return 2.5 * (sum(q[i] - 1 for i in range(0, 10, 2)) + sum(5 - q[i] for i in range(1, 10, 2)))


def describe(label, xs):
    if not xs:
        return f'{label}: no answers'
    m = statistics.mean(xs)
    if len(xs) < 2:
        return f'{label}: n=1, SUS {m:.1f}'
    sd = statistics.stdev(xs)
    h = t95(len(xs) - 1) * sd / math.sqrt(len(xs))
    return f'{label}: n={len(xs)}, SUS mean {m:.1f}, SD {sd:.1f}, 95% CI [{m - h:.1f}, {m + h:.1f}]'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('responses')
    ap.add_argument('--logins')
    a = ap.parse_args()
    rows = list(csv.DictReader(open(a.responses, newline='', encoding='utf-8')))
    scores = {r['participant']: (r.get('role', ''), sus_score(r)) for r in rows}
    print(describe('all', [s for _, s in scores.values()]))
    for role in sorted({r for r, _ in scores.values()}):
        print(describe(f'  {role}', [s for r, s in scores.values() if r == role]))
    print('(68 is the usual average SUS; cite a benchmark source only if your guide adds it to the references)')
    if a.logins:
        logins = list(csv.DictReader(open(a.logins, newline='', encoding='utf-8')))
        done = [l for l in logins if l['event'] == 'login_context' and l['decision'] == 'ALLOW']
        print('\nper participant: share of sign-ins that were password-only, and SUS')
        for p, (role, s) in sorted(scores.items()):
            mine = [l for l in done if l['participant'] == p]
            low = sum(1 for l in mine if l['tier'] == 'low')
            print(f'  {p} {role:16} sign-ins {len(mine):3}  password-only {100 * low / len(mine) if mine else 0:5.1f}%  SUS {s:.1f}')


if __name__ == '__main__':
    main()
