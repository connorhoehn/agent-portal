import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appURL, CdpAudit } from './client.mjs';

test('app navigation stays within the named local origin', () => {
  assert.equal(appURL('http://localhost:5183', '/workspaces'), 'http://localhost:5183/workspaces');
  for (const path of ['https://example.com/', '//example.com/', 'javascript:alert(1)']) assert.throws(() => appURL('http://localhost:5183', path));
  assert.throws(() => appURL('https://example.com', '/'));
});

test('actors get separate owned contexts, without choosing the user default context', async () => {
  const events = [];
  const browser = {
    contexts() { throw new Error('User contexts must not be enumerated'); },
    async newContext() {
      const id = events.filter(e => e.startsWith('new:')).length;
      events.push(`new:${id}`);
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async newPage() { return { on() {} }; }, async close() { events.push(`close:${id}`); } };
    },
    async close() { events.push('disconnect'); },
  };
  const chromium = { async connectOverCDP(endpoint, opts) { assert.equal(opts.noDefaults, true); assert.equal(opts.timeout, 500); return browser; } };
  const audit = await CdpAudit.connect({ endpoint: 'http://127.0.0.1:19361', baseURL: 'http://localhost:5183', timeoutMs: 500, chromium });
  const vera = await audit.actor('vera');
  const nora = await audit.actor('nora');
  assert.notEqual(vera.context, nora.context);
  assert.equal(await audit.actor('vera'), vera);
  await audit.close(); await audit.close();
  assert.deepEqual(events, ['new:0', 'new:1', 'close:0', 'close:1', 'disconnect']);
  await assert.rejects(() => audit.actor('late'), /closed/);
});

test('transport denials are surfaced once, with their cause retained', async () => {
  let attempts = 0;
  const denied = new Error('connect EPERM');
  const chromium = { async connectOverCDP() { attempts++; throw denied; } };
  await assert.rejects(() => CdpAudit.connect({ endpoint: 'http://127.0.0.1:19361', baseURL: 'http://localhost:5183', chromium }), error => error.cause === denied && /transport unavailable/.test(error.message));
  assert.equal(attempts, 1);
});
