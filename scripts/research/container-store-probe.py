#!/usr/bin/env python3
"""Observe a disposable MNS image's startup, health check, and restart behavior.

No host ports, volumes, credentials, or external network are attached. The
container is removed in finally. A successful probe means the observation ran;
it does not mean the observed storage is durable.
"""
import argparse
import json
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('image', help='Locally built managed-nosql-store image')
parser.add_argument('--raft', action='store_true', help='Exercise the existing single-voter Raft mode')
args = parser.parse_args()
image_id = subprocess.check_output(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', args.image], text=True
).strip()
container = subprocess.check_output(
    ['docker', 'run', '-d', '--network', 'none',
     *(['-e', 'NODE_ID=probe', '-e', 'CLUSTER_NODES=', '-e', 'ANNOUNCE_ADDRESS=127.0.0.1'] if args.raft else []), args.image], text=True
).strip()


def request(action, body):
    script = (
        'const r=await fetch("http://127.0.0.1:8000",{method:"POST",'
        'headers:{"content-type":"application/x-amz-json-1.0",'
        f'"x-amz-target":"DynamoDB_20120810.{action}"}},'
        f'body:JSON.stringify({json.dumps(body)}),signal:AbortSignal.timeout(2000)}});'
        'console.log(JSON.stringify({status:r.status,body:await r.json()}));'
    )
    return json.loads(subprocess.check_output(
        ['docker', 'exec', container, 'node', '--input-type=module', '-e', script],
        text=True, stderr=subprocess.DEVNULL,
    ))


def ready():
    for _ in range(30):
        try:
            if request('ListTables', {})['status'] == 200:
                if args.raft:
                    role = subprocess.check_output(['docker', 'exec', container, 'node', '-e', "fetch('http://127.0.0.1:8000/cluster/status').then(r=>r.json()).then(s=>console.log(s.role))"], text=True).strip()
                    if role != 'leader':
                        time.sleep(0.3)
                        continue
                return
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
        time.sleep(0.3)
    raise RuntimeError('Disposable container did not become ready')


try:
    ready()
    check = json.loads(subprocess.check_output(
        ['docker', 'inspect', '--format', '{{json .Config.Healthcheck.Test}}', container],
        text=True,
    ))
    command = ['sh', '-c', check[1]] if check[0] == 'CMD-SHELL' else check[1:]
    health = subprocess.run(['docker', 'exec', container, *command], check=False).returncode
    table = 'codex-isolated-restart-probe'
    created = request('CreateTable', {
        'TableName': table,
        'AttributeDefinitions': [{'AttributeName': 'id', 'AttributeType': 'S'}],
        'KeySchema': [{'AttributeName': 'id', 'KeyType': 'HASH'}],
        'BillingMode': 'PAY_PER_REQUEST',
    })
    assert created['status'] == 200, created
    key = {'id': {'S': 'probe'}}
    written = request('PutItem', {'TableName': table, 'Item': {**key, 'value': {'S': 'throwaway'}}})
    assert written['status'] == 200, written
    before = request('GetItem', {'TableName': table, 'Key': key})
    subprocess.run(['docker', 'restart', container], check=True, stdout=subprocess.DEVNULL)
    ready()
    after = request('GetItem', {'TableName': table, 'Key': key})
    print(json.dumps({
        'image': args.image, 'imageId': image_id, 'raft': args.raft,
        'isolation': 'network none; no volumes or published ports',
        'imageHealthcheckExitCode': health,
        'beforeRestart': before, 'afterRestart': after,
        'itemSurvivedRestart': before == after and 'Item' in before['body'],
    }, indent=2))
finally:
    subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)
