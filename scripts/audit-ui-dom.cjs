#!/usr/bin/env node
/** Thin CLI binding; the versioned skill owns measurements and reports. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// The versioned skill lives in ui-components/skills/ui-dom-audit; this repo links it as a
// Claude Code skill (.claude/skills/ui-dom-audit), and a user-level Claude or Codex link works too.
const candidates = [process.env.UI_DOM_AUDIT_SKILL, path.join(root, '.claude/skills/ui-dom-audit'), path.join(os.homedir(), '.claude/skills/ui-dom-audit'), path.join(os.homedir(), '.codex/skills/ui-dom-audit')].filter(Boolean);
const skill = candidates.find(dir => fs.existsSync(path.join(dir, 'scripts/audit.mjs'))) || candidates[1];
const cli = path.join(skill, 'scripts/audit.mjs');
if (!fs.existsSync(cli)) {
  console.error('Link ui-components/skills/ui-dom-audit as .claude/skills/ui-dom-audit (or set UI_DOM_AUDIT_SKILL to that directory).');
  process.exit(2);
}
const result = spawnSync(process.execPath, [cli, '--project', path.join(root, 'portal'), '--adapter', path.join(root, 'portal/e2e/ui-dom-audit.adapter.ts'), '--out', path.join(root, '.scratch/ui-dom-audit'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 2;
