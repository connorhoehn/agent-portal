# Compiled Node 22 BFFs with fixed local budgets. Private profile is never printed.
import json, os, pathlib, subprocess
if os.environ.get('ORGIQ_BFF_CONTAINER_ACCEPTANCE')!='1': raise RuntimeError('Opt in to the owned compiled container fixture')
profile=os.environ.get('ORGIQ_BFF_RUNTIME_ENV_FILE')
if not profile: raise RuntimeError('Set the private owned runtime profile')
root=pathlib.Path(__file__).resolve().parents[1]
preload=root/'test-support/native-rds-preload.mjs'
image=os.environ.get('ORGIQ_BFF_CONTAINER_IMAGE','orgiq-middleware:cluster-capacity-validation')
if image not in ['orgiq-middleware:cluster-capacity-validation','orgiq-middleware:cluster-inbox-validation','orgiq-middleware:cluster-sdk-dispatch-validation','orgiq-middleware:cluster-baseline-profile-validation','orgiq-middleware:cluster-fanout-proof-validation','orgiq-middleware:cluster-authority-scope-validation']:
    raise RuntimeError('Choose a declared locally built capacity image')
image_id=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]['Id']
network='orgiq-bff-capacity-network'
inspect_network=subprocess.run(['docker','network','inspect',network],capture_output=True,text=True)
if inspect_network.returncode==0:
    network_row=json.loads(inspect_network.stdout)[0]
    if network_row['Name']!=network or network_row['Labels'].get('orgiq.validation')!='bff-capacity-container': raise RuntimeError('Capacity network identity check failed')
else:
    subprocess.run(['docker','network','create','--label','orgiq.validation=bff-capacity-container',network],check=True,stdout=subprocess.DEVNULL)
for name,internal,external in [('orgiq-bff-cluster-postgres','5432/tcp','15483'),('orgiq-bff-cluster-redis','6379/tcp','16483'),('orgiq-bff-cluster-dynamodb','8000/tcp','18063')]:
    rows=json.loads(subprocess.check_output(['docker','inspect',name],text=True)); row=rows[0]
    if len(rows)!=1 or row['Name']!='/'+name or row['Config']['Labels'].get('orgiq.validation')!='bff-cluster' or not row['State']['Running'] or row['State']['Paused'] or row['HostConfig']['PortBindings'][internal]!=[{'HostIp':'127.0.0.1','HostPort':external}]:
        raise RuntimeError('Dedicated native fixture identity check failed')
base=json.loads(pathlib.Path(profile).read_text())
command=['--import','/app/test-support/native-rds-preload.mjs','dist/index.js']
for label,port in [('a',3065),('b',3066)]:
    name='orgiq-bff-capacity-'+label
    existing=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
    if existing.returncode==0:
        row=json.loads(existing.stdout)[0]
        if row['Name']!='/'+name or row['Config']['Labels'].get('orgiq.validation')!='bff-capacity-container' or row['Config']['Cmd']!=command or row['HostConfig']['PortBindings'].get('3001/tcp')!=[{'HostIp':'127.0.0.1','HostPort':str(port)}]:
            raise RuntimeError('Owned capacity container identity check failed')
        if row['State']['Running']: subprocess.run(['docker','stop','--time','12',row['Id']],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['docker','rm',row['Id']],check=True,stdout=subprocess.DEVNULL)
    listener=subprocess.run(['lsof','-nP','-iTCP:'+str(port),'-sTCP:LISTEN','-Fp'],capture_output=True,text=True).stdout.splitlines()
    if listener:
        forwarder=pathlib.Path('/tmp/orgiq-capacity-forwarder.pid')
        pid=forwarder.read_text().strip() if forwarder.exists() else ''
        args=subprocess.run(['ps','-p',pid,'-o','args='],capture_output=True,text=True).stdout if pid.isdigit() else ''
        owned=os.environ.get('DOCKER_HOST')=='unix:///tmp/orgiq-capacity-docker.sock' and 'p'+pid in listener and args.startswith('ssh -F /dev/null -i /Users/connorhoehn/.colima/_lima/_config/user ') and 'ControlPath=none' in args and '/tmp/orgiq-capacity-docker.sock:/var/run/docker.sock' in args and '127.0.0.1:'+str(port)+':127.0.0.1:'+str(port) in args
        if not owned: raise RuntimeError('Capacity port occupied by another process')
    env=dict(base)
    env.update({'PORT':'3001','DEV_OFFLINE':'true','MOCK_AURORA':'false','MOCK_AGENTCORE':'true','MOCK_GUARDRAILS':'true','MOCK_CLOUDWATCH':'true','MOCK_QUEUE':'true','AUTH_DEMO_MODE':'true','NODE_ENV':'development','AWS_ACCESS_KEY_ID':'native-acceptance','AWS_SECRET_ACCESS_KEY':'native-acceptance','AWS_REGION':'us-east-1','AWS_DEFAULT_REGION':'us-east-1','AWS_EC2_METADATA_DISABLED':'true','AURORA_CLUSTER_ARN':'arn:aws:rds:us-east-1:000000000000:cluster:native-acceptance','AURORA_SECRET_ARN':'arn:aws:secretsmanager:us-east-1:000000000000:secret:native-acceptance','AURORA_DB_NAME':'orgiq','ORGIQ_NATIVE_RDS_URL':'postgresql://orgiq:local-cluster-fixture@host.docker.internal:15483/orgiq','ORGIQ_NATIVE_RDS_CONTAINER_FIXTURE':'1','REALTIME_GATEWAY':'on','REALTIME_GATEWAY_ROUTER':'redis','REALTIME_GATEWAY_NAMESPACE':'orgiq-bff-container-acceptance','REALTIME_GATEWAY_NODE_ID':'container-'+label,'REDIS_URL':'redis://host.docker.internal:16483','SOCIAL_CHAT_STORE':'dynamo','SOCIAL_CHAT_DYNAMODB_ENDPOINT':'http://host.docker.internal:18063','SOCIAL_CHAT_TABLE_PREFIX':'orgiq-bff-cluster-','SWEEP_INTERVAL_MIN':'0','RETENTION_SWEEP_DISABLED':'1','REALTIME_STATS_INTERVAL_MS':'0','GRANTS_REFRESH_S':'120'})
    env.pop('ORGIQ_NATIVE_STORE_METRICS_FILE',None)
    if os.environ.get('ORGIQ_BFF_CONTAINER_STORE_METRICS')=='1':
        env['ORGIQ_NATIVE_STORE_METRICS_FILE']='/tmp/orgiq-bff-cluster-'+label+'-native-metrics.json'
    env.pop('SOCIAL_DYNAMO_DISPATCH_QUEUE',None)
    if os.environ.get('ORGIQ_BFF_CONTAINER_DISPATCH_QUEUE')=='1':
        env['SOCIAL_DYNAMO_DISPATCH_QUEUE']='1'  # A/B only; default off
    envfile=pathlib.Path('/tmp/orgiq-bff-capacity-'+label+'.env')
    for key,value in env.items():
        if '\n' in str(value) or '\r' in str(value) or '=' in key: raise RuntimeError('Private profile has unsupported multiline values')
    envfile.write_text(''.join(key+'='+str(value)+'\n' for key,value in env.items())); envfile.chmod(0o600)
    container=subprocess.check_output(['docker','run','-d','--name',name,'--network',network,'--label','orgiq.validation=bff-capacity-container','--cpus','1','--memory','1024m','--pids-limit','256','--publish','127.0.0.1:'+str(port)+':3001','--env-file',str(envfile),'--mount','type=bind,src='+str(preload)+',dst=/app/test-support/native-rds-preload.mjs,readonly','--entrypoint','node',image,*command],text=True).strip()
    print('Started owned compiled BFF',label,'container',container,'port',port,'image',image_id,'budget 1 CPU / 1024 MiB')
