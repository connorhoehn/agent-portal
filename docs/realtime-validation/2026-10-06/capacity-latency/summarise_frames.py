# Count/timing-only summary of frame-pipeline metrics (log2/8 histograms,
# ~9% bucket resolution; percentiles report the bucket's upper bound).
import json, sys
E, label = sys.argv[1], sys.argv[2]
def pct(row, q):
    total = row['count']; seen = 0
    for b in sorted(row['buckets'], key=int):
        seen += row['buckets'][b]
        if seen >= q * total: return round(2 ** ((int(b) + 1) / 8) - 1, 1)
    return None
out = {}
for n in 'ab':
    try: d = json.load(open(f'{E}/{label}-{n}-metrics.json'))
    except FileNotFoundError: continue
    rows = {k: {'n': v['count'], 'p50': pct(v, .5), 'p95': pct(v, .95), 'p99': pct(v, .99), 'max': round(v['maxMs'], 1), 'avg': round(v['totalMs'] / v['count'], 1), 'sumS': round(v['totalMs'] / 1000, 1)}
            for k, v in d['hists'].items() if v['count']}
    out[n] = {'resetAt': d.get('resetAt'), 'eventLoopMs': d.get('eventLoopMs'), 'hists': dict(sorted(rows.items())), 'counters': dict(sorted(d['counters'].items()))}
json.dump(out, open(f'{E}/{label}-frames-summary.json', 'w'), indent=1)
keys = sys.argv[3:] or None
for n, row in out.items():
    print(f"== node {n} loop {row['eventLoopMs']} reset {row['resetAt']}")
    for k, v in row['hists'].items():
        if keys and not any(k.startswith(p) for p in keys): continue
        print(f"  {k:58} n={v['n']:6} p50={v['p50']:8} p95={v['p95']:8} p99={v['p99']:8} max={v['max']:8} sum={v['sumS']}s")
    for k, v in row['counters'].items():
        if k.startswith(('errorFrame', 'membership', 'sqlError', 'dynamoError', 'frames.')): print(f"  # {k} = {v}")
