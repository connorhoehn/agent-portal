// Aurora half of the run report deck store: parameterized SQL and the CAS
// append as ONE statement; plus narrative validation over run facts (a span
// that is not verbatim keeps the template prose).

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false, agentcore: false }, auth: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));

import { exec } from '../aurora.js';
import { pipelineDeckStore } from '../pipeline-decks.js';
import { buildRunDeckFacts, buildRunDraftInput } from '../../lib/pipeline-deck/facts.js';
import { mergeDraft } from '../../lib/deck-shared/narrative.js';
import type { Run, Step } from '../../lib/pipeline-runs.js';

const execMock = exec as unknown as jest.Mock;
const SPEC = { title: 'T', slides: [{ id: 'a', layout: 'bullets' as const, title: 'A', bullets: ['b'], sources: [{ documentId: 'pipeline-run:job:1', title: 'S' }] }] };
const REV = { id: 'prev-1', deckId: 'pdeck-1', baseRevisionId: 'prev-0', label: 'Edited', spec: SPEC, lockedSlideIds: [], producedBy: 'person:u-a', createdBy: 'u-a', summary: null };

afterEach(() => execMock.mockReset());

describe('pipeline deck store (Aurora)', () => {
  it('appends with one parameterized compare-and-set statement', async () => {
    execMock.mockResolvedValueOnce([{ id: 'prev-1', deck_id: 'pdeck-1', seq: 2, base_revision_id: 'prev-0', label: 'Edited',
      locked_slide_ids: '[]', produced_by: 'person:u-a', created_by: 'u-a', summary: null, created_at: '2026-10-05T12:00:00.000Z' }]);
    const result = await pipelineDeckStore.appendRevision(REV);
    expect(result).toMatchObject({ ok: true, revision: { id: 'prev-1', seq: 2, spec: SPEC } });
    const [sql] = execMock.mock.calls[0]!;
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(sql).toMatch(/UPDATE pipeline_run_decks SET head_revision_id = :id/);
    expect(sql).toMatch(/head_revision_id IS NOT DISTINCT FROM CAST\(:base_revision_id AS TEXT\)/);
    expect(sql).toMatch(/INSERT INTO pipeline_run_deck_revisions/);
    expect(sql).not.toContain('prev-0');
  });

  it('a stale base inserts nothing and reports the current head', async () => {
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'pdeck-1', run_id: 'job:1', title: 'T', created_by: null, created_at: 'x', updated_at: 'x', head_revision_id: 'prev-9' }]);
    expect(await pipelineDeckStore.appendRevision(REV)).toEqual({ ok: false, reason: 'conflict', head: 'prev-9' });
  });
});

describe('run report narrative validation', () => {
  const run = {
    id: 'job:1', definitionId: 'bot:x', tenant: 'orgiq', status: 'failed', triggeredBy: null, triggerType: 'manual',
    startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:01:05.000Z', costUsd: 0.5,
    context: { tenant: 'orgiq', kind: 'bot', table: 'agent_jobs', id: '1', sourceStatus: 'failed', sources: [], title: 'Nightly dependency bump', error: 'npm ci exited with code 1' },
  } as unknown as Run;
  const steps: Step[] = [{ runId: 'job:1', stepId: 'execute', label: 'Execute', status: 'failed', startedAt: run.startedAt, finishedAt: run.finishedAt, attempts: [], detail: 'lockfile out of date' }];
  const facts = buildRunDeckFacts({ run, steps, artifacts: [], approvals: [] });

  it('facts state the run numbers; drafter input carries only narrative slides', () => {
    const summary = facts.slides.find((s) => s.slideId === 'summary')!;
    expect(summary.facts).toMatchObject({ stepsTotal: 1, stepsFailed: 1, duration: '1m 05s', costUsd: '$0.5000' });
    expect(buildRunDraftInput(facts).slides.map((s) => s.slideId)).toEqual(['summary', 'failures']);
  });

  it('a verbatim span is used; a non-verbatim span or invented number falls back to the template', () => {
    const good = { slideId: 'failures', bullets: ['The lockfile was out of date.'], source_spans: [{ evidenceId: 'step:execute', text: 'lockfile out of date' }] };
    const badSpan = { slideId: 'summary', bullets: ['Dependency bump failed.'], source_spans: [{ evidenceId: 'step:execute', text: 'the lockfile is stale' }] };
    const badNumber = { slideId: 'failures', bullets: ['It failed 7 times.'], source_spans: [{ evidenceId: 'step:execute', text: 'lockfile out of date' }] };
    const merged = mergeDraft(facts, { narratives: [good, badSpan] });
    expect(merged.templated).toEqual(['summary']);
    expect(merged.spec.slides.find((s) => s.id === 'failures')!.bullets).toContain('The lockfile was out of date.');
    expect(mergeDraft(facts, { narratives: [badNumber] }).templated).toContain('failures');
  });
});
