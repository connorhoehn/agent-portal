# Owned full-process acceptance launcher. Never prints the private profile.
import json, os, pathlib, signal, subprocess, time, sys
root=pathlib.Path(__file__).resolve().parents[1]
envfile=os.environ.get('ORGIQ_BFF_RUNTIME_ENV_FILE')
if not envfile: raise RuntimeError('Set ORGIQ_BFF_RUNTIME_ENV_FILE to the private owned runtime profile')
base=json.loads(pathlib.Path(envfile).read_text())
if any(label not in ['a','b'] for label in sys.argv[1:]): raise RuntimeError('Choose acceptance node a or b')
for label,port in [('a',3063),('b',3064)]:
    if len(sys.argv)>1 and label not in sys.argv[1:]: continue
    pidfile=pathlib.Path('/tmp/orgiq-bff-cluster-'+label+'.pid')
    if pidfile.exists():
        pid=int(pidfile.read_text())
        args=subprocess.run(['ps','-p',str(pid),'-o','args='],capture_output=True,text=True).stdout.strip()
        if args:
            cwd=subprocess.run(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],capture_output=True,text=True).stdout
            listener=subprocess.run(['lsof','-nP','-iTCP:'+str(port),'-sTCP:LISTEN','-Fp'],capture_output=True,text=True).stdout
            if args!='node --import ./test-support/native-rds-preload.mjs --import tsx src/index.ts' or 'n'+str(root) not in cwd or 'p'+str(pid) not in listener:
                raise RuntimeError('Owned BFF identity/port check failed: '+label)
            os.kill(pid,signal.SIGTERM)
            for n in range(120):
                if not subprocess.run(['ps','-p',str(pid),'-o','args='],capture_output=True,text=True).stdout.strip(): break
                time.sleep(.1)
            else: raise RuntimeError('Owned BFF did not terminate: '+label)
    existing=subprocess.run(['lsof','-nP','-iTCP:'+str(port),'-sTCP:LISTEN','-Fp'],capture_output=True,text=True).stdout
    if existing.strip(): raise RuntimeError('Acceptance port is occupied: '+str(port))
    env=os.environ.copy(); env.update(base)
    env.update({'PORT':str(port),'DEV_OFFLINE':'true','MOCK_AURORA':'false','MOCK_AGENTCORE':'true','MOCK_GUARDRAILS':'true','MOCK_CLOUDWATCH':'true','MOCK_QUEUE':'true','AUTH_DEMO_MODE':'true','NODE_ENV':'development','INSECURE_DEV_MODE':'true','AWS_ACCESS_KEY_ID':'native-acceptance','AWS_SECRET_ACCESS_KEY':'native-acceptance','AWS_REGION':'us-east-1','AWS_DEFAULT_REGION':'us-east-1','AURORA_CLUSTER_ARN':'arn:aws:rds:us-east-1:000000000000:cluster:native-acceptance','AURORA_SECRET_ARN':'arn:aws:secretsmanager:us-east-1:000000000000:secret:native-acceptance','AURORA_DB_NAME':'orgiq','ORGIQ_NATIVE_RDS_URL':'postgresql://orgiq:local-cluster-fixture@127.0.0.1:15483/orgiq','REALTIME_GATEWAY':'on','REALTIME_GATEWAY_ROUTER':'redis','REALTIME_GATEWAY_NAMESPACE':'orgiq-bff-cluster-acceptance','REALTIME_GATEWAY_NODE_ID':'bff-'+label,'REDIS_URL':'redis://127.0.0.1:16483','SOCIAL_CHAT_STORE':'dynamo','SOCIAL_CHAT_DYNAMODB_ENDPOINT':'http://127.0.0.1:18063','SOCIAL_CHAT_TABLE_PREFIX':'orgiq-bff-cluster-','SWEEP_INTERVAL_MIN':'0','RETENTION_SWEEP_DISABLED':'1','REALTIME_STATS_INTERVAL_MS':'0','GRANTS_REFRESH_S':'120'})
    log=open('/tmp/orgiq-bff-cluster-'+label+'-current.log','w')
    if os.environ.get('ORGIQ_BFF_NATIVE_STORE_METRICS')=='1':
        env['ORGIQ_NATIVE_STORE_METRICS_FILE']='/tmp/orgiq-bff-cluster-'+label+'-native-metrics.json'
    child=subprocess.Popen(['node','--import','./test-support/native-rds-preload.mjs','--import','tsx','src/index.ts'],cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    pidfile.write_text(str(child.pid))
    print('Started owned BFF',label,'PID',child.pid,'port',port)
