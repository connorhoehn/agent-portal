#!/usr/bin/env node
/** Thin CLI binding; the versioned skill owns measurements and reports. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveUiAuditSkill } = require('./lib/ui-audit-skill.cjs');
const root = path.resolve(__dirname, '..');
const skill = resolveUiAuditSkill({ root });
const cli = path.join(skill, 'scripts/audit.mjs');
if (!fs.existsSync(cli)) {
  console.error('Link ui-components/skills/ui-dom-audit as .claude/skills/ui-dom-audit (or set UI_DOM_AUDIT_SKILL to that directory).');
  process.exit(2);
}
// The interaction probes (row activation, detail actions, selection) make the larger
// sections run past the runner's 30-minute default; one test holds a whole run.
const env = { ...process.env, UI_DOM_AUDIT_TIMEOUT_MS: process.env.UI_DOM_AUDIT_TIMEOUT_MS || '3600000' };
const result = spawnSync(process.execPath, [cli, '--project', path.join(root, 'portal'), '--adapter', path.join(root, 'portal/e2e/ui-dom-audit.adapter.ts'), '--out', path.join(root, '.scratch/ui-dom-audit'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 2;
