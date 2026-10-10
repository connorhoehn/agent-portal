// Rule 1 of docs/social-tenant-design.md §5.2: a RUNBOOK asset cannot be
// promoted to SKILL without a `completed` run of ITS OWN definition — the
// dry-run the ladder doc names, now a recorded `pipeline_runs` row. The four
// cases the goal doc names (docs/pipelines-tenant-goal.md §P2), end to end
// through promoteCandidate over the registered fixtures, and the verdict
// carries the run id rather than a boolean.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { promoteCandidate, getCandidate, decidePromotion } from '../../providers/promotions.js';
import { promotionCandidates } from '../../mock/promotions.js';
import { pipelineRunRecords } from '../../mock/pipeline-definitions.js';
import type { PipelineRunRecord } from '../pipeline-definitions.js';

const SKILL = 'promo-aurora-cold-start';          // proposedKind 'skill', status 'candidate'
const OWN = `runbook:${SKILL}`;

function record(over: Partial<PipelineRunRecord> & Pick<PipelineRunRecord, 'id' | 'definitionId' | 'status'>): PipelineRunRecord {
  return {
    contextTenant: 'orgiq', runKind: 'runbook:dry-run', jobId: null, triggeredBy: 'u-ines', model: null,
    estimateUsd: null, costUsd: null, error: null,
    startedAt: '2026-09-30T10:00:00.000Z', finishedAt: null,
    ...over,
  };
}

afterEach(() => {
  promotionCandidates.reset();
  pipelineRunRecords.reset();
});

describe('rule 1 — a RUNBOOK becomes a SKILL only on a completed run of its own definition', () => {
  it('no run → refused, and the approval still lands', async () => {
    const out = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield' });
    expect(out && 'error' in out && out.error).toMatch(/needs a completed dry-run of runbook:promo-aurora-cold-start/);
    // The refusal says the approval landed, and names no other tenant's page
    // as the remedy (an orgiq reviewer holds no pipelines grant — sme #19).
    expect(out && 'error' in out && out.error).toMatch(/the approval is recorded/);
    expect(out && 'error' in out && out.error).not.toMatch(/\/pipelines\//);
    const after = await getCandidate(SKILL);
    expect(after?.status).toBe('approved');
    expect(after?.dryRunRunId).toBeNull();
  });

  it('a run that is not completed (failed, or still running) → refused, naming the run', async () => {
    pipelineRunRecords.rows().push(record({ id: 'job:failed-1', definitionId: OWN, status: 'failed', finishedAt: '2026-09-30T10:02:00.000Z' }));
    const failed = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield' });
    expect(failed && 'error' in failed && failed.error).toMatch(/job:failed-1 failed/);
    // The verdict records the run it was judged on — the run, not a boolean.
    expect((await getCandidate(SKILL))?.dryRunRunId).toBe('job:failed-1');
    expect((await getCandidate(SKILL))?.dryRunPassed).toBe(false);

    pipelineRunRecords.reset();
    pipelineRunRecords.rows().push(record({ id: 'job:running-1', definitionId: OWN, status: 'running' }));
    const running = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield' });
    expect(running && 'error' in running && running.error).toMatch(/job:running-1 is running, not completed/);
  });

  it('a completed run of another definition → refused', async () => {
    pipelineRunRecords.rows().push(record({ id: 'job:other-1', definitionId: 'runbook:promo-custodian-sg-drift', status: 'completed' }));
    const out = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield', dryRunRunId: 'job:other-1' });
    expect(out && 'error' in out && out.error).toMatch(/dry-run of runbook:promo-custodian-sg-drift, not of runbook:promo-aurora-cold-start/);
    // Another runbook's run is never recorded on this verdict.
    expect((await getCandidate(SKILL))?.dryRunRunId).toBeNull();
    expect((await getCandidate(SKILL))?.status).toBe('approved');
  });

  it("a 'completed' run of its own definition → promoted, the verdict citing the run id", async () => {
    pipelineRunRecords.rows().push(record({ id: 'job:done-1', definitionId: OWN, status: 'completed', finishedAt: '2026-09-30T10:03:00.000Z' }));
    const out = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield' });
    expect(out && 'candidate' in out && out.candidate?.status).toBe('promoted');
    expect(out && 'candidate' in out && out.candidate?.dryRunRunId).toBe('job:done-1');
    expect(out && 'candidate' in out && out.candidate?.dryRun).toMatchObject({ runId: 'job:done-1', definitionId: OWN, status: 'completed' });
  });

  it('prefers the newest completed run over a newer failed one when none is named', async () => {
    pipelineRunRecords.rows().push(
      record({ id: 'job:done-old', definitionId: OWN, status: 'completed', startedAt: '2026-09-29T10:00:00.000Z' }),
      record({ id: 'job:failed-new', definitionId: OWN, status: 'failed', startedAt: '2026-09-30T10:00:00.000Z' }),
    );
    const out = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield' });
    expect(out && 'candidate' in out && out.candidate?.dryRunRunId).toBe('job:done-old');
  });

  it('a runbook (not a skill) needs no run — the gate is RUNBOOK → SKILL only', () => {
    expect(decidePromotion({ id: 'promo-custodian-sg-drift', status: 'candidate', proposedKind: 'runbook' }, { approvedBy: 'Dara', dryRun: null }).ok).toBe(true);
  });

  it('a named run that was never recorded → refused', async () => {
    const out = await promoteCandidate(SKILL, { approvedBy: 'Dara Whitfield', dryRunRunId: 'job:nope' });
    expect(out && 'error' in out && out.error).toMatch(/no recorded run job:nope/);
  });
});
