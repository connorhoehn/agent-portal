#!/usr/bin/env python3
"""Write the DEPLOYED middleware task's environment to a shell file, so this tree
runs locally exactly as configured in AWS (Aurora, AVP, DynamoDB, secrets).

    python3 task-env.py --out .scratch/mw-cloud.env [--port 3031] [--redis redis://127.0.0.1:26400]
    (cd middleware && source ../.scratch/mw-cloud.env && npx tsx src/index.ts)

Secrets and SSM parameters the task reads are resolved into the file, which is
written mode 600 and never printed; keep it under .scratch/ (gitignored) and
delete it afterwards. ElastiCache is VPC-only, so REDIS_URL points at a local
container (docker run -d --rm --name claude-mw-redis -p 127.0.0.1:26400:6379 redis:7-alpine).
WARNING: the server's boot runs the Cedar seeder against the deployed policy
store and its recovery sweeps against the deployed Aurora, as a task start does.
"""
import argparse, json, os, shlex, subprocess

LAB = '647757222309'
def aws(*args):
    return subprocess.check_output(['aws', *args], text=True).strip()

p = argparse.ArgumentParser()
p.add_argument('--out', required=True); p.add_argument('--port', default='3031')
p.add_argument('--redis', default='redis://127.0.0.1:26400')
p.add_argument('--cluster', default='orgiq-middleware'); p.add_argument('--service', default='orgiq-middleware')
a = p.parse_args()
if aws('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text') != LAB:
    raise SystemExit(f'credentials are not for {LAB}; run aws-azure-login')
td = aws('ecs', 'describe-services', '--cluster', a.cluster, '--services', a.service, '--query', 'services[0].taskDefinition', '--output', 'text')
c = json.loads(aws('ecs', 'describe-task-definition', '--task-definition', td, '--query', 'taskDefinition.containerDefinitions[0]', '--output', 'json'))
env = {e['name']: e['value'] for e in c['environment']}
for s in c.get('secrets', []):
    vf = s['valueFrom']
    if ':parameter/' in vf:
        env[s['name']] = aws('ssm', 'get-parameter', '--name', '/' + vf.split(':parameter/')[1], '--with-decryption', '--query', 'Parameter.Value', '--output', 'text')
        continue
    parts = vf.split(':')
    arn, key = (':'.join(parts[:7]), parts[7]) if len(parts) > 7 and parts[7] else (vf, None)
    value = aws('secretsmanager', 'get-secret-value', '--secret-id', arn, '--query', 'SecretString', '--output', 'text')
    env[s['name']] = json.loads(value)[key] if key else value
env.update(PORT=a.port, REDIS_URL=a.redis)
fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    for k, v in env.items(): f.write(f'export {k}={shlex.quote(v)}\n')
print(f'wrote {len(env)} variables from {td.rsplit("/", 1)[-1]} to {a.out} (mode 600)')
