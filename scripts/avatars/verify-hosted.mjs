#!/usr/bin/env node
// Read-only asset verification. Pass PortalUrl from the deployed CloudFormation
// outputs; a local URL verifies local serving only, never cloud deployment.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = new URL(process.argv[2] ?? (() => { throw new Error('Usage: node scripts/avatars/verify-hosted.mjs <PortalUrl>'); })());
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('Use HTTPS for deployed assets');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Pass only the portal origin');
const manifest = JSON.parse(readFileSync(resolve(root, 'portal/public/avatars/photos/personas.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (let i = 0; i < manifest.personas.length; i += 4) {
  results.push(...await Promise.all(manifest.personas.slice(i, i + 4).map(async row => {
    if (!/^[a-z0-9-]+$/.test(row.subjectId) || row.portraitUrl !== `/avatars/photos/${row.subjectId}.jpg`) throw new Error('Unexpected manifest path');
    const expected = sha(readFileSync(resolve(root, 'portal/public' + row.portraitUrl)));
    try {
      const response = await fetch(new URL(row.portraitUrl, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const actual = sha(Buffer.from(await response.arrayBuffer()));
      return { id: row.subjectId, status: response.status, expected, actual, ok: response.ok && response.headers.get('content-type')?.split(';')[0] === 'image/jpeg' && expected === actual };
    } catch (error) { return { id: row.subjectId, expected, ok: false, error: error.message, cause: error.cause?.code }; }
  })));
}
console.log(JSON.stringify({ origin: origin.origin, checkedAt: new Date().toISOString(), passed: results.filter(r => r.ok).length, total: results.length, results }, null, 2));
if (results.some(r => !r.ok)) process.exitCode = 1;
