#!/usr/bin/env node
// Isolated local document services, reusing the owning project's Compose stack.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildDocumentWorkspace, defaultImages, prepareDocumentCompose } from './docker/document-workspace-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2] || 'help';
const state = resolve(root, '.scratch/document-workspace');
mkdirSync(state, { recursive: true, mode: 0o700 });
const settingsFile = resolve(state, 'settings.json');
if (!existsSync(settingsFile)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secret = () => randomBytes(32).toString('hex');
  writeFileSync(settingsFile, JSON.stringify({
    DOCUMENT_GRANT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    DOCUMENT_GRANT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    DOCUMENT_GRANT_KEY_ID: 'assessment-local-v1', DOCUMENT_GRANT_ISSUER: 'assessment-local',
    DOCUMENT_TENANT_ID: 'assessment', DOCUMENT_POLICY_SECRET: secret(),
    MQ_SERVICE_AUTH_SECRET: secret(), EVENT_CATALOG_AUTH_TOKEN: secret(),
    GATEWAY_SERVICE_AUTH_SECRET: secret(), LVS_WEBHOOK_SECRET: secret(), VIDEO_ADMIN_TOKEN: secret(),
  }, null, 2), { mode: 0o600 });
}
const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
const env = { ...process.env, ...saved,
  ...Object.fromEntries(Object.entries(defaultImages()).map(([name, value]) => [name, process.env[name] || value])),
  COGNITO_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'us-east-1_localdev000',
  DOCUMENT_SESSION_EPOCH_URL: 'http://host.docker.internal:3001/internal/document-grants/session',
  DOCUMENT_GATEWAY_INTERNAL_URL: 'ws://127.0.0.1:18081',
  DOCUMENT_GATEWAY_PUBLIC_URL: 'ws://127.0.0.1:18081',
  DOCUMENT_PLATFORM_INTERNAL_URL: 'http://127.0.0.1:13002',
};
const overlay = resolve(state, 'host-access.json');
writeFileSync(overlay, JSON.stringify({ services: {
  gateway: { ports: ['127.0.0.1:18081:8080'], extra_hosts: ['host.docker.internal:host-gateway'],
    environment: { PUBLIC_URL: 'http://127.0.0.1:18081' } },
  'platform-api': { ports: ['127.0.0.1:13002:3001'], extra_hosts: ['host.docker.internal:host-gateway'] },
}, networks: { default: { internal: false } } }, null, 2));
const needsCompose = ['up', 'foundation', 'down', 'status', 'check'].includes(action);
const composeSource = needsCompose ? prepareDocumentCompose(state) : state;
const compose = ['compose', '-p', 'assessment-document-workspace',
  '-f', resolve(composeSource, 'compose.yml'),
  '-f', resolve(composeSource, 'compose.document-grants.yml'),
  '-f', overlay, '--profile', 'application'];
function run(command, args, cwd = root, environment = env) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (action === 'build' || action === 'build-plan') {
  buildDocumentWorkspace({ state, images: env, planOnly: action === 'build-plan' });
} else if (action === 'up') {
  run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180']);
} else if (action === 'foundation') {
  run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'dynamodb', 'redis', 'message-queue', 'event-catalog']);
} else if (action === 'down') {
  run('docker', [...compose, 'down']); // retain source-owned persistent volumes
} else if (action === 'status') {
  run('docker', [...compose, 'ps']);
} else if (action === 'check') {
  run('docker', [...compose, 'config', '--quiet']);
} else if (action === 'middleware') {
  run('npm', ['run', 'dev:mock'], resolve(root, 'middleware'), { ...env, PORT: '3001' });
} else {
  console.log('Usage: node scripts/document-workspace.mjs build|build-plan|foundation|up|middleware|status|check|down');
  console.log('Build archives pinned owning repositories for all five services and the catalog UI dependency; no sibling dirty files are copied.');
  console.log('Uses gateway :18081 and API :13002. Run the portal normally on :5183.');
  console.log('Private local keys remain in .scratch/document-workspace/settings.json. Down retains data.');
}
