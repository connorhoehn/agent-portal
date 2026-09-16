// `deriveToolCallList` in Aurora mode (config.mock.aurora false) —
// providers/agent-jobs.ts.
//
// What is pinned: a real transcript is still read verbatim (the same code
// path as mock mode — this is genuinely stored `result` JSON, not a mock
// concern), but the kind-keyed fallback is Aurora's one hard line: a live row
// that reports a toolCalls COUNT with no transcript genuinely does not know
// the call names, and inventing them would misrepresent a real run. That case
// reports undefined, not a guess.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { deriveToolCallList, type AgentJob } from '../agent-jobs.js';

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

describe('deriveToolCallList — Aurora mode', () => {
  it('reads a real transcript verbatim, exactly as mock mode does', () => {
    const j = job({
      result: {
        transcript: [
          { t: 'tool', name: 'Grep', detail: 'serialize-javascript', ts: '2026-03-01T00:00:01.000Z' },
          { t: 'text', detail: 'Reachable from one place only.', ts: '2026-03-01T00:00:02.000Z' },
        ],
      },
    });
    expect(deriveToolCallList(j)).toEqual([{ name: 'Grep', done: true }]);
  });

  it('reports undefined for a real row with a toolCalls count but no transcript — never a fabricated name', () => {
    const j = job({ result: { toolCalls: 6, costUsd: 0.11 } });
    expect(deriveToolCallList(j)).toBeUndefined();
  });

  it('reports undefined for a real row with an empty transcript array too', () => {
    const j = job({ result: { toolCalls: 3, transcript: [] } });
    expect(deriveToolCallList(j)).toBeUndefined();
  });
});
