// R8 fixtures: a small, clean bundle (a procedure plus a script and the data its
// verify step replays) and one variant per bundle/skill lint rule that breaks
// exactly that rule. Pure data; the seeded demo bundles (CDP harness, presence
// client) live in mock/runbook-bundles and have their own offline test.
import type { LintRuleId, RunbookDoc, RunbookFile } from '../../types.js';
import { fileOf } from '../../files.js';

export const BUNDLE_RULES: LintRuleId[] = [
  'R-file-path', 'R-file-size', 'R-file-unreferenced', 'R-file-missing', 'R-script-header', 'R-bundle-verify',
  'R-skill-description', 'R-skill-collision',
];

export const COUNT_SCRIPT = [
  '#!/usr/bin/env node',
  '// runtime: node >=20',
  '// deps: none (node built-ins only)',
  '// Count the distinct values in each column of a CSV: node scripts/count.mjs <file.csv>',
  "import { readFileSync } from 'node:fs';",
  "const [head, ...rows] = readFileSync(process.argv[2], 'utf8').trim().split('\\n').map((l) => l.split(','));",
  "for (const [i, name] of head.entries()) console.log(`${name}: ${new Set(rows.map((r) => r[i])).size} distinct`);",
  '',
].join('\n');

export const SAMPLE_CSV = 'tenant,status\nacme,live\nglobex,live\ninitech,pending\n';

export const csvCountDoc: RunbookDoc = {
  title: 'Summarise a CSV export with the bundled counter',
  summary: 'Count the distinct values in every column of a CSV export before you trust it.',
  use_when: ['An export arrived as CSV and you need its shape before loading it.'],
  not_for: ['Exports in JSON (read them with jq).'],
  triggers: { work_item_labels: ['data'], repos: [], tools: ['csv'], keywords: ['csv', 'export', 'distinct', 'columns'] },
  preconditions: ['Node 20 or later is on the PATH.'],
  steps: [
    { do: 'Run the counter over the export.', command: { lang: 'bash', text: 'node scripts/count.mjs ./export.csv' }, expect: 'one line per column with its count of distinct values.' },
  ],
  verify: [
    { check: 'Run the counter over the bundled sample.', command: { lang: 'bash', text: 'node scripts/count.mjs data/sample.csv' } },
  ],
  failure_modes: [{ symptom: 'Every column reports 1 distinct', cause: 'The file uses semicolons', response: 'Convert the separators first' }],
  rollback: [],
};

export const csvCountFiles: RunbookFile[] = [
  fileOf({ path: 'scripts/count.mjs', content: COUNT_SCRIPT }),
  fileOf({ path: 'data/sample.csv', content: SAMPLE_CSV }),
];

const raw = (path: string, content: string, mode: RunbookFile['mode'] = '644'): RunbookFile =>
  ({ path, content, mode, sha256: '0'.repeat(64), size: Buffer.byteLength(content) });

/** Each rule's failing case: the doc, the files and (for collisions) the other skills. */
export const BUNDLE_FAILING: Record<string, { doc: RunbookDoc; files: RunbookFile[]; others?: Array<{ name: string; description: string }> }> = {
  'R-file-path': { doc: csvCountDoc, files: [...csvCountFiles, raw('../escape.sh', '#!/bin/sh\n')] },
  'R-file-size': { doc: csvCountDoc, files: [csvCountFiles[0]!, raw('data/sample.csv', 'a,b\n' + 'x,y\n'.repeat(20_000))] },
  'R-file-unreferenced': { doc: csvCountDoc, files: [...csvCountFiles, raw('data/leftover.txt', 'scratch\n')] },
  'R-file-missing': {
    doc: { ...csvCountDoc, verify: [{ check: 'Run the counter over the bundled sample.', command: { lang: 'bash', text: 'node scripts/count.mjs data/missing.csv' } }] },
    files: csvCountFiles,
  },
  'R-script-header': { doc: csvCountDoc, files: [raw('scripts/count.mjs', "import fs from 'node:fs';\nconsole.log(fs);\n", '755'), csvCountFiles[1]!] },
  'R-bundle-verify': {
    doc: { ...csvCountDoc, steps: [{ ...csvCountDoc.steps[0]!, command: { lang: 'bash', text: 'node scripts/count.mjs data/sample.csv' } }], verify: [{ check: 'Confirm the counter prints its usage.', command: { lang: 'bash', text: 'node scripts/count.mjs --help' } }] },
    files: csvCountFiles,
  },
  'R-skill-description': { doc: { ...csvCountDoc, use_when: [] }, files: csvCountFiles },
  'R-skill-collision': {
    doc: csvCountDoc, files: csvCountFiles,
    others: [{ name: 'rb-csv-columns', description: 'Count the distinct values in every column of a CSV export before you trust it. Use when: An export arrived as CSV and you need its shape before loading it. Not for: Exports in JSON (read them with jq).' }],
  },
};
