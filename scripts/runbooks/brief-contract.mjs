#!/usr/bin/env node
// The session-brief injection contract (docs/journeys/contracts/session-brief.json
// + docs/journeys/contracts/session-brief/<case>.md), judged by
// middleware/src/lib/__tests__/session-brief-contract.test.ts.
//
//   node scripts/runbooks/brief-contract.mjs            check: the real dispatch/claim path vs the contract
//   node scripts/runbooks/brief-contract.mjs --update   re-record it deliberately (then review the .md diff)
//
// A change in selection or rendering must arrive with a reviewed change to the
// contract files; nothing else rewrites them.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const update = process.argv.includes('--update');
const r = spawnSync(process.execPath, [
  'node_modules/.bin/jest', '--config', 'jest.config.cjs', 'src/lib/__tests__/session-brief-contract.test.ts',
], {
  cwd: join(root, 'middleware'), stdio: 'inherit',
  env: { ...process.env, ...(update ? { UPDATE_BRIEF_CONTRACT: '1' } : {}) },
});
if (update && r.status === 0) console.log('\nRe-recorded. Review: git diff docs/journeys/contracts/session-brief.json docs/journeys/contracts/session-brief/');
process.exit(r.status ?? 1);
