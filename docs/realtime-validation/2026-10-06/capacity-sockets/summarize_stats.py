import csv,sys,collections
m=collections.defaultdict(lambda:[0.0,0.0])
for r in csv.reader(open(sys.argv[1])):
    if len(r)<4: continue
    c=float(r[2].strip('%')); u=r[3].split('/')[0].strip()
    v=float(u[:-3])*(1024 if u.endswith('GiB') else 1) if u[-3:] in('MiB','GiB') else 0
    m[r[1]][0]=max(m[r[1]][0],c); m[r[1]][1]=max(m[r[1]][1],v)
for k,(c,v) in m.items(): print(k.replace('orgiq-bff-',''),'cpuPeak',c,'memPeakMiB',round(v,1))
