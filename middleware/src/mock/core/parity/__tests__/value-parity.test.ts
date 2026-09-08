// PROVING THE VALUE CHECKS CAN FAIL.
//
// "A check that cannot be shown to fail is not a check." Every assertion in
// seed-parity.test.ts is green against the live fixtures, which is exactly the
// state the allocations were in while `MOCK_BUDGETS` said $60 and the seed said
// $95 — green, and blind. Green proves nothing on its own.
//
// So this file mutates. It takes real entities out of PARITY_ENTITIES, wraps
// their `mockRows` so ONE number comes back wrong, and asserts the harness
// fails naming the column and BOTH values. Then it does the same to the column
// coverage check: delete a `FieldCheck` and the coverage audit must notice the
// column is no longer compared — and quote the values that disagree once
// nothing is watching them.
//
// Doing it here rather than by hand-editing a provider is deliberate: a manual
// mutation proves the check worked once, on the day someone tried it. This one
// runs on every `npm test`, so the day someone weakens `compareEntity` into
// passing everything, these fail.

jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../../../config.js', () => ({
  config: { mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true }, region: 'us-east-1' },
}));

import { PARITY_ENTITIES } from '../entities.js';
import { compareEntity, describeResult, type ParityEntity } from '../compare.js';
import { auditColumnCoverage, camelCase, describeCoverage } from '../columns.js';

const entityNamed = (name: string): ParityEntity<any> => {
  const found = PARITY_ENTITIES.find((e) => e.name === name);
  if (!found) throw new Error(`no parity entity named '${name}' — this test is stale`);
  return found;
};

/**
 * The same entity, with one field on one row perturbed. Everything else — the
 * seed side, the ids, the other columns — is the real thing, so a failure this
 * produces is the failure a real drift would produce.
 */
function withMutation<M>(
  entity: ParityEntity<M>,
  id: string,
  mutate: (row: M) => M,
): ParityEntity<M> {
  return {
    ...entity,
    mockRows: async () => {
      const rows = await entity.mockRows();
      return rows.map((r) => (entity.mockId(r) === id ? mutate({ ...r }) : r));
    },
  };
}

describe('the value comparison fails when a value moves', () => {
  it('names the column and both numbers when an allocation drifts', async () => {
    const budgets = entityNamed('initiative_budgets');
    // p-auth-migration is the one allocation the mock already mirrors exactly
    // ($75), so moving it is a clean single-variable mutation.
    const mutated = withMutation(budgets, 'p-auth-migration', (b: any) => ({ ...b, allocatedUsd: 60 }));

    const clean = describeResult(budgets, await compareEntity(budgets));
    const broken = describeResult(mutated, await compareEntity(mutated));

    // The mutation, and nothing else, is what this asserts on: the clean run
    // may legitimately be red for reasons this test is not about.
    expect(clean ?? '').not.toContain('p-auth-migration');
    expect(broken).toContain('p-auth-migration');
    expect(broken).toContain('allocated_usd');
    expect(broken).toContain('seed 75');
    expect(broken).toContain('mock 60');
    expect(broken).toContain('seed_program.sql:');
  });

  it('names the column and both counts when a queue number drifts', async () => {
    const jobs = entityNamed('agent_jobs');
    const mutated = withMutation(jobs, 'job-obs-maint-1', (j: any) => ({ ...j, attempts: 3 }));
    const broken = describeResult(mutated, await compareEntity(mutated));
    expect(broken).toContain('job-obs-maint-1');
    expect(broken).toContain('attempts');
    expect(broken).toContain('seed 1');
    expect(broken).toContain('mock 3');
  });

  it('reads a scalar out of a jsonb column under the name it checks', async () => {
    const runs = entityNamed('bot_runs');
    const mutated = withMutation(runs, 'job-obs-maint-1', (r: any) => ({
      ...r, outcome: { reason: 'manual re-run' },
    }));
    const broken = describeResult(mutated, await compareEntity(mutated));
    // `label` is what makes this readable: the column is `outcome`, the thing
    // that moved is `outcome.reason`.
    expect(broken).toContain('outcome.reason');
    expect(broken).toContain("seed 'scheduled maintenance'");
    expect(broken).toContain("mock 'manual re-run'");
  });

  it('still fails when a value drifts to null rather than to another number', async () => {
    const budgets = entityNamed('initiative_budgets');
    const mutated = withMutation(budgets, 'p-auth-migration', (b: any) => ({ ...b, allocatedUsd: null }));
    const broken = describeResult(mutated, await compareEntity(mutated));
    expect(broken).toContain('seed 75');
    expect(broken).toContain('mock NULL');
  });
});

describe('an exemption that has outlived its problem fails', () => {
  it('rejects an allowedMissingIds entry for an id the mock now carries', async () => {
    const budgets = entityNamed('initiative_budgets');
    // Exactly what happened to p-data-lake and p-zero-trust: exempted with a
    // written reason, then given real ledger rows an hour later. Nothing said
    // the reason had stopped being true.
    const stale: ParityEntity<any> = {
      ...budgets,
      allowedMissingIds: {
        'p-data-lake': 'a reason long enough to read as deliberate, and no longer true',
      },
    };
    const broken = describeResult(stale, await compareEntity(stale));
    expect(broken).toContain('OUTLIVED');
    expect(broken).toContain('p-data-lake');
    expect(broken).toContain('the mock now carries');
  });
});

describe('the column coverage audit fails when a column stops being compared', () => {
  it('catches an amount that both sources carry and nothing compares', async () => {
    const budgets = entityNamed('initiative_budgets');
    // Exactly the state the harness was in before this slice: the allocation
    // column present on both sides, and no FieldCheck over it.
    const blind: ParityEntity<any> = {
      ...budgets,
      fields: budgets.fields.filter((f) => f.seed !== 'allocated_usd'),
    };
    const gap = describeCoverage(blind, await auditColumnCoverage(blind));
    expect(gap).toContain('allocated_usd');
    expect(gap).toContain('allocatedUsd');
    expect(gap).toContain('is never compared');
    // And it quotes what the silence is hiding.
    expect(gap).toMatch(/seed \d+ vs mock/);
  });

  it('catches a column that agrees today, before it stops agreeing', async () => {
    const jobs = entityNamed('agent_jobs');
    const blind: ParityEntity<any> = {
      ...jobs,
      fields: jobs.fields.filter((f) => f.seed !== 'priority'),
    };
    const gap = describeCoverage(blind, await auditColumnCoverage(blind));
    expect(gap).toContain('priority');
    expect(gap).toContain('nothing keeps them agreeing');
  });

  it('refuses an exemption with no reason, and one that has outlived its column', async () => {
    const jobs = entityNamed('agent_jobs');
    const blank: ParityEntity<any> = {
      ...jobs,
      fields: jobs.fields.filter((f) => f.seed !== 'priority'),
      uncheckedColumns: { priority: 'later' },
    };
    expect(describeCoverage(blank, await auditColumnCoverage(blank))).toContain('no usable reason');

    const stale: ParityEntity<any> = {
      ...jobs,
      uncheckedColumns: {
        column_that_no_seed_writes: 'a reason long enough to pass the length floor, and wrong',
      },
    };
    expect(describeCoverage(stale, await auditColumnCoverage(stale))).toContain('no longer writes');

    const redundant: ParityEntity<any> = {
      ...jobs,
      uncheckedColumns: { priority: 'a reason long enough to pass the length floor, on a compared column' },
    };
    expect(describeCoverage(redundant, await auditColumnCoverage(redundant))).toContain('AND compared');
  });

  it('does not report a column the mock does not carry at all', async () => {
    // `people.expertise_score` is in the seed and on no mock row. Out of scope:
    // this check is about columns BOTH sources carry, and reporting the rest
    // would bury the ones that matter.
    const c = await auditColumnCoverage(entityNamed('people'));
    expect(c.seedOnly).toContain('expertise_score');
    expect(c.uncovered.map((u) => u.column)).not.toContain('expertise_score');
  });
});

describe('the audit derives its question from the files, not from a list', () => {
  it('pairs a snake_case seed column with the camelCase key the wire uses', () => {
    expect(camelCase('allocated_usd')).toBe('allocatedUsd');
    expect(camelCase('org_project_id')).toBe('orgProjectId');
    expect(camelCase('max_attempts')).toBe('maxAttempts');
    expect(camelCase('id')).toBe('id');
  });

  it('finds columns to check on every entity, so no entity passes vacuously', async () => {
    for (const entity of PARITY_ENTITIES) {
      const c = await auditColumnCoverage(entity);
      const accounted = c.checked.length + c.identity.length + c.documented.length
        + c.expression.length + c.seedOnly.length + c.uncovered.length;
      expect([entity.name, accounted > 0]).toEqual([entity.name, true]);
    }
  });
});
