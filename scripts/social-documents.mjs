#!/usr/bin/env node
// Assessment documents on the local `social` compose profile
// (docs/assessment-documents-parity-plan.md, Phase 0).
//
// The `dev:mock` middleware only opens the real canvas when it can mint a
// document grant and reach a gateway + platform-api that trust it. This
// script keeps one local Ed25519 pair in .scratch/social-documents/ (the
// private half goes to the middleware only, the public half to the two
// containers) and starts both sides with matching settings.
//
//   node scripts/social-documents.mjs up          # gateway :28080, platform-api :23001
//   node scripts/social-documents.mjs middleware  # dev:mock + document env (PORT, default 3001)
//   node scripts/social-documents.mjs env         # print the middleware exports
//   node scripts/social-documents.mjs status|down
//
// Ports default to 28080/23001 so the stack runs beside realtime-examples'
// Tilt (18080/13001). The gateway and platform-api call the middleware back
// on /internal/document-grants/session, so `up` bakes in the middleware's
// port: set ORGIQ_BFF_PORT when the middleware is not on 3001.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2] || 'help';
const state = resolve(root, '.scratch/social-documents');
mkdirSync(state, { recursive: true, mode: 0o700 });
const settingsFile = resolve(state, 'settings.json');
if (!existsSync(settingsFile)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(settingsFile, JSON.stringify({
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'assessment-social-v1', issuer: 'assessment-social', tenantId: 'assessment',
    policySecret: randomBytes(32).toString('hex'),
  }, null, 2), { mode: 0o600 });
}
const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
const gatewayPort = process.env.SOCIAL_GATEWAY_PORT || '28080';
const platformPort = process.env.SOCIAL_PLATFORM_API_PORT || '23001';
const bffPort = process.env.ORGIQ_BFF_PORT || process.env.PORT || '3001';

const composeEnv = { ...process.env,
  SOCIAL_GATEWAY_PORT: gatewayPort, SOCIAL_PLATFORM_API_PORT: platformPort,
  SOCIAL_DOCUMENT_TENANT_ID: saved.tenantId, SOCIAL_DOCUMENT_GRANT_ISSUER: saved.issuer,
  SOCIAL_DOCUMENT_GRANT_KEY_ID: saved.keyId, SOCIAL_DOCUMENT_GRANT_PUBLIC_KEY: saved.publicKey,
  SOCIAL_DOCUMENT_POLICY_SECRET: saved.policySecret,
  SOCIAL_DOCUMENT_SESSION_EPOCH_URL: `http://host.docker.internal:${bffPort}/internal/document-grants/session`,
  // platform-api reaches the SFU on the host by default: this profile runs no
  // `social-sfu` container (media through it is unproven), and the compose
  // default `http://social-sfu:3901` made every call 502 ("Lost the call").
  SOCIAL_VIDEO_API_URL: process.env.SOCIAL_VIDEO_API_URL || 'http://host.docker.internal:3901',
};
const middlewareEnv = {
  DOCUMENT_GRANT_ISSUER: saved.issuer, DOCUMENT_GRANT_KEY_ID: saved.keyId,
  DOCUMENT_GRANT_PRIVATE_KEY: saved.privateKey, DOCUMENT_POLICY_SECRET: saved.policySecret,
  DOCUMENT_GATEWAY_PUBLIC_URL: `ws://127.0.0.1:${gatewayPort}`,
  DOCUMENT_GATEWAY_INTERNAL_URL: `ws://127.0.0.1:${gatewayPort}`,
  DOCUMENT_PLATFORM_INTERNAL_URL: `http://127.0.0.1:${platformPort}`,
  // The endpoints the realtime token response carries for the browser: the
  // BFF is its own gateway, platform-api is the compose port, video is the
  // SFU (the host one by default — the compose profile runs none). The
  // portal then needs no VITE_* URLs (deploy plan §5); the env still wins.
  REALTIME_GATEWAY_URL: process.env.REALTIME_GATEWAY_URL || `http://localhost:${bffPort}`,
  REALTIME_PLATFORM_PUBLIC_URL: process.env.REALTIME_PLATFORM_PUBLIC_URL || `http://localhost:${platformPort}`,
  REALTIME_VIDEO_PUBLIC_URL: process.env.REALTIME_VIDEO_PUBLIC_URL || process.env.SOCIAL_VIDEO_PUBLIC_URL || 'http://localhost:3901',
};
const services = ['social-redis', 'social-dynamodb', 'social-gateway-image', 'social-dynamodb-init',
  'social-gateway', 'social-platform-api'];
const compose = ['compose', '--profile', 'social'];
function run(command, args, cwd = root, env = composeEnv) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const extra = process.argv.slice(3);
if (action === 'up') {
  run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '240', ...extra, ...services]);
} else if (action === 'down') {
  run('docker', [...compose, 'rm', '-sf', ...services.filter(s => s !== 'social-gateway-image')]);
} else if (action === 'status') {
  run('docker', [...compose, 'ps', ...services]);
} else if (action === 'middleware') {
  run('npm', ['run', 'dev:mock'], resolve(root, 'middleware'), { ...process.env, ...middlewareEnv, PORT: bffPort });
} else if (action === 'env') {
  for (const [name, value] of Object.entries(middlewareEnv)) console.log(`export ${name}=${JSON.stringify(value)}`);
} else {
  console.log('Usage: node scripts/social-documents.mjs up [--build]|middleware|env|status|down');
  console.log(`Gateway :${gatewayPort}, platform-api :${platformPort}, middleware callback :${bffPort}.`);
  console.log('Keys: .scratch/social-documents/settings.json (gitignored). Guide: docs/social-calls-local-stack.md.');
}
