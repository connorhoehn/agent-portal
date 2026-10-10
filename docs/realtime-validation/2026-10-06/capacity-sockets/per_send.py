#!/usr/bin/env python3
# usage: per_send.py <attrib label> — Dynamo requests by origin|stage|family>table:op, per chat send (both nodes)
import json,sys,collections,os
E=os.path.dirname(os.path.abspath(__file__)); L=sys.argv[1]
t=collections.Counter(); acts=collections.Counter()
for n in 'ab':
    m=json.load(open(f'{E}/{L}-{n}-metrics.json'))
    for k,v in m['originDynamo'].items(): t[k]+=v['count']
    for k,v in m['actions'].items(): acts[k]+=v
sends=acts['ws:chat.send'] if 'ws:chat.send' in acts else acts['chat.send']
send_keys=[k for k in t if k.startswith(('ws:chat.send|','peer:channel.message|','peer:subscription-check'))]
print(f'{L}: sends={sends} all={sum(t.values())} ({sum(t.values())/sends:.2f}/send) send-path={sum(t[k] for k in send_keys)/sends:.2f}/send')
for k,v in sorted(t.items(),key=lambda x:-x[1]): print('%6d %5.2f %s %s'%(v,v/sends,'*' if k in send_keys else ' ',k))
