const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { readRouteSources, REPO_ROOT } = require('../../portal/e2e/route-sources.ts');

const wrapper = `function Gate({ roles, children }) {
  return <RequireRole roles={roles} fallback={<NoAccess roles={roles} />}>{children}</RequireRole>;
}`;

function fixture(t, app, pages = [{ path: '/runs', label: 'Runs', roles: ['editor'] }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-parity-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shell = path.join(root, 'portal/src/components/shell');
  fs.mkdirSync(shell, { recursive: true });
  fs.mkdirSync(path.join(root, 'portal/e2e'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'portal/package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(REPO_ROOT, 'portal/node_modules'), path.join(root, 'portal/node_modules'));
  fs.writeFileSync(path.join(root, 'portal/src/App.tsx'), app);
  fs.writeFileSync(path.join(shell, 'Layout.tsx'), 'const RAIL = [];');
  const catalogue = pages.map(p => `{ path: ${JSON.stringify(p.path)}, label: ${JSON.stringify(p.label)}, tenant: 'orgiq'${p.roles ? `, roles: ${JSON.stringify(p.roles)}` : ''} }`);
  fs.writeFileSync(path.join(shell, 'portalCommands.ts'), `const PAGES = [${catalogue.join(',')}];`);
  fs.copyFileSync(path.join(REPO_ROOT, 'portal/e2e/route-sources.ts'), path.join(root, 'portal/e2e/route-sources.ts'));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/lib/nav-route-parity.cjs'), path.join(root, 'scripts/lib/nav-route-parity.cjs'));
  return root;
}

function scan(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/lib/nav-route-parity.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('role-forwarding wrappers retain inherited and direct route gates', t => {
  const root = fixture(t, `${wrapper}
    const app = <Routes><Route path="work" element={<Gate roles={['reader', 'editor']}><Outlet /></Gate>}>
      <Route path="runs" element={<Gate roles={['editor', 'owner']}><Runs /></Gate>} />
      <Route path="direct" element={<RequireRole roles={['reader']}><Runs /></RequireRole>} />
      <Route path="closed" element={<Gate roles={[]}><Runs /></Gate>} />
    </Route></Routes>;`);
  const routes = new Map(readRouteSources(root).routes.map(r => [r.path, r.roles]));
  assert.deepEqual(routes.get('/work/runs'), ['editor']);
  assert.deepEqual(routes.get('/work/direct'), ['reader']);
  assert.deepEqual(routes.get('/work/closed'), []);
});

test('wrapper recognition follows forwarded bindings, not the component name', t => {
  const root = fixture(t, `function Access({ roles: allowed, children: content }) {
    return (<RequireRole roles={allowed}>{content}</RequireRole>);
  }
  const app = <Routes><Route path="runs" element={<Access roles={['editor']}><Runs /></Access>} /></Routes>;`);
  assert.deepEqual(scan(root), []);
});

for (const [name, body] of [
  ['removed authority', 'return <>{children}</>;'],
  ['replaced roles', "return <RequireRole roles={['owner']}>{children}</RequireRole>;"],
  ['spread override', 'return <RequireRole roles={roles} {...override}>{children}</RequireRole>;'],
  ['conditional bypass', 'return bypass ? children : <RequireRole roles={roles}>{children}</RequireRole>;'],
]) test(`a ${name} mutation cannot masquerade as a forwarding gate`, t => {
  const root = fixture(t, `function Gate({ roles, children }) { ${body} }
    const app = <Routes><Route path="runs" element={<Gate roles={['editor']}><Runs /></Gate>} /></Routes>;`);
  const findings = scan(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'role-mismatch');
});

test('a changed role array is still a mismatch through the forwarding gate', t => {
  const root = fixture(t, `${wrapper}
    const app = <Routes><Route path="runs" element={<Gate roles={['reader']}><Runs /></Gate>} /></Routes>;`);
  const findings = scan(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'role-mismatch');
  assert.equal(findings[0].route, 'reader');
});

test('a scoped wildcard root resolves, retaining its role gate and URL normalization', t => {
  const root = fixture(t, `${wrapper}
    const app = <Routes><Route path="work"><Route path="logging/*" element={<Gate roles={['editor']}><Logs /></Gate>} /></Route></Routes>;`,
    [{ path: '/work/logging/?view=voice#latest', label: 'Logging', roles: ['editor'] }]);
  assert.deepEqual(scan(root), []);
});

test('wildcard roots retain role mismatch detection', t => {
  const root = fixture(t, `const app = <Routes><Route path="logging/*" element={<RequireRole roles={['reader']}><Logs /></RequireRole>} /></Routes>;`,
    [{ path: '/logging', label: 'Logging', roles: ['editor'] }]);
  const findings = scan(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'role-mismatch');
  assert.equal(findings[0].route, 'reader');
});

test('catch-alls and dynamic routes cannot excuse missing or invented palette destinations', t => {
  const root = fixture(t, `const app = <Routes>
    <Route path="known" element={<Page />} /><Route path="*" element={<NotFound />} />
    <Route path="logging/*" element={<Logs />} /><Route path="records/:id/*" element={<Record />} />
  </Routes>;`, ['/missing', '/logging/invented', '/records/unverified'].map(p => ({ path: p, label: p })));
  const findings = scan(root);
  assert.equal(findings.length, 3);
  assert.ok(findings.every(f => f.rule === 'missing-route'));
});

test('an explicit route takes precedence over a wildcard root alias', t => {
  const root = fixture(t, `const app = <Routes>
    <Route path="logging/*" element={<RequireRole roles={['reader']}><Logs /></RequireRole>} />
    <Route path="logging" element={<RequireRole roles={['editor']}><Logs /></RequireRole>} />
  </Routes>;`, [{ path: '/logging', label: 'Logging', roles: ['editor'] }]);
  assert.deepEqual(scan(root), []);
});
