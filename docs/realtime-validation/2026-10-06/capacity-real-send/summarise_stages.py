# Count/timing-only summary of a metrics-after (minus metrics-before) pair.
import json, sys
E, label = sys.argv[1], sys.argv[2]
def load(n, when):
    try: return json.load(open(f'{E}/{label}-{n}-metrics-{when}.json'))
    except FileNotFoundError: return {}
def diff(after, before):
    out = {}
    for k, v in after.items():
        b = before.get(k, {})
        out[k] = {f: v[f] - b.get(f, 0) for f in ('count', 'errors', 'totalMs') }
        out[k]['maxMs'] = v.get('maxMs'); out[k]['inFlightPeak'] = v.get('inFlightPeak')
    return out
summary = {}
for n in 'ab':
    a, b = load(n, 'after'), load(n, 'before')
    if not a: continue
    row = summary[n] = {'eventLoopMs': a.get('eventLoopMs'), 'dynamoHttpPool': a.get('dynamoHttp'),
        'cpuUserS': round((a['cpu']['user'] - b.get('cpu', {}).get('user', 0)) / 1e6, 1)}
    for coll in ('stages', 'stageDynamo', 'operations', 'dynamoTables'):
        d = diff(a.get(coll, {}), b.get(coll, {}))
        row[coll] = {k: {**v, 'avgMs': round(v['totalMs'] / v['count'], 1) if v['count'] else None, 'totalMs': round(v['totalMs'])}
                     for k, v in sorted(d.items(), key=lambda kv: -kv[1]['totalMs']) if v['count']}
    hb = b.get('dynamoHttpByStage', {})
    row['dynamoHttpByStage'] = {}
    for k, v in sorted(a.get('dynamoHttpByStage', {}).items(), key=lambda kv: -kv[1]['waitMs']):
        p = hb.get(k, {}); c = v['count'] - p.get('count', 0)
        if c <= 0: continue
        w = v['waitMs'] - p.get('waitMs', 0); s = v['serviceMs'] - p.get('serviceMs', 0)
        row['dynamoHttpByStage'][k] = {'count': c, 'avgWaitMs': round(w / c, 1), 'avgServiceMs': round(s / c, 1), 'waitMaxMs': round(v['waitMaxMs']), 'serviceMaxMs': round(v['serviceMaxMs'])}
json.dump(summary, open(f'{E}/{label}-stage-summary.json', 'w'), indent=1)
for n, row in summary.items():
    print(f'== node {n}: loop {row["eventLoopMs"]} pool {row["dynamoHttpPool"]} cpu {row["cpuUserS"]}s')
    for k, v in list(row['stages'].items())[:18]: print(f'  stage {k:42} n={v["count"]:6} avg={v["avgMs"]:8} max={round(v["maxMs"] or 0):6} peakInFlight={v["inFlightPeak"]}')
    for k, v in list(row['stageDynamo'].items())[:14]: print(f'  ddb   {k:58} n={v["count"]:6} avg={v["avgMs"]:8}')
    for k, v in list(row['dynamoHttpByStage'].items())[:12]: print(f'  http  {k:42} n={v["count"]:6} wait={v["avgWaitMs"]:8} service={v["avgServiceMs"]:8}')
