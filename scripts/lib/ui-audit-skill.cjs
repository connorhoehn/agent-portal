const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Prefer the installed, pinned audit; an explicit override enables library development. */
function resolveUiAuditSkill({ root = path.resolve(__dirname, '../..'), env = process.env, home = os.homedir(), resource = 'scripts/audit.mjs' } = {}) {
  if (env.UI_DOM_AUDIT_SKILL) {
    const override = path.resolve(root, env.UI_DOM_AUDIT_SKILL);
    if (!fs.existsSync(path.join(override, resource))) throw new Error(`UI_DOM_AUDIT_SKILL is missing ${resource}: ${override}`);
    return override;
  }
  let installed;
  try {
    const manifest = require.resolve('@connorhoehnslalom/ui-components/package.json', { paths: [path.join(root, 'portal')] });
    installed = path.join(path.dirname(manifest), 'skills/ui-dom-audit');
  } catch { /* Older consumers may still use a linked skill checkout. */ }
  const candidates = [installed, path.join(root, '.claude/skills/ui-dom-audit'), path.join(home, '.claude/skills/ui-dom-audit'), path.join(home, '.codex/skills/ui-dom-audit')].filter(Boolean);
  const skill = candidates.find(dir => fs.existsSync(path.join(dir, resource)));
  if (!skill) throw new Error(`Install the pinned ui-components package with its audit skill, or set UI_DOM_AUDIT_SKILL (${resource} is missing).`);
  return skill;
}
module.exports = { resolveUiAuditSkill };
