// REVIEW-2026-09-05 finding 3, Aurora path: this is the actual defect fix —
// on the real (non-mock) branch nothing but the operator-initiated /stop
// ever called A.updateRunStatus, so a launched run stayed 'running' forever
// and RUN_CONCURRENCY_CAP (3) permanently exhausted after three real runs.
// completeRun's `!config.mock.aurora` branch is what POST /runs/:runId/complete
// calls in production. `exec` is stubbed (no reachable Aurora cluster here,
// same convention as assessment-aurora.test.ts) — this asserts the actual
// SQL/orchestration: fetchRun -> (score-applying command with a scoring_log)
// insertScoringLog + applyScores -> updateRunStatus, or straight to
// updateRunStatus for a non-scoring command / a failure.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false }, auth: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));

import { exec } from '../aurora.js';
import * as provider from '../assessment.js';
import type * as M from '../../mock/assessment.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => execMock.mockReset());

const RUN_ROW = {
  id: 'run-20260905T000000Z-score-dimensions-abc123', command: 'score-dimensions', team_id: 'TEAM-002',
  args: '{}', status: 'running', source: 'agent', started_at: '2026-09-05T00:00:00Z',
  finished_at: null, summary: '', error: null, files_written: [] as string[],
};

const NON_SCORING_RUN_ROW = { ...RUN_ROW, id: 'run-x', command: 'draft-confluence-page' };

function scoreEntry(): M.ScoringLogEntry {
  return {
    dimension_id: '10', is_na: false, suggested_level: 4, confidence: 'high',
    rationale: 'Strong CI evidence.', evidence_excerpts: ['pipeline runs on every merge'],
    follow_up_questions: [], na_claimed: false, self_claimed_level: null, evidence_class: 'observed', cap_applied: false,
  };
}

describe('completeRun — Aurora path (finding 3: the ONLY way a real run leaves "running")', () => {
  it('404s an unknown run without ever calling updateRunStatus', async () => {
    execMock.mockResolvedValueOnce([]); // fetchRun -> not found
    const result = await provider.completeRun('run-missing', { status: 'completed' });
    expect(result).toEqual({ ok: false, status: 404, reason: expect.any(String) });
  });

  it('409s a run that already left "running" — never double-applies', async () => {
    execMock.mockResolvedValueOnce([{ ...RUN_ROW, status: 'completed' }]);
    const result = await provider.completeRun(RUN_ROW.id, { status: 'completed' });
    expect(result).toEqual({ ok: false, status: 409, reason: expect.stringMatching(/already completed/) });
  });

  it('a score-applying command with a scoring_log inserts the log, applies it, and marks the run completed', async () => {
    execMock
      .mockResolvedValueOnce([RUN_ROW])       // fetchRun
      .mockResolvedValueOnce([])               // fetchSubmissionsForTeam
      .mockResolvedValueOnce([])               // insertScoringLog
      // auroraApplyScores: fetchTeam (team + exceptions) + fetchDimensionScores (4 queries) + writes
      .mockResolvedValueOnce([{ id: 'TEAM-002', name: 'T', cohort: 'general', status: 'ACTIVE', workflow_step: 1, assessment_lead: '', contacts: [], repos: '[]', contributors: '[]', archetype: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }])
      .mockResolvedValueOnce([]) // exceptions
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]) // fetchDimensionScores (4 queries)
      .mockResolvedValue([]); // every remaining write (score upsert, history, touchTeamUpdatedAt, updateRunStatus)

    const result = await provider.completeRun(RUN_ROW.id, { status: 'completed', scoring_log: [scoreEntry()] });
    expect(result.ok).toBe(true);

    const sqlCalls = execMock.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => /INSERT INTO assessment_scoring_logs/.test(s))).toBe(true);
    expect(sqlCalls.some((s) => /INSERT INTO assessment_dimension_scores|UPDATE assessment_dimension_scores/.test(s))).toBe(true);
    expect(sqlCalls.some((s) => /UPDATE assessment_runs SET status/.test(s))).toBe(true);
    const runUpdateCall = execMock.mock.calls.find((c) => /UPDATE assessment_runs SET status/.test(c[0] as string))!;
    const params = runUpdateCall[1] as Array<{ name: string; value: unknown }>;
    expect(params).toContainEqual({ name: 'status', value: { stringValue: 'completed' } });
  });

  it('a non-score-applying command completes without touching scoring logs or dimension scores', async () => {
    execMock
      .mockResolvedValueOnce([NON_SCORING_RUN_ROW]) // fetchRun
      .mockResolvedValueOnce([]); // updateRunStatus

    const result = await provider.completeRun(NON_SCORING_RUN_ROW.id, { status: 'completed', summary: 'Drafted the page.' });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[1]![0] as string).toMatch(/UPDATE assessment_runs SET status/);
  });

  it('a failure callback records the error and never applies scores even with a scoring_log present', async () => {
    execMock
      .mockResolvedValueOnce([RUN_ROW]) // fetchRun
      .mockResolvedValueOnce([]); // updateRunStatus

    const result = await provider.completeRun(RUN_ROW.id, { status: 'failed', error: 'sandbox OOM', scoring_log: [scoreEntry()] });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2); // fetchRun + updateRunStatus only — no scoring log insert/apply
    const params = execMock.mock.calls[1]![1] as Array<{ name: string; value: unknown }>;
    expect(params).toContainEqual({ name: 'error', value: { stringValue: 'sandbox OOM' } });
  });
});
