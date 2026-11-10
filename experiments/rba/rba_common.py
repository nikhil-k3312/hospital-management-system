"""
Shared loading and feature extraction for the RBA login dataset of Wiefling et al.
(https://github.com/das-group/rba-dataset , https://zenodo.org/record/6782156 , CC BY 4.0).

The CSV has one row per login attempt: IP Address, Country, Region, City, ASN, User Agent
String, OS / Browser Name and Version, Device Type, User ID, Login Timestamp, Round-Trip Time,
Login Successful, Is Attack IP, Is Account Takeover. Header spellings are matched loosely.

CARMA signals computed from each user's OWN history (rows sorted by user, then time):
  device   "trusted" if this user-agent string was seen before for this user, else "new"
           (proxy for CARMA's enrolled-device cookie: the dataset has no cookies)
  network  "known" if this IPv4 /24 (IPv6 /48) was seen before for this user, else "new";
           also "known_asn" (new prefix, but a provider the user used before), reported separately
  time     "duty" (usual) if this user logged in before at this hour of day (UTC), else "off"
  failures failed attempts since this user's last successful login
  location always "unknown": the dataset has no GPS position
Users are split 70/30 by a hash of the user id (fixed, reproducible): calibration / evaluation.
"""
import os, re, sys, zlib
import numpy as np
import pandas as pd

WANTED = {
    'ip': ['ipaddress', 'ip'],
    'asn': ['asn'],
    'ua': ['useragentstring', 'useragent'],
    'user': ['userid', 'user'],
    'ts': ['logintimestamp', 'timestamp'],
    'success': ['loginsuccessful', 'success'],
    'attack_ip': ['isattackip'],
    'ato': ['isaccounttakeover', 'accounttakeover'],
}


def norm(name):
    return re.sub(r'[^a-z0-9]', '', name.lower())


def find_columns(path):
    header = pd.read_csv(path, nrows=0).columns
    by_norm = {norm(c): c for c in header}
    cols = {}
    for key, options in WANTED.items():
        hit = next((by_norm[o] for o in options if o in by_norm), None)
        if hit is None:
            sys.exit(f'Column for "{key}" not found. Header is: {list(header)}')
        cols[key] = hit
    return cols


def to_bool(series):
    if series.dtype == bool:
        return series
    return series.astype(str).str.strip().str.lower().isin(['true', '1', 'yes', 't'])


def prefix_of(ip_series):
    ip = ip_series.astype(str)
    v4 = ip.str.contains(r'^\d+\.\d+\.\d+\.\d+$', regex=True)
    out = ip.str.rsplit('.', n=1).str[0]                      # a.b.c (the /24)
    out = out.where(v4, ip.str.split(':').str[:3].str.join(':'))  # IPv6 /48
    return out


def user_split(user_ids, calibration_pct=70):
    """True = calibration user. CRC32 of the user id: the same split on every machine."""
    return np.array([zlib.crc32(str(u).encode()) % 100 < calibration_pct for u in user_ids])


def load(path, chunksize=2_000_000, sample_pct=100):
    """Reads only the needed columns, chunk by chunk, into compact integer columns."""
    cols = find_columns(path)
    parts = []
    read = 0
    for chunk in pd.read_csv(path, usecols=list(cols.values()), chunksize=chunksize, dtype=str, keep_default_na=False):
        c = chunk.rename(columns={v: k for k, v in cols.items()})
        if sample_pct < 100:
            keep = np.array([zlib.crc32(('s' + u).encode()) % 100 < sample_pct for u in c['user']]) | to_bool(c['ato']).values
            c = c[keep]
        ts = pd.to_numeric(c['ts'], errors='coerce')
        ts = pd.to_datetime(ts, unit='ms') if ts.notna().all() else pd.to_datetime(c['ts'], errors='coerce')
        parts.append(pd.DataFrame({
            'user': c['user'].values,
            'ts': ts.values,
            'ua': pd.util.hash_pandas_object(c['ua'], index=False).values,
            'prefix': pd.util.hash_pandas_object(prefix_of(c['ip']), index=False).values,
            'asn': pd.util.hash_pandas_object(c['asn'], index=False).values,
            'success': to_bool(c['success']).values,
            'attack_ip': to_bool(c['attack_ip']).values,
            'ato': to_bool(c['ato']).values,
        }))
        read += len(chunk)
        print(f'  read {read:,} rows', file=sys.stderr)
    df = pd.concat(parts, ignore_index=True)
    if df['ts'].isna().any():
        print(f"  warning: {int(df['ts'].isna().sum())} rows without a readable timestamp were dropped", file=sys.stderr)
        df = df[df['ts'].notna()]
    return df


def features(df):
    """Adds the CARMA signal levels from each user's own earlier logins."""
    df = df.sort_values(['user', 'ts'], kind='mergesort').reset_index(drop=True)
    df['hour'] = df['ts'].dt.hour.astype('int8')
    df['device'] = np.where(df.duplicated(['user', 'ua']), 'trusted', 'new')
    df['network'] = np.where(df.duplicated(['user', 'prefix']), 'known', 'new')
    known_asn = df.duplicated(['user', 'asn'])
    df['network3'] = np.where(df['network'] == 'known', 'known', np.where(known_asn, 'known_asn', 'new'))
    df['time'] = np.where(df.duplicated(['user', 'hour']), 'duty', 'off')
    succ = df['success'].astype(int)
    failed = 1 - succ
    seg = df.groupby('user')['success'].cumsum() - succ                     # successes strictly before
    # failed attempts since the last success = running count of failures inside the segment, excluding this row
    df['failures'] = (failed.groupby([df['user'], seg]).cumsum() - failed).astype('int16')
    first = ~df.duplicated(['user'])
    df['first_login'] = first                                               # no history: CARMA's bootstrap
    df['calibration'] = user_split(df['user'].values)
    df['label'] = np.where(df['ato'], 'ato', np.where(df['success'] & ~df['attack_ip'], 'legit', np.where(df['attack_ip'], 'attack_ip', 'other')))
    return df
