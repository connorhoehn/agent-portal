const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const REPO = path.resolve(__dirname, '../..');

function scan(t, { nav = '/iq/computers', roles, dynamic = false, mount = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-server-tier-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts/lib', 'middleware/src', 'middleware/seeds/roles/orgiq', 'portal/src/components/shell']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'middleware/node_modules'), path.join(root, 'middleware/node_modules'));
  fs.copyFileSync(path.join(REPO, 'scripts/lib/nav-server-tier.cjs'), path.join(root, 'scripts/lib/nav-server-tier.cjs'));
  fs.writeFileSync(path.join(root, 'middleware/src/index.ts'), mount
    ? `app.use('/api/devbox', readForRolesElseAction(['org-leader', 'program-owner'], ${dynamic ? 'devboxWriteAction' : "'ManageDevbox'"}), devboxRouter);` : '');
  fs.writeFileSync(path.join(root, 'middleware/seeds/roles/orgiq/hr-admin.cedar'), 'permit(principal, action == Action::"ManageDevbox", resource);');
  fs.writeFileSync(path.join(root, 'middleware/seeds/roles/orgiq/sme.cedar'), 'permit(principal, action == Action::"ManageDevbox", resource);');
  fs.writeFileSync(path.join(root, 'portal/src/components/shell/portalCommands.ts'),
    `const PAGES = [{ path: ${JSON.stringify(nav)}, label: 'Computers'${roles ? `, roles: ${JSON.stringify(roles)}` : ''} }];`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/lib/nav-server-tier.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('unrestricted Computers cannot hide a server reader, including with per-route write actions', t => {
  assert.deepEqual(scan(t, { dynamic: true }), []);
});
test('retired or absent palette entries do not create unresolved read-tier findings', t => {
  assert.deepEqual(scan(t, { nav: '/unrelated', mount: false }), []);
});
test('restricting Computers without a statically known read action remains a visible failure', t => {
  const findings = scan(t, { roles: ['hr-admin'], dynamic: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'nav-server-tier-unresolved');
  assert.equal(findings[0].nav, '/iq/computers');
});
for (const nav of ['/iq/computers', '/admin/devbox']) test(`${nav}: real narrowing is reported from declared readers and Cedar holders`, t => {
  const findings = scan(t, { nav, roles: ['hr-admin'] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'nav-narrower-than-server');
  assert.equal(findings[0].missing, 'org-leader,program-owner,sme');
});
test('a restricted mapped page with no readable gate is not silently accepted', t => {
  const findings = scan(t, { roles: ['hr-admin'], mount: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'nav-server-tier-unresolved');
});
