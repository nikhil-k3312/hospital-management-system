"""Writes a tiny synthetic file with the RBA dataset's layout, ONLY to test the scripts
(python make_synthetic.py; python calibrate.py data/synthetic.csv; python evaluate.py data/synthetic.csv).
Never report numbers from it."""
import os, random
import pandas as pd

random.seed(7)
rows = []
t0 = 1_580_000_000_000
for u in range(3000):
    uas = [f'Mozilla/5.0 UA{u}-{k}' for k in range(2)]
    nets = [f'10.{u % 250}.{k}.' for k in range(2)]
    hours = [random.randint(7, 21) for _ in range(2)]
    t = t0 + random.randint(0, 10 ** 9)
    for i in range(random.randint(2, 15)):
        t += random.randint(3_600_000, 5 * 86_400_000)
        ok = random.random() > 0.05
        rows.append({'index': len(rows), 'Login Timestamp': pd.Timestamp(t, unit='ms').strftime('%Y-%m-%d %H:%M:%S.%f')[:-3], 'User ID': u,
                     'Round-Trip Time [ms]': random.randint(20, 900), 'IP Address': random.choice(nets) + str(random.randint(1, 250)),
                     'Country': 'NO', 'Region': '-', 'City': '-', 'ASN': 29695, 'User Agent String': random.choice(uas),
                     'Browser Name and Version': 'Chrome 80', 'OS Name and Version': 'Windows 10', 'Device Type': 'desktop',
                     'Login Successful': ok, 'Is Attack IP': False, 'Is Account Takeover': False})
    if random.random() < 0.08:  # a takeover: new UA, new network, odd hour
        t += 86_400_000
        rows.append({'index': len(rows), 'Login Timestamp': pd.Timestamp(t, unit='ms').strftime('%Y-%m-%d %H:%M:%S.%f')[:-3], 'User ID': u,
                     'Round-Trip Time [ms]': 700, 'IP Address': f'172.16.{random.randint(0, 255)}.{random.randint(1, 250)}',
                     'Country': 'XX', 'Region': '-', 'City': '-', 'ASN': 4242, 'User Agent String': f'curl/{random.randint(1, 9)}',
                     'Browser Name and Version': '-', 'OS Name and Version': '-', 'Device Type': 'bot',
                     'Login Successful': True, 'Is Attack IP': True, 'Is Account Takeover': True})
os.makedirs('data', exist_ok=True)
pd.DataFrame(rows).to_csv('data/synthetic.csv', index=False)
print(f'{len(rows)} rows written to data/synthetic.csv')
