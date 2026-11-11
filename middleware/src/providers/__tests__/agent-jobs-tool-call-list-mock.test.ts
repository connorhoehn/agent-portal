// `deriveToolCallList`/`withToolCallList` in mock mode (config.mock.aurora
// true) — providers/agent-jobs.ts.
//
// What is pinned:
//   * a real transcript (even in mock mode — a dispatched job's own history)
//     wins over any fallback and reports every call as done,
//   * with no transcript, the mock-only fallback derives a deterministic,
//     kind-keyed list sized to the job's own toolCalls count — never a
//     number invented independent of the row,
//   * a job with no toolCalls count, or a count of 0, reports no list at all
//     rather than an empty-but-present one,
//   * `withToolCallList` attaches the list onto `result` without mutating the
//     job it was handed, and leaves a job with no result alone.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { deriveToolCallList, withToolCallList, type AgentJob } from '../agent-jobs.js';

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job-1', kind: 'devbox:task', title: 'Bump a dependency', payload: {},
    status: 'awaiting_review', priority: 100, boxId: 'box-a', sessionId: 'sess-a',
    attempts: 1, maxAttempts: 2, result: null, error: null, createdBy: 'portal',
    createdAt: '2026-03-01T00:00:00.000Z', claimedAt: null, startedAt: null, finishedAt: null,
    botId: null, botName: null, botTrigger: null,
    ...overrides,
  };
}

describe('deriveToolCallList — mock mode', () => {
  it('reports no list for a job with no result', () => {
    expect(deriveToolCallList(job({ result: null }))).toBeUndefined();
  });

  it('reads a real transcript verbatim, every call marked done', () => {
    const j = job({
      result: {
        toolCalls: 2,
        transcript: [
          { t: 'text', detail: 'Looking at the lockfile.', ts: '2026-03-01T00:00:01.000Z' },
          { t: 'tool', name: 'Bash', detail: 'npm audit --json', ts: '2026-03-01T00:00:02.000Z' },
          { t: 'tool', name: 'Edit', detail: 'package.json', ts: '2026-03-01T00:00:03.000Z' },
        ],
      },
    });
    expect(deriveToolCallList(j)).toEqual([
      { name: 'Bash', done: true },
      { name: 'Edit', done: true },
    ]);
  });

  it('falls back to a kind-keyed cycle sized to toolCalls when the transcript is empty', () => {
    const j = job({ kind: 'devbox:task', result: { toolCalls: 4, transcript: [] } });
    expect(deriveToolCallList(j)).toEqual([
      { name: 'read_file', done: true },
      { name: 'edit_file', done: true },
      { name: 'run_tests', done: true },
      { name: 'git_commit', done: true },
    ]);
  });

  it('cycles the kind list when toolCalls exceeds its length', () => {
    const j = job({ kind: 'devbox:task', result: { toolCalls: 5, transcript: [] } });
    expect(deriveToolCallList(j)?.map((c) => c.name)).toEqual([
      'read_file', 'edit_file', 'run_tests', 'git_commit', 'read_file',
    ]);
  });

  it('reports no list when toolCalls is absent, zero, or not a number', () => {
    expect(deriveToolCallList(job({ result: { summary: 'done' } }))).toBeUndefined();
    expect(deriveToolCallList(job({ result: { toolCalls: 0 } }))).toBeUndefined();
    expect(deriveToolCallList(job({ result: { toolCalls: 'lots' } }))).toBeUndefined();
  });
});

describe('withToolCallList', () => {
  it('attaches toolCallList onto result without touching the rest of it', () => {
    const j = job({ result: { summary: 'ok', costUsd: 0.12, toolCalls: 1, transcript: [] } });
    const wired = withToolCallList(j);
    expect(wired.result).toEqual({
      summary: 'ok', costUsd: 0.12, toolCalls: 1, transcript: [],
      toolCallList: [{ name: 'read_file', done: true }],
    });
    // The input job is untouched — this is a read-time projection.
    expect(j.result).toEqual({ summary: 'ok', costUsd: 0.12, toolCalls: 1, transcript: [] });
  });

  it('passes a job with no derivable list through unchanged', () => {
    const j = job({ result: { summary: 'ok' } });
    expect(withToolCallList(j)).toBe(j);
  });

  it('passes a job with no result through unchanged', () => {
    const j = job({ result: null });
    expect(withToolCallList(j)).toBe(j);
  });
});
