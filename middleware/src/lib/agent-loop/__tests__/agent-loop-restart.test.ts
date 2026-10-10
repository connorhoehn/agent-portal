// The /agent loop survives its node (slice 10): kill the executor mid-step, a second node
// re-claims the lapsed lease and resumes exactly once; a revoked requester does not resume.
// Real flow-runs store (the registered mock fixture), real dispatcher and lease expiry.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } } }));
jest.mock('../../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../live-principal.js', () => ({ currentLiveSession: jest.fn() }));

import { AppError } from '../../async-handler.js';
import { currentLiveSession } from '../../live-principal.js';
import { agentPlansFixture } from '../../../mock/agent-plans.js';
import { flowRunsFixture } from '../../../mock/flow-runs.js';
import { freezeClock, unfreezeClock } from '../../../mock/core/clock.js';
import { dispatchFlowRuns, flowRunStore, pendingFlowRuns } from '../../flow-runs/index.js';
import { agentStage, agentStatus, defineAgentFlow, setStepDispatcher, type AgentResult, type StepCreated } from '../index.js';
import type { Session } from '../../session.js';

const session = { sub: 'u-1', tenant: 'orgiq', role: 'sme', epoch: 3, iat: 5, grants: {} } as unknown as Session;
const STEP = (kind: string) => ({ kind, title: `T-${kind}`, instruction: '', acceptance: 'Done.' });
const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const tick = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms));
const SCOPE = 'orgiq:initiative:p-auth';
const DOC_SCOPE = 'assessment:doc:d-1';
const T0 = Date.parse('2026-10-06T12:00:00.000Z');

let started: string[];
async function plan(kinds: string[], tenant: 'orgiq' | 'assessment' = 'orgiq') {
  agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'S', steps: kinds.map(STEP) as never });
  const flow = tenant === 'orgiq' ? defineAgentFlow({ tenant: 'orgiq', kind: 'orgiq.agent', idPrefix: 'oag', agentAuth: true })
    : defineAgentFlow({ tenant: 'assessment', kind: 'assessment.agent', idPrefix: 'aag', agentAuth: true });
  const run = await flow.startRun({ userId: 'u-1', channel: tenant === 'orgiq' ? SCOPE : DOC_SCOPE, goal: 'g', lines: [] });
  await settle();
  return { flow, run: (await flowRunStore.get(run.id))! };
}
/** A child flow run that stays running until the test finishes it. */
async function openChild(kind: string): Promise<string> {
  const child = await flowRunStore.create({ tenant: 'orgiq', kind: `orgiq.${kind}`, requestedBy: 'u-1', scope: SCOPE, input: null });
  await flowRunStore.claim({ kinds: [child.kind], owner: 'child', leaseMs: 10_000_000, id: child.id });
  return child.id;
}
const finishChild = (id: string, summary: string) => flowRunStore.finish(id, 'child', { status: 'completed', result: { summary } });

beforeEach(() => {
  flowRunsFixture.reset(); agentPlansFixture.reset(); started = [];
  jest.mocked(currentLiveSession).mockReset().mockResolvedValue(session);
  freezeClock(new Date(T0));
});
afterEach(() => { unfreezeClock(); setStepDispatcher(null); });

describe('a restart mid-loop', () => {
  it('re-claims the lapsed lease and resumes exactly once: the running step is followed, never restarted', async () => {
    const { flow, run } = await plan(['summarize', 'diagram', 'doc']);
    const children: Record<string, string> = {};
    setStepDispatcher(async (_s, _t, _c, st) => {
      started.push(st.kind);
      children[st.kind] = await openChild(st.kind === 'summarize' ? 'summarize' : st.kind);
      return { kind: st.kind === 'summarize' ? 'summary' : (st.kind as 'diagram' | 'doc'), runId: children[st.kind]! };
    });
    await flow.approve(run, session, 'req-12345678');
    await tick();
    // Node A is now waiting on step 1's child. It dies: its lease lapses.
    expect(started).toEqual(['summarize']);
    const mid = (await flowRunStore.get(run.id))!;
    expect(mid.status).toBe('running');
    expect(mid.progress[0]).toMatchObject({ status: 'running', ref: { runId: children['summarize'] } });
    expect(mid.input).toMatchObject({ phase: 'execute', actor: { sub: 'u-1', epoch: 3 } });
    expect(JSON.stringify(mid.input)).not.toMatch(/grants|cookie/i);
    unfreezeClock(); freezeClock(new Date(T0 + 5 * 60_000));
    await finishChild(children['summarize']!, 'did summarize');
    await dispatchFlowRuns('node-B');   // expireLeases requeues (attempts 1 < 5), node B claims
    await tick(300);
    expect(started).toEqual(['summarize', 'diagram']); // step 1 NOT started again, step 2 started once
    await finishChild(children['diagram']!, 'did diagram');
    await tick(300);
    await finishChild(children['doc']!, 'did doc').catch(() => undefined);
    await tick(300);
    await finishChild(children['doc'] ?? '', 'did doc').catch(() => undefined);
    await settle();
    const done = (await flowRunStore.get(run.id))!;
    expect(started).toEqual(['summarize', 'diagram', 'doc']);
    expect(agentStage(done)).toBe('done');
    expect(done.progress.map(s => s.status)).toEqual(['completed', 'completed', 'completed']);
    expect(done.attempts).toBe(2);
    expect(done.input).toBeNull();
    // Node A, still alive in this test, is fenced: it can neither report nor finish.
    expect(await flowRunStore.progress(run.id, 'node-A', null, 1000)).toBe(false);
  });

  it('a revoked requester does not resume: failed closed with authorization-unavailable (403) and nothing started', async () => {
    const { flow, run } = await plan(['summarize', 'diagram']);
    setStepDispatcher(async (_s, _t, _c, st) => { started.push(st.kind); return { kind: 'summary', runId: await openChild(st.kind) }; });
    await flow.approve(run, session, 'req-12345678');
    await tick();
    expect(started).toEqual(['summarize']);
    unfreezeClock(); freezeClock(new Date(T0 + 5 * 60_000));
    jest.mocked(currentLiveSession).mockReset().mockRejectedValue(new AppError(401, 'The session is no longer current. Sign in again.'));
    await dispatchFlowRuns('node-B');
    await tick(100);
    const out = (await flowRunStore.get(run.id))!;
    expect(started).toEqual(['summarize']);
    expect(agentStage(out)).toBe('stopped');
    expect((out.result as AgentResult).errorCode).toBe('authorization-unavailable');
    expect(agentStatus(out)).toMatchObject({ phase: 'failed', errorCode: 'authorization-unavailable', error: expect.stringContaining('403') });
    expect(out.progress[0]!.status).toBe('failed');
  });

  it('Approve is idempotent per requestId, and Discard after Approve cancels at the next step boundary', async () => {
    const { flow, run } = await plan(['summarize', 'diagram']);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    setStepDispatcher(async (_s, _t, _c, st) => {
      started.push(st.kind);
      const id = await openChild(st.kind);
      void gate.then(() => finishChild(id, 'ok'));
      return { kind: 'summary', runId: id };
    });
    expect(await flow.approve(run, session, 'req-12345678')).toBe('started');
    const again = (await flowRunStore.get(run.id))!;
    expect(await flow.approve(again, session, 'req-12345678')).toBe('repeat');
    expect(await flow.approve(again, session, 'req-other-777')).toBe(false);
    await tick();
    expect(await flow.discard((await flowRunStore.get(run.id))!)).toBe(true);
    release();
    await settle();
    const out = (await flowRunStore.get(run.id))!;
    expect(started).toEqual(['summarize']);
    expect(agentStage(out)).toBe('discarded');
    expect(out.progress.map(s => s.status)).toEqual(['completed', 'pending']);
  });
});

describe('a restart around the creation steps (document:create, meeting:create)', () => {
  const made = (kind: string): StepCreated => kind === 'document:create'
    ? { kind: 'created', detail: 'Created the document.', link: { kind: 'document', label: 'Notes', href: '/assessment/workspace?doc=draft%3A1' } }
    : { kind: 'created', detail: 'The huddle lobby is ready.', link: { kind: 'huddle', label: 'Kickoff', lobbyName: DOC_SCOPE } };

  it('a node lost while a flow step runs: the creation steps run once each on node B, each holding its link', async () => {
    const { flow, run } = await plan(['summarize', 'document:create', 'meeting:create'], 'assessment');
    let child = '';
    setStepDispatcher(async (_s, _t, _c, st) => {
      started.push(st.kind);
      if (st.kind === 'summarize') { child = await openChild('summarize'); return { kind: 'summary', runId: child }; }
      return made(st.kind);
    });
    await flow.approve(run, session, 'req-12345678');
    await tick();
    expect(started).toEqual(['summarize']);
    unfreezeClock(); freezeClock(new Date(T0 + 5 * 60_000));
    await finishChild(child, 'did summarize');
    await dispatchFlowRuns('node-B');
    await tick(300); await settle();
    const done = (await flowRunStore.get(run.id))!;
    expect(started).toEqual(['summarize', 'document:create', 'meeting:create']);
    expect(agentStage(done)).toBe('done');
    expect(done.progress[1]).toMatchObject({ status: 'completed', link: { kind: 'document' } });
    expect(done.progress[1]!.ref).toBeUndefined();
    expect(done.progress[2]).toMatchObject({ status: 'completed', link: { kind: 'huddle', lobbyName: DOC_SCOPE } });
    expect(agentStatus(done)).toMatchObject({ stage: 'done', steps: [{}, { link: { kind: 'document' } }, { link: { kind: 'huddle' } }] });
  });

  it('a revoked requester on resume creates nothing', async () => {
    const { flow, run } = await plan(['summarize', 'document:create'], 'assessment');
    setStepDispatcher(async (_s, _t, _c, st) => { started.push(st.kind); return st.kind === 'summarize' ? { kind: 'summary', runId: await openChild('summarize') } : made(st.kind); });
    await flow.approve(run, session, 'req-12345678');
    await tick();
    unfreezeClock(); freezeClock(new Date(T0 + 5 * 60_000));
    jest.mocked(currentLiveSession).mockReset().mockRejectedValue(new AppError(401, 'The session is no longer current. Sign in again.'));
    await dispatchFlowRuns('node-B');
    await tick(100);
    const out = (await flowRunStore.get(run.id))!;
    expect(started).toEqual(['summarize']);
    expect((out.result as AgentResult).errorCode).toBe('authorization-unavailable');
    expect(out.progress[1]!.status).not.toBe('completed');
  });

  it('a node lost between the create and its report fails the step visibly: nothing is created twice', async () => {
    const { flow, run } = await plan(['document:create', 'meeting:create'], 'assessment');
    // Node A makes the document and dies before it can report: the dispatcher never returns.
    setStepDispatcher(async (_s, _t, _c, st) => { started.push(st.kind); return new Promise<never>(() => undefined); });
    await flow.approve(run, session, 'req-12345678');
    await tick();
    expect(started).toEqual(['document:create']);
    expect((await flowRunStore.get(run.id))!.progress[0]).toMatchObject({ status: 'running' });
    unfreezeClock(); freezeClock(new Date(T0 + 5 * 60_000));
    setStepDispatcher(async (_s, _t, _c, st) => { started.push(`B:${st.kind}`); return made(st.kind); });
    await dispatchFlowRuns('node-B');
    await tick(300); // node A's executor never returns, so there is nothing to settle
    const out = (await flowRunStore.get(run.id))!;
    expect(started).toEqual(['document:create']);
    expect(agentStage(out)).toBe('stopped');
    expect(out.progress[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('may already have started') });
    expect(out.progress[1]!.status).toBe('pending');
  });
});
