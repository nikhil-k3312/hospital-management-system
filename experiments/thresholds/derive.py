"""
Policy-to-threshold method (Problem 6, decision D10).

Instead of choosing the thresholds by hand, the hospital writes plain-language rules per role
(rules.csv). Each rule says how one family of contexts must be treated, and becomes an
inequality on the role's thresholds (T(C) = trust score of context C; low if T > U, medium if
T >= L, high otherwise; the gates of Problems 4-5 apply on top):

    at_least_code     every context C of the rule must NOT be password-only   ->  U >= T(C)
    third_factor      every context C must reach the high tier                 ->  L >  T(C)
    password_only     every context C must be password-only                    ->  U <  T(C)
                      (and must pass the gates: trusted device, failures < 2)
    not_third_factor  no context C may reach the high tier                     ->  L <= T(C)

For each role the method takes the SMALLEST U and the SMALLEST L that satisfy all its rules
(most password-only logins and fewest authenticator prompts the policy allows), reports the
rule that fixes each threshold ("binding rule") and any rules that contradict each other,
and draws the friction-security curve.

    python derive.py                       uses rules.csv and the weights 35/25/20/20
    python derive.py --weights w.json      {"L":35,"D":25,"T":20,"N":20} e.g. after Problem 15
    python derive.py --rules my_rules.csv

Writes out/derived_thresholds.csv, out/derived.env (lines for the API .env),
out/friction_security_<role>.csv and out/friction_security.png.
A "*" in a rule column means "every level"; the rule must hold for all of them.
"""
import argparse, csv, itertools, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
ROLES = ['patient', 'insurance_agent', 'doctor', 'admin']
LEVELS = {
    'location': {'near': 1.0, 'mid': 20 / 35, 'unknown': 15 / 35, 'far': 5 / 35},
    'device': {'trusted': 1.0, 'new': 10 / 25},
    'time': {'duty': 1.0, 'off': 0.5},
    'network': {'hospital': 1.0, 'known': 0.75, 'new': 0.25},
}
KEY = {'location': 'L', 'device': 'D', 'time': 'T', 'network': 'N'}


POINTS = None  # set by --points: exact points per level (same file as the API's CONTEXT_POINTS)


def score(ctx, w):
    if POINTS:
        s = sum(POINTS[sig][ctx[sig]] for sig in LEVELS)
        s -= min(POINTS['penalty']['max'], POINTS['penalty']['perFailure'] * ctx['failures'])
    else:
        s = sum(w[KEY[sig]] * LEVELS[sig][ctx[sig]] for sig in LEVELS)
        s -= min(30, 10 * ctx['failures'])
    return int(round(max(0, min(100, s))))


def expand(rule):
    """All concrete contexts a rule covers."""
    options = [list(LEVELS[sig]) if rule[sig] == '*' else [rule[sig]] for sig in LEVELS]
    for combo in itertools.product(*options):
        ctx = dict(zip(LEVELS, combo))
        ctx['failures'] = int(rule['failures'] or 0)
        yield ctx


def applies(rule, role):
    return rule['roles'] == 'all' or role in rule['roles'].split(';')


def derive(rules, w, role, min_lower=0):
    mine = [r for r in rules if applies(r, role)]
    upper, upper_by = 0, '(none: no at_least_code rule)'
    lower, lower_by = min_lower, f'(floor --min-lower {min_lower})' if min_lower else '(none: no third_factor rule)'
    for r in mine:
        scores = [score(c, w) for c in expand(r)]
        if r['requirement'] == 'at_least_code' and max(scores) >= upper:
            upper, upper_by = max(scores), r['rule']
        if r['requirement'] == 'third_factor' and max(scores) + 1 > lower:
            lower, lower_by = max(scores) + 1, r['rule']
    conflicts = []
    for r in mine:
        for c in expand(r):
            t = score(c, w)
            if r['requirement'] == 'password_only':
                if c['device'] != 'trusted' or c['failures'] >= 2:
                    conflicts.append(f"{r['rule']}: password-only is impossible without a trusted device / with 2+ failures (gates)")
                elif not t > upper:
                    conflicts.append(f"{r['rule']} needs U < {t}, but {upper_by} needs U >= {upper}")
            if r['requirement'] == 'not_third_factor' and not lower <= t:
                conflicts.append(f"{r['rule']} needs L <= {t}, but {lower_by} needs L >= {lower}")
    if lower > upper:
        conflicts.append(f'L = {lower} > U = {upper}: raise U to {lower} or relax {lower_by}')
    return {'role': role, 'upper': upper, 'upper_binding_rule': upper_by, 'lower': lower,
            'lower_binding_rule': lower_by, 'rules': len(mine), 'conflicts': ' | '.join(sorted(set(conflicts)))}


def grid():
    for combo in itertools.product(*[list(v) for v in LEVELS.values()], range(4)):
        ctx = dict(zip(list(LEVELS) + ['failures'], combo))
        yield ctx


def friction_curve(rules, w, role, lower):
    """For every possible U: share of returning-user contexts that stay password-only,
    against the share of this role's at_least_code rules that are still respected."""
    returning = [c for c in grid() if c['device'] == 'trusted' and c['location'] != 'far' and c['failures'] == 0]
    code_rules = [r for r in rules if applies(r, role) and r['requirement'] == 'at_least_code']
    rows = []
    for u in range(0, 101):
        pw_only = sum(1 for c in returning if score(c, w) > u) / len(returning)
        ok = sum(1 for r in code_rules if max(score(c, w) for c in expand(r)) <= u)
        rows.append({'upper': u, 'password_only_share': round(pw_only, 4),
                     'code_rules_respected': ok, 'code_rules_total': len(code_rules)})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rules', default=os.path.join(HERE, 'rules.csv'))
    ap.add_argument('--weights', default=None, help='{"L":35,"D":25,"T":20,"N":20}, level ratios as in the paper')
    ap.add_argument('--points', default=None, help='../rba/out/context_points.json: exact points per level (overrides --weights)')
    ap.add_argument('--min-lower', type=int, default=0, help='optional floor for every lower threshold (e.g. 50), if your guide wants one')
    args = ap.parse_args()
    w = {'L': 35, 'D': 25, 'T': 20, 'N': 20}
    if args.weights:
        w.update(json.load(open(args.weights)))
    global POINTS
    if args.points:
        POINTS = json.load(open(args.points))
    with open(args.rules, newline='', encoding='utf-8') as fh:
        rules = list(csv.DictReader(fh))
    os.makedirs(OUT, exist_ok=True)

    results = [derive(rules, w, role, args.min_lower) for role in ROLES]
    with open(os.path.join(OUT, 'derived_thresholds.csv'), 'w', newline='') as fh:
        wr = csv.DictWriter(fh, fieldnames=results[0].keys()); wr.writeheader(); wr.writerows(results)
    with open(os.path.join(OUT, 'derived.env'), 'w') as fh:
        for r in results:
            fh.write(f"RISK_{r['role'].upper()}_UPPER={r['upper']}\nRISK_{r['role'].upper()}_LOWER={r['lower']}\n")

    print(f"weights {w}\n")
    print(f"{'role':16} {'U':>4} {'binding':>8} {'L':>4} {'binding':>8}  conflicts")
    for r in results:
        print(f"{r['role']:16} {r['upper']:>4} {r['upper_binding_rule']:>8} {r['lower']:>4} {r['lower_binding_rule']:>8}  {r['conflicts'] or '-'}")

    curves = {}
    for r in results:
        curves[r['role']] = friction_curve(rules, w, r['role'], r['lower'])
        with open(os.path.join(OUT, f"friction_security_{r['role']}.csv"), 'w', newline='') as fh:
            wr = csv.DictWriter(fh, fieldnames=curves[r['role']][0].keys()); wr.writeheader(); wr.writerows(curves[r['role']])
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        plt.rcParams.update({'font.family': 'STIXGeneral', 'mathtext.fontset': 'stix', 'font.size': 9})
        fig, axes = plt.subplots(1, 4, figsize=(7.2, 2.1), sharey=True)
        for ax, r in zip(axes, results):
            c = curves[r['role']]
            ax.plot([x['upper'] for x in c], [100 * x['password_only_share'] for x in c], color='#2a78d6', lw=1.4, label='password-only (%)')
            ax2 = ax.twinx()
            ax2.step([x['upper'] for x in c], [x['code_rules_respected'] for x in c], where='post', color='#eb6834', lw=1.2, label='rules respected')
            ax2.set_ylim(0, max(1, c[0]['code_rules_total']) + 0.5)
            ax.axvline(r['upper'], color='#1baf7a', ls='--', lw=1)
            ax.set_title(r['role'].replace('_', ' '), fontsize=9)
            ax.set_xlabel('upper threshold $U_r$')
            if ax is axes[0]:
                ax.set_ylabel('returning logins\npassword-only (%)')
        fig.tight_layout()
        fig.savefig(os.path.join(OUT, 'friction_security.png'), dpi=300)
    except ImportError:
        print('matplotlib not installed: figure skipped')
    print(f"\nWritten to {OUT}")


if __name__ == '__main__':
    main()
