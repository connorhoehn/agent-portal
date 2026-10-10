// The /agent `approval` step (slice 10, HITL): the loop pauses durably at the step, survives a restart without
// re-running earlier steps, resumes as the APPROVER's fresh session, ends on Reject or after 24 h, and each
// decision is once-only per requestId. Real flow-runs store (mock fixture), real dispatcher.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } } }));
jest.mock('../../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../live-principal.js', () => ({ currentLiveSession: jest.fn() }));

import { AppError } from '../../async-handler.js';
import { currentLiveSession } from '../../live-principal.js';
import { agentPlansFixture } from '../../../mock/agent-plans.js';
import { flowRunsFixture } from '../../../mock/flow-runs.js';
import { freezeClock, unfreezeClock } from '../../../mock/core/clock.js';
import { dispatchFlowRuns, emitFlowRunMove, flowRunStore, onFlowRunMove, pendingFlowRuns, type FlowRunMove } from '../../flow-runs/index.js';
import { agentStage, agentStatus, defineAgentFlow, setStepDispatcher, type AgentResult } from '../index.js';
import { acceptPlan, allowedKinds } from '../plan.js';
import type { Session } from '../../session.js';

const sessionOf = (sub: string, epoch = 3): Session => ({ sub, tenant: 'orgiq', role: 'sme', epoch, iat: 5, grants: {} }) as unknown as Session;
const requester = sessionOf('u-1');
const STEP = (kind: string) => ({ kind, title: `T-${kind}`, instruction: kind === 'approval' ? 'Draft the page?' : '', acceptance: 'Done.' });
const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const tick = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms));
const SCOPE = 'orgiq:initiative:p-auth';
const T0 = Date.parse('2026-10-06T12:00:00.000Z');
let started: Array<{ kind: string; sub: string }>;
const flow = defineAgentFlow({ tenant: 'orgiq', kind: 'orgiq.agent', idPrefix: 'oag', agentAuth: true });

async function approvedPlan(kinds: string[]) {
  agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'S', steps: kinds.map(STEP) as never });
  const run = await flow.startRun({ userId: 'u-1', channel: SCOPE, goal: 'g', lines: [] });
  await settle();
  const planned = (await flowRunStore.get(run.id))!;
  expect(await flow.approve(planned, requester, 'req-plan-0001')).toBe('started');
  await settle();
  return run.id;
}
const get = async (id: string) => (await flowRunStore.get(id))!;

beforeEach(() => {
  flowRunsFixture.reset(); agentPlansFixture.reset(); started = [];
  freezeClock(new Date(T0));
  // Fresh authority: every session proves itself unless a test says otherwise.
  jest.mocked(currentLiveSession).mockReset().mockImplementation(async s => s);
  setStepDispatcher(async (session, _t, _c, st) => {
    started.push({ kind: st.kind, sub: session.sub });
    const child = await flowRunStore.create({ tenant: 'orgiq', kind: `orgiq.${st.kind === 'summarize' ? 'summarize' : st.kind}`, requestedBy: session.sub, scope: SCOPE, input: null });
    await flowRunStore.claim({ kinds: [child.kind], owner: 'child', leaseMs: 10_000_000, id: child.id });
    await flowRunStore.finish(child.id, 'child', { status: 'completed', result: { summary: `did ${st.kind}` } });
    return { kind: st.kind === 'summarize' ? 'summary' : (st.kind as 'doc'), runId: child.id };
  });
});
afterEach(() => { unfreezeClock(); setStepDispatcher(null); });

describe('plan rules', () => {
  const raw = (kinds: string[]) => ({ summary: 's', steps: kinds.map(STEP) });
  it('keeps an approval that gates a later step; one with nothing after it replaces the plan', () => {
    expect(acceptPlan(raw(['summarize', 'approval', 'doc']), 'g', allowedKinds('social'))?.steps.map(s => s.kind)).toEqual(['summarize', 'approval', 'doc']);
    expect(acceptPlan(raw(['summarize', 'approval']), 'g', allowedKinds('orgiq'))).toBeNull();
    for (const t of ['social', 'orgiq', 'assessment', 'pipelines'] as const) expect(allowedKinds(t)).toContain('approval');
  });
});

describe('the pause', () => {
  it('stops at the approval durably: waiting-approval, lease released, cursor on the step, earlier step ran once, a restart changes nothing', async () => {
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    const run = await get(id);
    expect(run.status).toBe('waiting-approval');
    expect(run.leaseOwner).toBeNull();
    expect(run.progress.map(s => s.status)).toEqual(['completed', 'running', 'pending']);
    expect(run.progress[1]!.detail).toBe('Draft the page?');
    expect(started.map(s => s.kind)).toEqual(['summarize']);
    expect(agentStage(run)).toBe('waiting-approval');
    expect(agentStatus(run)).toMatchObject({ stage: 'waiting-approval', approval: { stepId: 's2', question: 'Draft the page?' } });
    // A restart: the dispatcher of a fresh node ticks well inside the 24 h window. Nothing re-runs.
    unfreezeClock(); freezeClock(new Date(T0 + 60 * 60_000));
    await dispatchFlowRuns('node-B'); await tick(50); await settle();
    const after = await get(id);
    expect(after.status).toBe('waiting-approval');
    expect(started.map(s => s.kind)).toEqual(['summarize']);
    expect(after.progress).toEqual(run.progress);
  });

  it('tells the requester-private channel: one waiting move with the cursor step', async () => {
    const moves: FlowRunMove[] = [];
    const off = onFlowRunMove(m => { moves.push(m); });
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    off();
    expect(moves.filter(m => m.runId === id).map(m => m.kind)).toContain('waiting');
    expect(moves.find(m => m.kind === 'waiting')?.steps?.[1]?.status).toBe('running');
    emitFlowRunMove({ runId: 'x', kind: 'waiting' }); // no listener: harmless
  });
});

describe('Approve', () => {
  it('resumes from the NEXT step as the approver\'s fresh session; the earlier step is not run again', async () => {
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    const approver = sessionOf('u-2', 7);
    expect(await flow.decideApproval(await get(id), approver, { verb: 'approve', requestId: 'ap-12345678' })).toBe('started');
    await settle();
    const done = await get(id);
    expect(agentStage(done)).toBe('done');
    expect(started).toEqual([{ kind: 'summarize', sub: 'u-1' }, { kind: 'doc', sub: 'u-2' }]);
    expect(done.progress.map(s => s.status)).toEqual(['completed', 'completed', 'completed']);
    expect(done.progress[1]!.detail).toContain('Approved by u-2');
    expect(done.attempts).toBe(1);
  });

  it('is once-only and idempotent per requestId; a later Reject loses', async () => {
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    const r = await get(id);
    expect(await flow.decideApproval(r, requester, { verb: 'approve', requestId: 'ap-12345678' })).toBe('started');
    expect(await flow.decideApproval(await get(id), requester, { verb: 'approve', requestId: 'ap-12345678' })).toBe('repeat');
    expect(await flow.decideApproval(await get(id), requester, { verb: 'reject', requestId: 'ap-other-999' })).toBe(false);
    await settle();
    expect(started.filter(s => s.kind === 'doc')).toHaveLength(1);
    expect(await flow.decideApproval(await get(id), requester, { verb: 'reject', requestId: 'ap-other-999' })).toBe(false);
  });

  it('a moved epoch or lost grant at resume fails closed: authorization-unavailable (403), nothing after the gate starts', async () => {
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    jest.mocked(currentLiveSession).mockReset().mockRejectedValue(new AppError(401, 'The session is no longer current. Sign in again.'));
    expect(await flow.decideApproval(await get(id), sessionOf('u-2'), { verb: 'approve', requestId: 'ap-12345678' })).toBe('started');
    await settle();
    const out = await get(id);
    expect(started.map(s => s.kind)).toEqual(['summarize']);
    expect(agentStage(out)).toBe('stopped');
    expect((out.result as AgentResult).errorCode).toBe('authorization-unavailable');
    expect(agentStatus(out)).toMatchObject({ phase: 'failed', error: expect.stringContaining('403') });
  });
});

describe('Reject and expiry', () => {
  it('Reject ends the loop with the reason on the card; later steps never start', async () => {
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    expect(await flow.decideApproval(await get(id), requester, { verb: 'reject', requestId: 'ap-12345678', reason: 'Not yet' })).toBe('started');
    await settle();
    const out = await get(id);
    expect(started.map(s => s.kind)).toEqual(['summarize']);
    expect(agentStage(out)).toBe('stopped');
    expect((out.result as AgentResult).rejected).toBe(true);
    expect(agentStatus(out)).toMatchObject({ phase: 'failed', error: expect.stringContaining('rejected by u-1: Not yet') });
    expect(out.progress.map(s => s.status)).toEqual(['completed', 'failed', 'pending']);
    expect(out.input).toBeNull();
  });

  it('a pause older than 24 h expires with a visible note; one inside the window does not', async () => {
    const id = await approvedPlan(['summarize', 'approval', 'doc']);
    unfreezeClock(); freezeClock(new Date(T0 + 23 * 3600_000));
    await dispatchFlowRuns('node-B'); await settle();
    expect((await get(id)).status).toBe('waiting-approval');
    unfreezeClock(); freezeClock(new Date(T0 + 25 * 3600_000));
    await dispatchFlowRuns('node-B'); await settle();
    const out = await get(id);
    expect(agentStage(out)).toBe('stopped');
    expect((out.result as AgentResult).expired).toBe(true);
    expect(agentStatus(out)).toMatchObject({ error: expect.stringContaining('nobody answered within 24 hours') });
    expect(started.map(s => s.kind)).toEqual(['summarize']);
    // The decision came too late.
    expect(await flow.decideApproval(out, requester, { verb: 'approve', requestId: 'ap-12345678' })).toBe(false);
  });
});
