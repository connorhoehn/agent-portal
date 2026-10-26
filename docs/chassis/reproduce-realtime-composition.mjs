// Read-only characterization of the installed realtime composition boundary.
// The fixtures own their HTTP servers and create no network listeners or data.
// Usage: node docs/chassis/reproduce-realtime-composition.mjs <installed-package-directory>
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(process.argv[2]);
const { attachRealtime, createRealtimeServer } = require(path.join(root, 'dist/server'));
const manifest = name => ({ name, version: '1.0.0', dependencies: [] });
(async () => {
  const checks = [];
  for (const [name, features] of [
    ['missing dependency', [{ manifest: { ...manifest('dependent'), dependencies: ['missing'] }, create: () => ({ handleAction() {} }) }]],
    ['duplicate manifest identity with distinct wire aliases', [
      { manifest: manifest('same'), serviceName: 'first', create: () => ({ handleAction() {} }) },
      { manifest: manifest('same'), serviceName: 'second', create: () => ({ handleAction() {} }) },
    ]],
  ]) {
    const server = http.createServer();
    let accepted = false;
    let handle;
    try { handle = attachRealtime(server, { features }); accepted = true; }
    catch { /* required configuration rejection */ }
    finally { await handle?.dispose(); }
    checks.push({ name, expected: 'reject before construction', observed: accepted ? 'accepted' : 'rejected', gap: accepted });
  }
  let stopped = false;
  let threw = false;
  const first = { handleAction() {}, shutdown() { stopped = true; } };
  try {
    attachRealtime(http.createServer(), { features: [
      { manifest: manifest('first'), create: () => first },
      { manifest: manifest('broken'), create: () => { throw new Error('fixture startup failure'); } },
    ] });
  } catch (error) { threw = true; await error.cleanup; }
  await new Promise(resolve => setImmediate(resolve));
  checks.push({ name: 'partial construction rollback', expected: 'first service stopped', observed: { threw, stopped }, gap: !stopped });
  first.shutdown(); // Explicit fixture cleanup after measuring the missing rollback.
  let legacyAccepted = false;
  let legacy;
  try { legacy = createRealtimeServer([manifest('unknown-fixture')], {}, { server: http.createServer() }); legacyAccepted = true; }
  catch { /* required configuration rejection */ }
  finally { await legacy?.dispose(); }
  checks.push({ name: 'unknown legacy feature', expected: 'reject', observed: legacyAccepted ? 'silently accepted' : 'rejected', gap: legacyAccepted });
  process.stdout.write(JSON.stringify({
    observedOn: '2026-10-26', packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    scope: 'C8 composition characterization; no shared application mutation', checks,
  }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
