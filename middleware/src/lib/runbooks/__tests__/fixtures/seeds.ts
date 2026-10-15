// "Every seed runbook": the model's own good fixtures, plus every RunbookDoc
// found in lane C's mock/runbooks.seed.ts once that file exists.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunbookDoc } from '../../types.js';
import { GOOD_DOCS } from './good.js';

/** Every doc found in the seed module: arrays of { doc } or { versions: [{ doc }] }, or a map of either. */
export function seedDocs(): Array<[string, RunbookDoc]> {
  const out: Array<[string, RunbookDoc]> = Object.entries(GOOD_DOCS);
  const seedPath = resolve(__dirname, '../../../../mock/runbooks.seed.ts');
  if (!existsSync(seedPath)) return out;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(seedPath) as Record<string, unknown>;
  const visit = (label: string, v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o['title'] === 'string' && Array.isArray(o['steps']) && o['triggers']) { out.push([label, o as unknown as RunbookDoc]); return; }
    for (const [k, child] of Object.entries(o)) visit(`${label}.${k}`, child, depth + 1);
  };
  for (const [k, v] of Object.entries(mod)) visit(`seed:${k}`, v, 0);
  return out;
}

