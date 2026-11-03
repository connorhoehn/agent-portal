const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveUiAuditSkill } = require('./ui-audit-skill.cjs');

test('a clean consumer resolves the pinned skill without a sibling checkout or home installation', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-consumer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'portal/node_modules/@connorhoehnslalom/ui-components');
  const installed = path.join(pkg, 'skills/ui-dom-audit');
  fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@connorhoehnslalom/ui-components', exports: { './package.json': './package.json' } }));
  for (const name of ['audit.mjs', 'source-audit.cjs']) fs.writeFileSync(path.join(installed, 'scripts', name), '');
  const options = { root, home: path.join(root, 'empty-home'), env: {} };
  assert.equal(resolveUiAuditSkill(options), installed);
  assert.equal(resolveUiAuditSkill({ ...options, resource: 'scripts/source-audit.cjs' }), installed);
  const linked = path.join(root, '.claude/skills/ui-dom-audit');
  fs.mkdirSync(path.join(linked, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(linked, 'scripts/audit.mjs'), '');
  assert.equal(resolveUiAuditSkill(options), installed, 'an unpinned linked checkout must not silently replace the installed contract');
  assert.equal(resolveUiAuditSkill({ ...options, env: { UI_DOM_AUDIT_SKILL: linked } }), linked);
  assert.throws(() => resolveUiAuditSkill({ ...options, env: { UI_DOM_AUDIT_SKILL: path.join(root, 'missing') } }), /UI_DOM_AUDIT_SKILL is missing/);
});

test('older installs can use a linked skill, while missing dependencies fail explicitly', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-legacy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { root, home: path.join(root, 'empty-home'), env: {} };
  assert.throws(() => resolveUiAuditSkill(options), /Install the pinned ui-components/);
  const linked = path.join(root, '.claude/skills/ui-dom-audit');
  fs.mkdirSync(path.join(linked, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(linked, 'scripts/audit.mjs'), '');
  assert.equal(resolveUiAuditSkill(options), linked);
});
