// DE-43: a captured change records who caused it. dispatchGovernedRun stamps
// the run row's dispatched_by and hands the requester to captureAndGate,
// which writes it onto the change. Every collaborator is mocked; the subject
// is the plumbing between the dispatch and createChangeRequest.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } } }));
jest.mock('../devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(async () => 'arn:devbox'), devboxDataClient: jest.fn(() => ({})) }));
jest.mock('../devbox-fleet.js', () => ({
  registerBox: jest.fn(() => ({ id: 'box-1' })), getBoxBySession: jest.fn(() => null),
  appendEvent: jest.fn(), reserveBox: jest.fn(), releaseBox: jest.fn(), setBoxProfile: jest.fn(),
}));
jest.mock('../run-brief.js', () => ({ freezeBrief: jest.fn(async () => { throw new Error('no brief here'); }), labRunContext: jest.fn() }));
jest.mock('../change-reviewer.js', () => ({ reviewDiff: jest.fn(async () => ({ model: 'm', verdict: 'approve', summary: null, findings: [] })) }));
jest.mock('../change-delivery.js', () => ({ deliverChange: jest.fn() }));
jest.mock('../delivery-guard.js', () => ({ deliveryBlockReason: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn(async () => null), updateWorkItem: jest.fn() }));
jest.mock('../project-runner.js', () => ({
  // The run "changes a file": onChanged fires, then capture asks git.
  executeProjectRun: jest.fn(async (opts: { onChanged: () => void }) => { opts.onChanged(); }),
  runDevboxShell: jest.fn(async (_c: unknown, _a: string, _s: string, cmd: string) =>
    (cmd.includes('status --porcelain') ? ' M src/a.ts\n' : cmd.includes('rev-parse HEAD') ? 'a'.repeat(40) : 'diff --git a/src/a.ts b/src/a.ts\n')),
}));
jest.mock('../../providers/agent-projects.js', () => ({
  startRun: jest.fn(async () => ({ id: 'run-1' })), checkoutPath: jest.fn(() => '/mnt/workspace/repo'),
}));
jest.mock('../../providers/sdlc.js', () => ({
  createChangeRequest: jest.fn(async (input: { title: string }) => ({ id: 'cr-1', title: input.title, diffTruncated: false })),
  setCommitSha: jest.fn(), markInReview: jest.fn(), recordReview: jest.fn(),
  evaluateChange: jest.fn(async () => ({ status: 'needs_approval' })), markFailed: jest.fn(),
  getChangeRequest: jest.fn(), markDelivering: jest.fn(), markDelivered: jest.fn(), hasNewerChangeForProject: jest.fn(),
}));

import { dispatchGovernedRun } from '../sdlc-pipeline.js';
import { createChangeRequest } from '../../providers/sdlc.js';
import { startRun, type AgentProject } from '../../providers/agent-projects.js';

const PROJECT = { id: 'ap-1', orgProjectId: 'p-obs', repoFullName: 'o/r' } as unknown as AgentProject;

// The budget reads are not mocked here and are not the subject; the thin config
// mock cannot serve a dispatcher's envelope or user budget. Unset, the brake
// fails closed (lib/budget-decisions.ts), so this suite opts out explicitly.
const priorBudgetFlag = process.env['BUDGET_FAIL_CLOSED'];
beforeAll(() => { process.env['BUDGET_FAIL_CLOSED'] = '0'; });
afterAll(() => {
  if (priorBudgetFlag === undefined) delete process.env['BUDGET_FAIL_CLOSED'];
  else process.env['BUDGET_FAIL_CLOSED'] = priorBudgetFlag;
});
const settle = () => new Promise((r) => setImmediate(r));

async function requesterOf(input: Partial<Parameters<typeof dispatchGovernedRun>[0]>): Promise<unknown> {
  (createChangeRequest as jest.Mock).mockClear();
  (startRun as jest.Mock).mockClear();
  const out = await dispatchGovernedRun({ project: PROJECT, prompt: 'fix it', sessionId: 'sess-1', ...input });
  expect(out.ok).toBe(true);
  for (let i = 0; i < 10; i++) await settle();
  expect(createChangeRequest).toHaveBeenCalledTimes(1);
  return ((createChangeRequest as jest.Mock).mock.calls[0]![0] as { requestedBy?: unknown }).requestedBy;
}

describe('the change records who caused it (DE-43)', () => {
  it('an ad-hoc run: the session sub that dispatched it, also stamped on the run row', async () => {
    expect(await requesterOf({ dispatchedBy: 'u-eli' })).toBe('u-eli');
    expect((startRun as jest.Mock).mock.calls[0]![0]).toMatchObject({ dispatchedBy: 'u-eli' });
  });

  it('a bot run pressed by someone: the dispatcher', async () => {
    expect(await requesterOf({ dispatchedBy: 'u-layla', requestedBy: 'u-layla' })).toBe('u-layla');
  });

  it('a cron bot run: the bot\'s creator, while the run row records no dispatcher', async () => {
    expect(await requesterOf({ requestedBy: 'u-nora' })).toBe('u-nora');
    expect((startRun as jest.Mock).mock.calls[0]![0]).not.toHaveProperty('dispatchedBy');
  });

  it('nobody known: null, which only org-wide roles may approve', async () => {
    expect(await requesterOf({})).toBeNull();
  });
});
