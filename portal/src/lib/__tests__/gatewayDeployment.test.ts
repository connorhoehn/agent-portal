import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the portal deployment supplies a gateway HTTP base URL, not an already suffixed WebSocket URL', () => {
  const yaml = readFileSync(new URL('../../../../k8s/crds/portal-workload.yaml', import.meta.url), 'utf8');
  const match = yaml.match(/name: VITE_GATEWAY_URL\s+value: '([^']+)'/);
  assert.ok(match, 'gateway env value must remain explicit');
  const base = new URL(match[1]);
  assert.ok(['http:', 'https:'].includes(base.protocol), 'HTTP probes and WS derivation share the same base');
  assert.equal(base.pathname, '/', 'App adds /ws itself');
  assert.equal(base.search, '');
  assert.equal(base.hash, '');
});
