// Fixture ↔ DDL shape parity, driven by the table in ../shape-entities.ts.
//
// The sibling of seed-parity.test.ts, for the two domains a row comparison
// cannot reach: the assessment tenant (which has NO seed — its fifteen
// registered fixtures are the seed) and the columns of `identity_schema.sql`
// that no INSERT names (`session_epoch`, `external_sub`, `tenants.status`).
//
// Nothing here is hand-typed. The columns, their types, their NOT NULLs, their
// DEFAULTs and their `CHECK (col IN (…))` vocabularies are all parsed out of
// schema/*.sql by ../ddl.ts, exactly as the seed table parses INSERTs.

jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true },
    region: 'us-east-1',
    // No cluster/secret: providers/identity.ts serves its in-memory mirror of
    // the seed, which is the thing under test.
    aurora: {},
  },
}));

import { FIXTURES_WITHOUT_A_TABLE, SHAPE_ENTITIES } from '../shape-entities.js';
import { auditShape, describeShape, describeShapeDrift, type ShapeAudit } from '../shape.js';
import { partitionDrift } from '../compare.js';
import { tableShape } from '../ddl.js';

const audits = new Map<string, ShapeAudit>();

beforeAll(async () => {
  for (const entity of SHAPE_ENTITIES) audits.set(entity.name, await auditShape(entity));
});

describe('the shape table itself', () => {
  it('covers every entity exactly once and gives each a reason to exist', () => {
    const names = SHAPE_ENTITIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of SHAPE_ENTITIES) expect(e.describes.length).toBeGreaterThan(20);
  });

  it('reads a real CREATE TABLE for every table it names', () => {
    for (const entity of SHAPE_ENTITIES) {
      const shape = tableShape(entity.sqlFile, entity.table);
      // A DDL reader that silently matched nothing would make every check
      // below pass vacuously — the same guard seed-parity puts on its parser.
      expect([entity.name, (shape?.columns.length ?? 0) > 0]).toEqual([entity.name, true]);
    }
  });

  it('has rows on both sides for every entity', () => {
    for (const entity of SHAPE_ENTITIES) {
      const a = audits.get(entity.name)!;
      expect([entity.name, a.mockCount > 0]).toEqual([entity.name, true]);
      expect([entity.name, a.modelled.length > 0]).toEqual([entity.name, true]);
    }
  });

  it('names, for every assessment row, the registered fixture it covers', () => {
    // The assessment tenant's fixtures ARE its seed, so an entity that does not
    // name one is checking something no surface serves. The rubric is the one
    // exception and says so: it is a compiled-in constant, not a fixture.
    for (const entity of SHAPE_ENTITIES.filter((e) => e.table.startsWith('assessment_'))) {
      if (entity.table === 'assessment_rubric_dimensions') continue;
      expect([entity.name, entity.fixture ?? null]).toEqual([entity.name, expect.stringMatching(/^assessment-/)]);
    }
  });

  it('accounts for every registered assessment fixture, covered or explained', async () => {
    // Total partition, walked against the LIVE registry rather than a list in
    // this file. An assessment fixture is the only seed its data has, so one
    // that is quietly outside the shape table is data nothing checks at all —
    // and a new fixture must fail here rather than arrive uncovered.
    await import('../../../assessment.js');
    const { fixtureRegistry } = await import('../../fixture.js');
    const covered = new Set(SHAPE_ENTITIES.map((e) => e.fixture).filter(Boolean));
    const registered = fixtureRegistry.all().map((f) => f.key).filter((k) => k.startsWith('assessment-'));
    expect(registered.length).toBeGreaterThan(10);
    for (const key of registered) {
      const reason = FIXTURES_WITHOUT_A_TABLE[key];
      if (covered.has(key)) {
        expect([key, reason]).toEqual([key, undefined]);   // covered AND excused is a stale excuse
      } else {
        // Not covered: say why, and say it at length enough to be a reason.
        expect([key, (reason ?? '').length > 20]).toEqual([key, true]);
      }
    }
    for (const key of Object.keys(FIXTURES_WITHOUT_A_TABLE)) {
      expect([key, registered.includes(key)]).toEqual([key, true]);
    }
  });
});

describe.each(SHAPE_ENTITIES.map((e) => [e.name, e] as const))(
  'mock fixture ↔ declared table shape: %s',
  (_name, entity) => {
    it('models every column, invents no key, and holds only values the column could store', () => {
      const gap = describeShape(entity, audits.get(entity.name)!);
      if (gap) throw new Error(gap);
    });
  },
);

describe('known shape drift', () => {
  it('is documented, not silent', () => {
    const lines: string[] = [];
    for (const entity of SHAPE_ENTITIES) lines.push(...describeShapeDrift(audits.get(entity.name)!));
    for (const line of lines) expect(line).not.toContain('no reason given');

    const { accepted, defects } = partitionDrift(lines);
    if (accepted.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\nShape parity known drift, accepted (${accepted.length}):\n  ${accepted.join('\n  ')}\n`);
    }
    if (defects.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\nShape parity DEFECTS on the record — real bugs, owned elsewhere (${defects.length}):\n  ${defects.join('\n  ')}\n`);
    }
  });
});
