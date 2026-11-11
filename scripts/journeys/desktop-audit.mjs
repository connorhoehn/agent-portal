// Audit the real journey stack using the contract shipped in the UI archive.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function verifyDesktopAudit(route, out, previous) {
  assert.ok(process.env.PORTAL_URL, 'use the journey runner private stack');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/audit-ui-dom.cjs'),
    '--tenant', 'orgiq', '--path', route, '--themes', 'light,dark',
    '--widths', '1440,1280', '--states', 'default', '--deep', '--strict-coverage', '--out', out,
    ...(previous ? ['--previous', previous] : []),
  ], { cwd: root, stdio: 'inherit', env: { ...process.env,
    UI_AUDIT_BASE_URL: process.env.PORTAL_URL, UI_DOM_AUDIT_CLONES: '1',
  } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `desktop audit failed for ${route}; see ${out}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.cases.length, 4, 'both desktop widths in both themes must be measured');
  assert.equal(report.exitCode, 0);
  assert.ok(report.cases.every(c => c.issues.length === 0), 'every measured case must pass');
  return report;
}
