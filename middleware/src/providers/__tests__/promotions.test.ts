// The promotion ladder's decision rules + the mock inbox end-to-end.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  clusterObservations, qualifiesAsPattern, classifyPattern, decidePromotion,
  listCandidates, getCandidate, promoteCandidate, dismissCandidate,
  type Observation,
} from '../promotions.js';
import { pipelineRunRecords } from '../../mock/pipeline-definitions.js';

function ob(over: Partial<Observation> & Pick<Observation, 'id' | 'sessionId'>): Observation {
  return {
    kind: 'gotcha', title: '', body: '', repo: null, initiativeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('clusterObservations — explainable, not ML', () => {
  it('groups observations that share enough vocabulary', () => {
    const clusters = clusterObservations([
      ob({ id: 'a', sessionId: 's1', title: 'Aurora Data API cold start fails first call', body: 'HttpEndpointNotEnabledException on a fresh cluster' }),
      ob({ id: 'b', sessionId: 's2', title: 'Retry Aurora Data API cold start with backoff', body: 'HttpEndpointNotEnabledException clears after retrying' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.observations.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('keeps unrelated observations in separate clusters', () => {
    const clusters = clusterObservations([
      ob({ id: 'a', sessionId: 's1', title: 'Aurora Data API cold start', body: 'HttpEndpointNotEnabledException' }),
      ob({ id: 'b', sessionId: 's2', title: 'Fargate exec format error on ARM64', body: 'wrong runtimePlatform default' }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('lowers the similarity bar for observations sharing a repo', () => {
    const clusters = clusterObservations([
      ob({ id: 'a', sessionId: 's1', repo: 'aws-agentcore', title: 'custodian revokes open security group ingress', body: 'ALB rule closed within seconds' }),
      ob({ id: 'b', sessionId: 's2', repo: 'aws-agentcore', title: 'security group allow-list keeps custodian off the rule', body: 'ALB stayed open with a scoped CIDR' }),
    ]);
    expect(clusters).toHaveLength(1);
  });
});

describe('qualifiesAsPattern — the promotion floor', () => {
  it('refuses fewer than three observations', () => {
    expect(qualifiesAsPattern({ observations: [ob({ id: 'a', sessionId: 's1' }), ob({ id: 'b', sessionId: 's2' })] })).toBe(false);
  });

  it('refuses three observations from a single session — one incident told three times', () => {
    expect(qualifiesAsPattern({
      observations: [ob({ id: 'a', sessionId: 's1' }), ob({ id: 'b', sessionId: 's1' }), ob({ id: 'c', sessionId: 's1' })],
    })).toBe(false);
  });

  it('qualifies three observations across two distinct sessions', () => {
    expect(qualifiesAsPattern({
      observations: [ob({ id: 'a', sessionId: 's1' }), ob({ id: 'b', sessionId: 's1' }), ob({ id: 'c', sessionId: 's2' })],
    })).toBe(true);
  });
});

describe('classifyPattern — runbook needs a trigger AND an outcome', () => {
  it('classifies as runbook when a worked/decision kind meets an actionable verb', () => {
    const cluster = {
      observations: [
        ob({ id: 'a', sessionId: 's1', kind: 'failed', title: 'call failed cold' }),
        ob({ id: 'b', sessionId: 's1', kind: 'worked', title: 'retry with backoff cleared it' }),
      ],
    };
    expect(classifyPattern(cluster)).toBe('runbook');
  });

  it('classifies as insight when there is no worked/decision outcome', () => {
    const cluster = {
      observations: [
        ob({ id: 'a', sessionId: 's1', kind: 'gotcha', title: 'vanilla otel distro drops spans silently' }),
        ob({ id: 'b', sessionId: 's2', kind: 'convention', title: 'always install aws-opentelemetry-distro' }),
      ],
    };
    expect(classifyPattern(cluster)).toBe('insight');
  });

  it('classifies as insight when the outcome kind is present but nothing actionable is described', () => {
    const cluster = {
      observations: [
        ob({ id: 'a', sessionId: 's1', kind: 'decision', title: 'account uses only the default AWS profile' }),
        ob({ id: 'b', sessionId: 's2', kind: 'worked', title: 'the default profile resolved the right account' }),
      ],
    };
    expect(classifyPattern(cluster)).toBe('insight');
  });
});

describe('decidePromotion — the human + dry-run gate', () => {
  it('refuses an already-promoted candidate', () => {
    const r = decidePromotion({ id: 'pc', status: 'promoted', proposedKind: 'insight' }, { approvedBy: 'Nora', dryRun: null });
    expect(r.ok).toBe(false);
  });

  it('refuses a dismissed candidate', () => {
    const r = decidePromotion({ id: 'pc', status: 'dismissed', proposedKind: 'runbook' }, { approvedBy: 'Nora', dryRun: null });
    expect(r.ok).toBe(false);
  });

  it('refuses without approval, regardless of kind', () => {
    const r = decidePromotion({ id: 'pc', status: 'candidate', proposedKind: 'insight' }, { approvedBy: null, dryRun: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/human approval/);
  });

  it('passes an insight with approval alone', () => {
    expect(decidePromotion({ id: 'pc', status: 'candidate', proposedKind: 'insight' }, { approvedBy: 'Nora', dryRun: null }).ok).toBe(true);
  });

  it('passes a runbook with approval alone — the dry-run gate is skill-only', () => {
    expect(decidePromotion({ id: 'pc', status: 'candidate', proposedKind: 'runbook' }, { approvedBy: 'Nora', dryRun: null }).ok).toBe(true);
  });

  it('refuses a skill approved but with no dry run yet', () => {
    const r = decidePromotion({ id: 'pc', status: 'approved', proposedKind: 'skill' }, { approvedBy: 'Nora', dryRun: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/completed dry-run of runbook:pc/);
  });

  it('refuses a skill whose dry run failed, with a distinct reason', () => {
    const r = decidePromotion({ id: 'pc', status: 'approved', proposedKind: 'skill' }, { approvedBy: 'Nora', dryRun: { runId: 'job:1', definitionId: 'runbook:pc', status: 'failed' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/failed/);
  });

  it('passes a skill with both approval and a passing dry run', () => {
    expect(decidePromotion({ id: 'pc', status: 'approved', proposedKind: 'skill' }, { approvedBy: 'Nora', dryRun: { runId: 'job:1', definitionId: 'runbook:pc', status: 'completed' } }).ok).toBe(true);
  });
});

describe('the mock inbox end-to-end', () => {
  it('lists the four canonical candidates, including the drifted skill', async () => {
    const candidates = await listCandidates();
    expect(candidates.map((c) => c.id)).toEqual(expect.arrayContaining([
      'promo-aurora-cold-start', 'promo-arm64-fargate', 'promo-adot-configurator', 'promo-custodian-sg-drift',
    ]));
    const drifted = candidates.find((c) => c.id === 'promo-custodian-sg-drift');
    expect(drifted?.driftedFrom).toBe('skl-custodian-sg-allowlist');
    expect(drifted?.proposedKind).toBe('runbook');
  });

  it('getCandidate returns null for an unknown id', async () => {
    expect(await getCandidate('nope')).toBeNull();
  });

  it('a fresh skill candidate refuses promotion without a dry run, but records the approval', async () => {
    const before = await getCandidate('promo-aurora-cold-start');
    expect(before?.status).toBe('candidate');

    const refused = await promoteCandidate('promo-aurora-cold-start', { approvedBy: 'Priya Nair' });
    expect(refused && 'error' in refused && refused.error).toMatch(/dry-run/);

    const after = await getCandidate('promo-aurora-cold-start');
    expect(after?.status).toBe('approved');
  });

  it('a completed dry-run of its own runbook then promotes the same candidate, citing the run', async () => {
    pipelineRunRecords.rows().push({
      id: 'job:dry-1', definitionId: 'runbook:promo-aurora-cold-start', contextTenant: 'orgiq', runKind: 'runbook:dry-run',
      status: 'completed', jobId: null, triggeredBy: 'u-ines', model: null, estimateUsd: null, costUsd: null,
      error: null, startedAt: '2026-09-30T10:00:00.000Z', finishedAt: '2026-09-30T10:01:00.000Z',
    });
    const result = await promoteCandidate('promo-aurora-cold-start', { approvedBy: 'Priya Nair' });
    expect(result && 'candidate' in result && result.candidate?.status).toBe('promoted');
    expect(result && 'candidate' in result && result.candidate?.dryRunRunId).toBe('job:dry-1');
    expect(result && 'candidate' in result && result.candidate?.dryRunPassed).toBe(true);
    pipelineRunRecords.reset();
  });

  it('refuses to promote an already-promoted candidate', async () => {
    const result = await promoteCandidate('promo-arm64-fargate', { approvedBy: 'Someone Else' });
    expect(result && 'error' in result && result.error).toMatch(/already promoted/);
  });

  it('dismissCandidate marks a candidate dismissed and records the reason', async () => {
    const result = await dismissCandidate('promo-adot-configurator', 'duplicate of the existing build-review checklist item');
    expect(result?.status).toBe('dismissed');
    expect(result?.rationale).toMatch(/dismissed: duplicate/);
  });

  it('promoteCandidate returns null for an unknown id', async () => {
    expect(await promoteCandidate('nope', { approvedBy: 'Someone' })).toBeNull();
  });
});
