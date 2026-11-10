# CARMA experiments

Everything needed to produce the results of the Objective 1 paper. Run each step on your laptop
and send the output files listed. Nothing here touches your development data: the live
experiments use their own database (`medichain_experiments`) and Redis index 14.

| Folder | What | Problem | Needs |
|---|---|---|---|
| `thresholds/` | Policy-to-threshold method: `derive.py` + `rules.csv` | 6 (D10) | Python |
| `model/` | Decision model, figures, AHP survey (`ahp/`) | 15 B | Python |
| `rba/` | Weight calibration and evaluation on the RBA login dataset | 15 A, 21 | Python, the dataset |
| `live/replay_grid.js` | 192 contexts x 4 roles against the real API | 16 | MongoDB, Redis |
| `live/attacks.js` | 16 attack scenarios x 3 configurations | 17 | MongoDB, Redis |
| `live/perf.js` | Latency and throughput (autocannon) | 18 | MongoDB, Redis |
| `live/chain_cost.js` | Gas, finality time, verification time | 19 | + Hardhat or Besu |
| `pilot/export_pilot.js`, `pilot/sus.py` | Anonymised pilot export; System Usability Scale | 20 | the pilot server |

Python: `pip install -r requirements.txt` (pandas, numpy, matplotlib).
Node: run `npm install` once in `backend/services/api` (the live scripts use its packages).

## Commands

```
cd experiments/thresholds && python derive.py                      # Problem 6
cd experiments/rba && python calibrate.py data/rba-dataset.csv       # Problem 15 A
cd experiments/rba && python evaluate.py data/rba-dataset.csv --points out/context_points.json --thresholds ../thresholds/out/derived.env   # Problem 21
cd experiments/thresholds && python derive.py --points ../rba/out/context_points.json   # thresholds again with the calibrated points
cd experiments/pilot && node export_pilot.js && python sus.py sus_responses.csv --logins out/pilot_logins.csv   # Problem 20
cd experiments/live && node replay_grid.js                           # Problem 16 (also --profile v3, --profile static)
cd experiments/live && node attacks.js --reps 20                     # Problem 17
cd experiments/live && node perf.js                                  # Problem 18 (--quick for a short test)
cd experiments/live && node chain_cost.js --label hardhat            # Problem 19 (and --label besu)
```

## RBA dataset (Problems 15 and 21)

Wiefling et al., "Pump Up Password Security! Evaluating and Enhancing Risk-Based Authentication
on a Real-World Large-Scale Online Service" (your reference 3). More than 33 million login
attempts of 3.3 million users, licence CC BY 4.0.

* https://github.com/das-group/rba-dataset (Releases)
* https://zenodo.org/record/6782156 (`rba-dataset.zip`, about 1.1 GB compressed)

Unzip into `experiments/rba/data/` (git ignores that folder; do not commit the data). The full
file needs about 8-12 GB of RAM; on a smaller laptop add `--sample 25` (25% of the users; every
account takeover is always kept). `make_synthetic.py` makes a tiny fake file only to check that
the scripts run; never report numbers from it.

## What to send back

Notes on validity (state them in the paper): rate limiting is OFF in the live experiments except
scenario S10 of attacks.js, which measures it; perf.js runs without ledger anchoring (measured
by chain_cost.js); the RBA dataset has no GPS and its "trusted device" is "user-agent seen before".

The small files in each `out/` folder: `derived_thresholds.csv`, `weights_rba.txt`, `context_points.json`,
`lr_table.csv`, `eval_summary.txt`, `replay_*.csv`, `attacks.csv`, `perf.csv`,
`perf_environment.json`, `chain_*_summary.txt`, `verify_*.csv`. None contains personal data.
