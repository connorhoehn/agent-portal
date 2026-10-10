# Keep every load WebSocket inside the inspected Docker network. The host's
# SSH bridge carries only control requests and fixture service connections.
import json, os, pathlib, subprocess, sys
if os.environ.get('ORGIQ_BFF_CONTAINER_ACCEPTANCE')!='1': raise RuntimeError('Opt in to the owned compiled load fixture')
profile=sys.argv[1] if len(sys.argv)==2 else 'pilot'
profiles={
 'pilot':['--sockets','60','--calls','10','--group-size','2,4','--hold-seconds','10','--spread-seconds','2'],
 'steady':['--sockets','1000','--calls','100','--group-size','2,4','--hold-seconds','60','--spread-seconds','20'],
 'ring-storm':['--sockets','1000','--calls','100','--group-size','2,4','--hold-seconds','60','--scenario','ring-storm'],
 'double-accept':['--sockets','1000','--calls','100','--group-size','2','--hold-seconds','30','--spread-seconds','10','--scenario','double-accept'],
 'churn':['--sockets','1000','--calls','100','--group-size','2,4','--hold-seconds','60','--spread-seconds','20','--scenario','churn'],
 'soak':['--sockets','1000','--calls','100','--group-size','2','--spread-seconds','20','--scenario','soak','--soak-seconds','300','--token-ttl-seconds','120'],
 'burst':['--sockets','1000','--calls','100','--group-size','2','--hold-seconds','10','--spread-seconds','2','--chat-startup','burst'],
}
if profile not in profiles: raise RuntimeError('Choose one declared compiled load profile')
envfile=os.environ.get('ORGIQ_BFF_RUNTIME_ENV_FILE')
if not envfile: raise RuntimeError('Set the private runtime profile')
network='orgiq-bff-capacity-network'
net=json.loads(subprocess.check_output(['docker','network','inspect',network],text=True))[0]
if net['Name']!=network or net['Labels'].get('orgiq.validation')!='bff-capacity-container': raise RuntimeError('Capacity network identity check failed')
gateway_rows=[]
for name in ['orgiq-bff-capacity-a','orgiq-bff-capacity-b']:
 row=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
 if row['Name']!='/'+name or row['Config']['Labels'].get('orgiq.validation')!='bff-capacity-container' or not row['State']['Running'] or row['NetworkSettings']['Networks'][network]['NetworkID']!=net['Id']: raise RuntimeError('Capacity BFF identity check failed')
 gateway_rows.append(row)
# Docker Running precedes HTTP/leased-router startup. Check real readiness
# inside the same network before ramping; preserve every load threshold.
readiness="""
const start=Date.now(), end=start+15000;
while (true) {
  try {
    const ready=await Promise.all(['a','b'].map(async node=>{
      const response=await fetch('http://orgiq-bff-capacity-'+node+':3001/api/health',{signal:AbortSignal.timeout(1000)});
      const body=await response.json();
      return response.status===200 && body.service==='orgiq-middleware' && body.realtime?.ready===true;
    }));
    if (ready.every(Boolean)) {console.log('Owned compiled HTTP listeners and leased routers ready; preflight '+(Date.now()-start)+'ms');break;}
  } catch {}
  if (Date.now()>=end) throw new Error('Owned compiled BFF readiness timed out before load');
  await new Promise(resolve=>setTimeout(resolve,100));
}
"""
ready=subprocess.run(['docker','exec',gateway_rows[0]['Id'],'node','--input-type=module','-e',readiness],check=True,capture_output=True,text=True,timeout=20)
print(ready.stdout.strip(),flush=True)
volume='orgiq-bff-capacity-results'
existing=subprocess.run(['docker','volume','inspect',volume],capture_output=True,text=True)
if existing.returncode==0:
 if json.loads(existing.stdout)[0]['Labels'].get('orgiq.validation')!='bff-capacity-container': raise RuntimeError('Capacity results volume identity check failed')
else: subprocess.run(['docker','volume','create','--label','orgiq.validation=bff-capacity-container',volume],check=True,stdout=subprocess.DEVNULL)
private=json.loads(pathlib.Path(envfile).read_text())
key=(private.get('REALTIME_JWT_SECRET') or '').strip()
if '\n' in key or '\r' in key: raise RuntimeError('Unsupported multiline signing key')
driver_env=pathlib.Path('/tmp/orgiq-bff-capacity-driver.env'); driver_env.write_text('REALTIME_JWT_SECRET='+key+'\n'); driver_env.chmod(0o600)
name='orgiq-bff-capacity-driver-'+profile
if subprocess.run(['docker','inspect',name],capture_output=True).returncode==0: raise RuntimeError('Retain/copy the existing driver result before reusing its exact name')
result='/results/'+profile+'.json'
args=['--url','ws://orgiq-bff-capacity-a:3001/ws','--peer-url','ws://orgiq-bff-capacity-b:3001/ws','--driver-container',name,'--sample-container','orgiq-bff-capacity-a','--peer-container','orgiq-bff-capacity-b','--identity-manifest','/results/identities.json','--json',result,*profiles[profile]]
container=subprocess.check_output(['docker','create','--name',name,'--network',network,'--label','orgiq.validation=bff-capacity-driver','--cpus','1','--memory','512m','--pids-limit','256','--env-file',str(driver_env),'--volume','/var/run/docker.sock:/var/run/docker.sock','--volume',volume+':/results','--security-opt','no-new-privileges:true','--cap-drop','ALL','orgiq-bff-capacity-driver:local',*args],text=True).strip()
public_manifest=pathlib.Path('/tmp/orgiq-bff-capacity-public-identities.json')
public_manifest.write_bytes(pathlib.Path('/tmp/orgiq-bff-container-capacity-identities.json').read_bytes()); public_manifest.chmod(0o644)
# Only synthetic subject IDs, roles and epochs are in this file. Keep the
# signing profile private while allowing the capability-restricted driver
# to read a host-owned manifest copied into its results volume.
subprocess.run(['docker','cp',str(public_manifest),container+':/results/identities.json'],check=True)
print('Started internal compiled load profile',profile,'driver',container,flush=True)
subprocess.run(['docker','start','--attach',container],check=False)
exitcode=int(subprocess.check_output(['docker','inspect','--format','{{.State.ExitCode}}',container],text=True).strip())
destination='/tmp/orgiq-bff-container-internal-'+profile+'.json'
copied=subprocess.run(['docker','cp',container+':'+result,destination],capture_output=True)
if copied.returncode==0: print('Copied complete result to',destination,flush=True)
else: print('No complete result was produced; retained stopped driver for diagnosis',flush=True)
raise SystemExit(exitcode)
