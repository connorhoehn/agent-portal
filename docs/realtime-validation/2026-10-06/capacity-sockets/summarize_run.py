#!/usr/bin/env python3
# usage: summarize_run.py <label>... — one line per run from the driver log, docker stats and metrics files
import json,re,sys,os,csv,collections
E=os.path.dirname(os.path.abspath(__file__))
def p95(line):
    m=re.search(r'p95 ([0-9.]+)',line); return float(m.group(1)) if m else None
for L in sys.argv[1:]:
    d=open(f'{E}/{L}-driver.log').read()
    g=lambda k: next((p95(l) for l in d.splitlines() if l.strip().startswith(k)),None)
    hp=re.findall(r'health p99[^:]*: ([0-9.]+)',d)
    stats=collections.defaultdict(lambda:[0.0,0.0])
    for r in csv.reader(open(f'{E}/{L}-docker-stats.csv')):
        if len(r)<4: continue
        c=float(r[2].strip('%')); u=r[3].split('/')[0].strip()
        v=float(u[:-3])*(1024 if u.endswith('GiB') else 1) if u[-3:] in('MiB','GiB') else 0
        s=stats[r[1].replace('orgiq-bff-','')]; s[0]=max(s[0],c); s[1]=max(s[1],v)
    q=[];w=[];lim=None;req=0;sends=0
    for n in 'ab':
        f=f'{E}/{L}-{n}-metrics.json'
        if not os.path.exists(f): continue
        m=json.load(open(f)); lim=m['dynamoHttp']['socketLimit']; q.append(m['dynamoHttp']['queuedPeak'])
        bs=m.get('dynamoHttpByStage',{}); c=sum(v['count'] for v in bs.values()); w.append(round(sum(v['waitMs'] for v in bs.values())/max(c,1),1))
        req+=sum(v['count'] for v in m['dynamoTables'].values())+m['operations'].get('dynamo:TransactWriteItemsCommand',{}).get('count',0)  # transactions carry no top-level TableName
        sends+=m['stageDynamo'].get('chat.send.persist>chat-messages:PutItemCommand',{}).get('count',0)
    fails=[l.strip()[6:].split(':')[0] for l in d.splitlines() if l.strip().startswith('FAIL ') and '×' not in l]
    delivered=re.search(r'\(n=(\d+) of (\d+) sent\)',d)
    print(json.dumps({'run':L,'invite':g('invite'),'accept':g('accept'),'chat':g('chat delivery'),'delivered':delivered.group(0)[1:-1] if delivered else None,
      'healthP99':[float(x) for x in hp],'memPeakMiB':{k:round(v[1],1) for k,v in stats.items() if 'capacity' in k},
      'cpuPeak':{k:v[0] for k,v in stats.items() if 'capacity' in k or 'dynamo' in k},'socketLimit':lim,'queuedPeak':q,'meanPoolWaitMs':w,
      'dynamoRequestsPerSend':round(req/sends,2) if sends else None,'fails':fails}))
