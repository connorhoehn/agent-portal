#!/usr/bin/env node
/** Thin CLI binding; the versioned skill owns measurements and reports. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const skill = process.env.UI_DOM_AUDIT_SKILL || path.join(os.homedir(), '.codex/skills/ui-dom-audit');
const cli = path.join(skill, 'scripts/audit.mjs');
if (!fs.existsSync(cli)) {
  console.error('Install the ui-components/skills/ui-dom-audit skill, or set UI_DOM_AUDIT_SKILL to that directory.');
  process.exit(2);
}
const result = spawnSync(process.execPath, [cli, '--project', path.join(root, 'portal'), '--adapter', path.join(root, 'portal/e2e/ui-dom-audit.adapter.ts'), '--out', path.join(root, '.scratch/ui-dom-audit'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 2;
