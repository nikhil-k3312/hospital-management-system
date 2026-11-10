"""AHP weights for the four CARMA signals from expert pairwise judgements.

Fill responses.csv (one row per expert) using the Saaty 1-9 scale, then run:
    python ahp.py responses.csv

Each column answers "How much more important is the FIRST signal than the
SECOND for deciding whether a sign-in is genuine?"
    1 = equal, 3 = moderately, 5 = strongly, 7 = very strongly, 9 = extremely;
    use 1/3, 1/5, ... (or 0.333, 0.2, ...) when the SECOND is more important.
Signals: L = location agreement (IP vs browser position), D = trusted device,
         T = time of day, N = network of origin.

Output: weights per expert, consistency ratio (CR, must be < 0.10), and the
group weights (geometric mean of the individual matrices), scaled to 100.
"""
import csv, sys
import numpy as np

SIG = ['L', 'D', 'T', 'N']
PAIRS = [('L', 'D'), ('L', 'T'), ('L', 'N'), ('D', 'T'), ('D', 'N'), ('T', 'N')]
RI = {1: 0.0, 2: 0.0, 3: 0.58, 4: 0.90, 5: 1.12}       # Saaty random index

def parse(v):
    v = v.strip()
    if '/' in v:
        a, b = v.split('/'); return float(a) / float(b)
    return float(v)

def matrix(row):
    A = np.ones((4, 4))
    for a, b in PAIRS:
        x = parse(row[f'{a}_vs_{b}'])
        i, j = SIG.index(a), SIG.index(b)
        A[i, j], A[j, i] = x, 1 / x
    return A

def weights(A):
    vals, vecs = np.linalg.eig(A)
    k = int(np.argmax(vals.real))
    w = np.abs(vecs[:, k].real); w = w / w.sum()
    lam = vals[k].real
    ci = (lam - len(A)) / (len(A) - 1)
    return w, ci / RI[len(A)]

def main(path):
    rows = list(csv.DictReader(open(path)))
    mats = []
    print(f'{"expert":12s}' + ''.join(f'{s:>7s}' for s in SIG) + '     CR')
    for r in rows:
        A = matrix(r); w, cr = weights(A); mats.append(A)
        flag = '' if cr < 0.10 else '  <-- inconsistent, ask the expert to revise'
        print(f'{r["expert"][:12]:12s}' + ''.join(f'{100*x:7.1f}' for x in w) + f'  {cr:5.3f}{flag}')
    G = np.exp(np.mean([np.log(A) for A in mats], axis=0))   # geometric-mean aggregation
    w, cr = weights(G)
    print('-' * 46)
    print(f'{"GROUP":12s}' + ''.join(f'{100*x:7.1f}' for x in w) + f'  {cr:5.3f}')
    print(f'{"CARMA now":12s}' + ''.join(f'{x:7.1f}' for x in (35, 25, 20, 20)))

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'responses.csv')
