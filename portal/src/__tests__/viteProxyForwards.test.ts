// Run with:  cd portal && node --test 'src/__tests__/viteProxyForwards.test.ts'
// The dev server listens on every interface and proxies /api to the middleware
// from loopback. The middleware shows /health diagnostics to loopback callers
// only, and treats a relayed request as local only when every client address
// the relay recorded is loopback. So the proxy must record the client (xfwd);
// without it a request from anywhere on the network would read as local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('the /api dev proxy records the real client address', () => {
  const config = readFileSync(resolve(import.meta.dirname, '../../vite.config.ts'), 'utf8');
  const api = config.slice(config.indexOf("'/api': {"));
  assert.ok(api.length > 0, 'the /api proxy entry exists');
  assert.match(api.slice(0, api.indexOf('configure:')), /\bxfwd:\s*true\b/);
});
