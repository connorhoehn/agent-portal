#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAuditArgs, usage } from './cli-options.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const options = parseAuditArgs(args);
const require = createRequire(path.join(path.resolve(options.project), 'package.json'));
const testModule = require.resolve('@playwright/test');
const cli = path.join(path.dirname(testModule), 'cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-dom-audit-run-'));
options.adapter = path.resolve(options.adapter); options.out = path.resolve(options.out);
if (options.contract) options.contract = path.resolve(options.contract);
if (options.previous) options.previous = path.resolve(options.previous);
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
try {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({type: 'module'}));
  fs.writeFileSync(path.join(dir, 'audit.spec.ts'), `import playwright from ${JSON.stringify(testModule)}; const { test, expect } = playwright;\nimport adapter from ${JSON.stringify(options.adapter)};\nimport { runAudit } from ${JSON.stringify(runner)};\ntest('deterministic rendered UI contract', async ({ browser }) => { const result = await runAudit(browser, adapter, ${JSON.stringify(options)}); expect(result.exitCode, 'See '+${JSON.stringify(options.out)}+'/report.json and summary.txt').toBe(0); });\n`);
  fs.writeFileSync(path.join(dir, 'playwright.config.cjs'), `module.exports = {testDir:${JSON.stringify(dir)}, testMatch:'audit.spec.ts', timeout:${Number(process.env.UI_DOM_AUDIT_TIMEOUT_MS) || 1800000}, workers:1, retries:0, reporter:'line', outputDir:${JSON.stringify(path.join(options.out, 'playwright'))}, use:{browserName:'chromium', headless:true}};\n`);
  const result = spawnSync(process.execPath, [cli, 'test', '--config', path.join(dir, 'playwright.config.cjs')], { stdio: 'inherit', cwd: path.resolve(options.project) });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
