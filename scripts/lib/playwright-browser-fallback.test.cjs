// node --test scripts/lib/playwright-browser-fallback.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { installedRevision, planFallback } = require('./playwright-browser-fallback.cjs');

function cacheWith(dirs) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cache-'));
  for (const [name, complete] of dirs) {
    fs.mkdirSync(path.join(cache, name));
    if (complete) fs.writeFileSync(path.join(cache, name, 'INSTALLATION_COMPLETE'), '');
  }
  return cache;
}

test('a missing Chromium build falls back to the newest finished install of the same browser', () => {
  const cache = cacheWith([['chromium_headless_shell-1234', true], ['chromium_headless_shell-1248', true], ['chromium_headless_shell-1300', false], ['chromium-1248', true]]);
  assert.equal(installedRevision(cache, 'chromium-headless-shell'), '1248');
  const plan = planFallback([
    { name: 'chromium', revision: '1223' }, { name: 'chromium-headless-shell', revision: '1223' }, { name: 'firefox', revision: '1500' },
  ], cache);
  assert.deepEqual(plan, { substitutions: [
    { name: 'chromium', wanted: '1223', installed: '1248' },
    { name: 'chromium-headless-shell', wanted: '1223', installed: '1248' },
  ], missing: [] });
});

test('an installed expected build changes nothing; no build at all is reported missing', () => {
  const cache = cacheWith([['chromium-1223', true], ['chromium_headless_shell-1223', true]]);
  assert.deepEqual(planFallback([{ name: 'chromium', revision: '1223' }, { name: 'chromium-headless-shell', revision: '1223' }], cache), { substitutions: [], missing: [] });
  const empty = cacheWith([]);
  assert.deepEqual(planFallback([{ name: 'chromium-headless-shell', revision: '1223' }], empty), { substitutions: [], missing: ['chromium-headless-shell'] });
});
