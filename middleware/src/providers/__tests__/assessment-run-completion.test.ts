// REVIEW-2026-09-05 finding 3, mock path: launchRun's fake 8s setTimeout
// completion must keep working exactly as before, and a local agent
// (`agentcore dev`) must be able to drive the SAME completion via the new
// completeRun() seam (POST /runs/:runId/complete) without double-applying —
// whichever finishes the run first wins, the other gets a clean 409. The
// Aurora callback and worker completion persistence are covered in
// assessment-run-completion-aurora.test.ts, since it needs a different
// config.js mock (`mock.aurora: false`) than this file.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

// Any valid dimension id works here: is_na is false and evidence_class is
// 'observed' (no self-rating cap), so computeScoreEntry accepts it
// regardless of the dimension's current score or exceptions — TEAM-002 and
// TEAM-003 (dimension 10) both carry no exceptions either way.
const TEST_DIMENSION = '10';

function scoringLogEntry(dimensionId: string): M.ScoringLogEntry {
  return {
    dimension_id: dimensionId, is_na: false, suggested_level: 4, confidence: 'high',
    rationale: 'Strong evidence from CI logs.', evidence_excerpts: ['deploy pipeline runs on every merge'],
    follow_up_questions: [], na_claimed: false, self_claimed_level: null, evidence_class: 'observed', cap_applied: false,
  };
}

function freshRun(overrides: Partial<M.MockRun> = {}): M.MockRun {
  return {
    id: `run-test-${Math.random().toString(36).slice(2)}`, command: 'score-dimensions', team_id: 'TEAM-002',
    args: {}, status: 'running', source: 'agent', started_at: new Date().toISOString(), finished_at: null,
    summary: '', error: null, files_written: [], ...overrides,
  };
}

describe('completeRun — mock path', () => {
  it('completes a running run, applies the scoring log through applyScores, and stamps finished_at/summary', async () => {
    const run = freshRun();
    M.runs().unshift(run);
    const dim = TEST_DIMENSION;

    const result = await provider.completeRun(run.id, { status: 'completed', scoring_log: [scoringLogEntry(dim)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('completed');
    expect(result.run.finished_at).toEqual(expect.any(String));
    expect(result.run.summary).toMatch(/Scored \d+ dimensions/);

    const detail = await provider.getTeamDetail('TEAM-002');
    const scored = detail!.dimensions.find((d) => d.id === dim)!;
    expect(scored.current_level).toBe(4);

    expect(M.scoringLogsFor('TEAM-002').some((l) => l.run_id === run.id)).toBe(true);
  });

  it('does not accept success without scoring output', async () => {
    const run = freshRun();
    M.runs().unshift(run);
    const result = await provider.completeRun(run.id, { status: 'completed' });
    expect(result).toEqual({ ok: false, status: 400, reason: expect.stringContaining('scoring_log') });
    expect(run.status).toBe('running');
  });

  it('409s a run that is not (or no longer) running — never double-applies', async () => {
    const run = freshRun({ status: 'completed', finished_at: new Date().toISOString() });
    M.runs().unshift(run);

    const result = await provider.completeRun(run.id, { status: 'completed' });
    expect(result).toEqual({ ok: false, status: 409, reason: expect.stringMatching(/already completed/) });
  });

  it('404s an unknown run id', async () => {
    const result = await provider.completeRun('run-does-not-exist', { status: 'completed' });
    expect(result).toEqual({ ok: false, status: 404, reason: expect.any(String) });
  });

  it('a failed callback records the error and summary without touching scores', async () => {
    const run = freshRun();
    M.runs().unshift(run);

    const result = await provider.completeRun(run.id, { status: 'failed', error: 'agent crashed mid-run' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toBe('agent crashed mid-run');
  });

  it('two completion callbacks racing the same run: the second is a clean 409, not a double-apply (mirrors the fake-timer-vs-callback race)', async () => {
    const run = freshRun({ team_id: 'TEAM-003' });
    M.runs().unshift(run);
    const dim = TEST_DIMENSION;

    const [first, second] = await Promise.all([
      provider.completeRun(run.id, { status: 'completed', scoring_log: [scoringLogEntry(dim)] }),
      provider.completeRun(run.id, { status: 'completed', scoring_log: [scoringLogEntry(dim)] }),
    ]);
    const oks = [first, second].filter((r) => r.ok).length;
    const conflicts = [first, second].filter((r) => !r.ok && r.status === 409).length;
    expect(oks).toBe(1);
    expect(conflicts).toBe(1);
  });
});

it('attributes completion to the launch-time submission, never whichever arrived latest', async () => {
  const selected = M.submissionsFor('TEAM-002')[0]!;
  const run = freshRun({ args: { submission: selected.envelope_id } });
  M.runs().unshift(run);
  const result = await provider.completeRun(run.id, { status: 'completed', scoring_log: [scoringLogEntry(selected.dimension_hints[0]!.dimension_id)] });
  expect(result.ok).toBe(true);
  expect(M.scoringLogsFor('TEAM-002').find(log => log.run_id === run.id)?.envelope_id).toBe(selected.envelope_id);
  const unscoped = freshRun({ args: {} });
  M.runs().unshift(unscoped);
  await provider.completeRun(unscoped.id, { status: 'completed', scoring_log: [scoringLogEntry(TEST_DIMENSION)] });
  expect(M.scoringLogsFor('TEAM-002').find(log => log.run_id === unscoped.id)?.envelope_id).toBeNull();
});

it('rejects scores outside the selected submission before completing the run', async () => {
  const selected = M.submissionsFor('TEAM-002')[0]!;
  const outside = M.DIMENSION_IDS.find(id => !selected.dimension_hints.some(h => h.dimension_id === id))!;
  expect(outside).toBeDefined();
  const run = freshRun({ args: { submission: selected.envelope_id } });
  M.runs().unshift(run);
  const result = await provider.completeRun(run.id, { status: 'completed', scoring_log: [scoringLogEntry(outside)] });
  expect(result).toEqual({ ok: false, status: 400, reason: expect.any(String) });
  expect(run.status).toBe('running');
  expect(M.scoringLogsFor('TEAM-002').some(log => log.run_id === run.id)).toBe(false);
});

it('preserves a scorer N/A claim as a pending exception without granting exemption', async () => {
  const run = freshRun({ team_id: 'TEAM-003' });
  M.runs().unshift(run);
  const entry = { ...scoringLogEntry('6'), is_na: false, na_claimed: true, suggested_level: null };
  const result = await provider.completeRun(run.id, { status: 'completed', scoring_log: [entry] });
  expect(result.ok).toBe(true);
  const team = M.teams().find(t => t.id === 'TEAM-003')!;
  expect(team.exceptions).toContainEqual(expect.objectContaining({ dimension_id: '6', status: 'requested' }));
  expect(M.scoresFor(team.id)!['6']!.is_na).toBe(false);
});
