// Provision and drive only the dedicated native two-BFF fixture. This proves
// local signalling/authority behaviour; it does not measure Aurora or media.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const execute = promisify(execFile);
if (process.env.ORGIQ_BFF_CAPACITY_ACCEPTANCE !== '1') throw new Error('Opt in to the dedicated local capacity fixture');
if (!process.env.ORGIQ_BFF_RUNTIME_ENV_FILE) throw new Error('Set the private owned runtime profile');
const profiles = {
  pilot: ['--sockets', '60', '--calls', '10', '--group-size', '2,4', '--hold-seconds', '10', '--spread-seconds', '2'],
  burst: ['--sockets', '1000', '--calls', '100', '--group-size', '2', '--hold-seconds', '10', '--spread-seconds', '2', '--chat-startup', 'burst'],
  steady: ['--sockets', '1000', '--calls', '100', '--group-size', '2,4', '--hold-seconds', '60', '--spread-seconds', '20'],
  'ring-storm': ['--sockets', '1000', '--calls', '100', '--group-size', '2,4', '--hold-seconds', '60', '--scenario', 'ring-storm'],
  'double-accept': ['--sockets', '1000', '--calls', '100', '--group-size', '2', '--hold-seconds', '30', '--spread-seconds', '10', '--scenario', 'double-accept'],
  churn: ['--sockets', '1000', '--calls', '100', '--group-size', '2,4', '--hold-seconds', '60', '--spread-seconds', '20', '--scenario', 'churn'],
  soak: ['--sockets', '1000', '--calls', '100', '--group-size', '2', '--spread-seconds', '20', '--scenario', 'soak', '--soak-seconds', '300'],
};
const profile = process.argv[2] ?? 'pilot';
const containers = process.env.ORGIQ_BFF_CONTAINER_CAPACITY_ACCEPTANCE === '1';
if (!profiles[profile] || process.argv.length > 3) throw new Error('Choose one declared local capacity profile');
for (const [name, internal, external] of [
  ['orgiq-bff-cluster-postgres', '5432/tcp', '15483'],
  ['orgiq-bff-cluster-redis', '6379/tcp', '16483'],
  ['orgiq-bff-cluster-dynamodb', '8000/tcp', '18063'],
]) {
  const rows = JSON.parse((await execute('docker', ['inspect', name])).stdout);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.Name, '/' + name); assert.equal(row.State.Running, true); assert.equal(row.State.Paused, false);
  assert.equal(row.Config.Labels['orgiq.validation'], 'bff-cluster');
  assert.deepEqual(row.HostConfig.PortBindings[internal], [{ HostIp: '127.0.0.1', HostPort: external }]);
}
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
for (const [label, port] of containers ? [['a', 3065], ['b', 3066]] : [['a', 3063], ['b', 3064]]) {
  const deadline = Date.now() + 10000;
  let response;
  while (Date.now() < deadline) {
    try {
      response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(response?.status, 200, 'owned BFF becomes healthy before load');
  if (containers) {
    const name = 'orgiq-bff-capacity-' + label;
    const rows = JSON.parse((await execute('docker', ['inspect', name])).stdout), node = rows[0];
    assert.equal(rows.length, 1); assert.equal(node.Name, '/' + name);
    assert.equal(node.Config.Labels['orgiq.validation'], 'bff-capacity-container');
    assert.equal(node.State.Running, true); assert.equal(node.State.Paused, false);
    assert.equal(node.HostConfig.NanoCpus, Number(process.env.ORGIQ_BFF_CONTAINER_CPUS || 1) * 1e9); assert.equal(node.HostConfig.Memory, Number(process.env.ORGIQ_BFF_CONTAINER_MEMORY_MIB || 1024) * 1024 * 1024);
    assert.deepEqual(node.HostConfig.PortBindings['3001/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(port) }]);
    const image = JSON.parse((await execute('docker', ['image', 'inspect', process.env.ORGIQ_BFF_CONTAINER_IMAGE || 'orgiq-middleware:cluster-capacity-validation'])).stdout)[0];
    assert.equal(node.Image, image.Id);
  } else {
    const pid = (await readFile('/tmp/orgiq-bff-cluster-' + label + '.pid', 'utf8')).trim();
    assert.match(pid, /^\d+$/);
    assert.equal((await execute('ps', ['-p', pid, '-o', 'args='])).stdout.trim(), 'node --import ./test-support/native-rds-preload.mjs --import tsx src/index.ts');
    assert.ok((await execute('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])).stdout.split('\n').includes('n' + root));
    assert.ok((await execute('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'])).stdout.split('\n').includes('p' + pid));
  }
  const health = await response.json();
  assert.equal(health.realtime.ready, true); assert.equal(health.realtime.store, 'redis');
  assert.equal(health.mocks.aurora, false);
}
const db = new pg.Pool({ connectionString: 'postgresql://orgiq:local-cluster-fixture@127.0.0.1:15483/orgiq', max: 1 });
const manifest = containers ? '/tmp/orgiq-bff-container-capacity-identities.json' : '/tmp/orgiq-bff-cluster-capacity-identities.json';
try {
  const ids = Array.from({ length: 1000 }, (_, index) => (containers ? 'u-container-load-' : 'u-cluster-load-') + String(index + 1).padStart(4, '0'));
  await db.query('BEGIN');
  await db.query('INSERT INTO app_users (id, display_name) SELECT id, id FROM unnest($1::text[]) AS id ON CONFLICT (id) DO NOTHING', [ids]);
  await db.query("INSERT INTO user_tenant_roles (user_id, tenant_id, role) SELECT id, 'social', 'participant' FROM unnest($1::text[]) AS id ON CONFLICT DO NOTHING", [ids]);
  await db.query("INSERT INTO user_tenant_roles (user_id, tenant_id, role) SELECT id, 'orgiq', 'member' FROM unnest($1::text[]) AS id ON CONFLICT DO NOTHING", [ids]);
  await db.query('COMMIT');
  const users = (await db.query('SELECT id, display_name, session_epoch FROM app_users WHERE id = ANY($1::text[]) ORDER BY id', [ids])).rows;
  const grants = (await db.query('SELECT user_id, tenant_id, role FROM user_tenant_roles WHERE user_id = ANY($1::text[]) ORDER BY user_id, tenant_id, role', [ids])).rows;
  assert.equal(users.length, 1000);
  await writeFile(manifest, JSON.stringify(users.map(user => {
    const current = grants.filter(grant => grant.user_id === user.id);
    assert.ok(current.some(grant => grant.tenant_id === 'social' && grant.role === 'participant'));
    return { userId: user.id, displayName: user.display_name, epoch: Number(user.session_epoch), role: 'participant', tenants: [...new Set(current.map(grant => grant.tenant_id))] };
  })), { mode: 0o600 });
} finally { await db.end(); }
if (process.env.ORGIQ_BFF_CAPACITY_PREPARE_ONLY === '1') {
  console.log('Prepared native SQL directory and identity manifest; no load started');
  process.exit(0);
}
const privateProfile = JSON.parse(await readFile(process.env.ORGIQ_BFF_RUNTIME_ENV_FILE, 'utf8'));
if (privateProfile.NODE_ENV === 'production') throw new Error('The capacity profile is restricted to local development');
const driver = fileURLToPath(new URL('../../scripts/loadtest/realtime-calls.mjs', import.meta.url));
const result = '/tmp/orgiq-bff-' + (containers ? 'container' : 'cluster') + '-capacity-' + profile + '.json';
console.log('Native SQL directory provisioned: 1000 current users; local two-owner profile:', profile);
const sampling = containers ? ['--sample-container', 'orgiq-bff-capacity-a', '--peer-container', 'orgiq-bff-capacity-b'] : [];
const child = spawn(process.execPath, [driver, '--url', 'ws://127.0.0.1:' + (containers ? 3065 : 3063) + '/ws', '--peer-url', 'ws://127.0.0.1:' + (containers ? 3066 : 3064) + '/ws', '--identity-manifest', manifest, '--json', result, ...sampling, ...profiles[profile]], {
  // An unset owned key selects the same built-in local development key that
  // the BFF and existing driver use; never inherit another shell's key.
  env: { ...process.env, REALTIME_JWT_SECRET: (privateProfile.REALTIME_JWT_SECRET ?? '').trim() }, stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 2; });
child.on('exit', code => { process.exitCode = code ?? 2; });
