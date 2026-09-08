// Seed ↔ mock parity, driven by the table in ../entities.ts.
//
// Replaces the row-comparison half of five one-off tests
// (work-items-seed-parity, program-seed-parity, agent-projects-seed-parity,
// person-identity-parity, mock-parity) with one loop. Each of those was
// written the day a specific drift was found and hard-coded that drift's
// shape; this walks a declarative table instead, so an entity nobody has
// broken yet is covered too, and adding coverage is a table row rather than
// a new file.
//
// The expected values are PARSED from schema/*.sql (see ../sql-seed.ts) — the
// nine originals mostly hand-copied them, which is how the mock drifted from
// the seed in the first place.

jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../../../config.js', () => ({
  config: { mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true }, region: 'us-east-1' },
}));

import { PARITY_ENTITIES } from '../entities.js';
import {
  compareEntity, describeKnownDrift, describeResult, partitionDrift, type ParityResult,
} from '../compare.js';
import { auditColumnCoverage, describeCoverage, describeCoverageDrift, type ColumnCoverage } from '../columns.js';

// One comparison pass per entity, shared by the assertions below.
const results = new Map<string, ParityResult>();
const coverage = new Map<string, ColumnCoverage>();

beforeAll(async () => {
  for (const entity of PARITY_ENTITIES) {
    results.set(entity.name, await compareEntity(entity));
    coverage.set(entity.name, await auditColumnCoverage(entity));
  }
});

describe('the parity table itself', () => {
  it('covers every entity exactly once and gives each a reason to exist', () => {
    const names = PARITY_ENTITIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of PARITY_ENTITIES) {
      expect(e.describes.length).toBeGreaterThan(20);
      expect(['complete', 'subset']).toContain(e.coverage);
    }
  });

  it('reads real INSERT statements out of every .sql file it names', async () => {
    for (const entity of PARITY_ENTITIES) {
      const r = results.get(entity.name)!;
      // A parser that silently matched nothing would make every row below
      // pass vacuously — this is the guard the nine originals each wrote by
      // hand as `expect(seedRows.size).toBeGreaterThan(0)`.
      expect([entity.name, r.seedCount > 0]).toEqual([entity.name, true]);
      expect([entity.name, r.mockCount > 0]).toEqual([entity.name, true]);
    }
  });

  it('actually compares rows on both sides for every entity', () => {
    for (const entity of PARITY_ENTITIES) {
      const r = results.get(entity.name)!;
      expect([entity.name, r.comparedIds > 0]).toEqual([entity.name, true]);
    }
  });
});

describe.each(PARITY_ENTITIES.map((e) => [e.name, e] as const))(
  'mock ↔ schema seed: %s',
  (_name, entity) => {
    it('carries no invented id, no missing seeded id, and no field disagreement', () => {
      const r = results.get(entity.name)!;
      const diff = describeResult(entity, r);
      if (diff) throw new Error(diff);
    });

    // The check the allocations slipped through. Presence and shape were
    // right; `allocated_usd` was $60 against the seed's $95, and no test
    // looked, because the parity table's `fields` is a hand-written list and
    // an unlisted column is an uncompared column. This asks the question the
    // other way round: of every column BOTH sources carry, which ones does
    // nothing compare?
    it('compares every column both the seed and the mock carry', () => {
      const gap = describeCoverage(entity, coverage.get(entity.name)!);
      if (gap) throw new Error(gap);
    });
  },
);

describe('known drift', () => {
  it('is documented, not silent', () => {
    const lines: string[] = [];
    for (const entity of PARITY_ENTITIES) {
      lines.push(...describeKnownDrift(entity, results.get(entity.name)!));
      lines.push(...describeCoverageDrift(coverage.get(entity.name)!));
    }
    // Every tolerated disagreement must carry a written reason — an
    // exemption with no reason is indistinguishable from drift nobody noticed.
    for (const line of lines) expect(line).not.toContain('no reason given');

    // Visible in the run output, so drift never quietly becomes the norm — and
    // split, so a recorded BUG is never read as an accepted difference.
    const { accepted, defects } = partitionDrift(lines);
    if (accepted.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\nParity known drift, accepted (${accepted.length}):\n  ${accepted.join('\n  ')}\n`);
    }
    if (defects.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\nParity DEFECTS on the record — real bugs, owned elsewhere (${defects.length}):\n  ${defects.join('\n  ')}\n`);
    }
  });
});
