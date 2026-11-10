// Run with:  cd portal && node --test 'src/lib/__tests__/gatewayNoSigningSecret.test.ts'
//
// The realtime-modules proxy client signs requests (X-Service-Auth) whenever it
// is given a signing secret, and loads Node-only code to do it. A browser has
// no business holding that secret: it would be readable by anyone who opens
// the bundle, and the signing path cannot run there. The library does not
// refuse it today, so the portal pins its own side: no source file hands the
// client a secret, a client id or a bearer token, and the one client the
// portal builds sends no signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGatewayClient } from '../gatewayEndpoint.ts';

const SRC = resolve(import.meta.dirname, '../..');
const SIGNING_KEYS = /\b(serviceAuthSecret|serviceAuthClientId|SERVICE_AUTH_SECRET|authToken)\b/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') sources(p, out); }
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test('no portal source hands the proxy client a signing secret, client id or bearer token', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('realtime-modules/proxy-client') && !text.includes('GatewayProxyClient')) continue;
    text.split('\n').forEach((line, i) => { if (SIGNING_KEYS.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});

test('every client construction passes only the URL and a bound fetch', () => {
  const constructions: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/new\s+GatewayProxyClient\s*\(([^)]*)\)/g)) constructions.push(m[1]!.replace(/\s+/g, ' ').trim());
  }
  assert.ok(constructions.length >= 1, 'the portal builds its client somewhere');
  for (const args of constructions) {
    const keys = [...args.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual(keys.filter((k) => k !== 'gatewayUrl' && k !== 'fetch'), [], args);
  }
});

test('the client the portal builds sends no service signature or bearer token', async () => {
  const prior = globalThis.fetch;
  const seen: Array<Record<string, string>> = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(JSON.stringify({ status: 'healthy' }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await createGatewayClient('https://gateway.example.com')!.getHealth();
  } finally { globalThis.fetch = prior; }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!['x-service-auth'], undefined);
  assert.equal(seen[0]!['authorization'], undefined);
});
