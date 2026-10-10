// lib/agent-loop: the plan rules, the mock planner's fixture and the executor's per-step
// authority (a fresh session before every step; a failure stops the loop).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } } }));
jest.mock('../../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../live-principal.js', () => ({ currentLiveSession: jest.fn() }));

import { AppError } from '../../async-handler.js';
import { currentLiveSession } from '../../live-principal.js';
import { agentPlansFixture } from '../../../mock/agent-plans.js';
import { flowRunsFixture } from '../../../mock/flow-runs.js';
import { flowRunStore, kickFlowRun, pendingFlowRuns } from '../../flow-runs/index.js';
import { agentStage, agentStatus, defineAgentFlow, setStepDispatcher, type AgentResult } from '../index.js';
import { acceptPlan, allowedKinds, deterministicPlan, parseAgentArgs, requestPlan } from '../plan.js';
import type { Session } from '../../session.js';

const ALL = allowedKinds('social');
const step = (kind: string, over: Record<string, unknown> = {}) => ({ kind, title: 'T', instruction: '', acceptance: 'Done when quoted.', ...over });
const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const session = { sub: 'u-1', tenant: 'orgiq', role: 'sme', epoch: 1, iat: 1, grants: {} } as unknown as Session;

beforeEach(() => { flowRunsFixture.reset(); agentPlansFixture.reset(); setStepDispatcher(null); jest.mocked(currentLiveSession).mockReset(); });

describe('plan rules', () => {
  it('parses a goal and refuses an empty or oversized one', () => {
    expect(parseAgentArgs('  wrap\n up  ')).toEqual({ ok: true, goal: 'wrap up' });
    expect(parseAgentArgs('   ').ok).toBe(false);
    expect(parseAgentArgs('x'.repeat(301)).ok).toBe(false);
  });

  it('keeps a valid 1-6 step plan and rejects anything else whole', () => {
    expect(acceptPlan({ summary: 's', steps: [step('summarize'), step('note')] }, 'g', ALL)).toMatchObject({ fallback: false, steps: [{ kind: 'summarize' }, { kind: 'note' }] });
    expect(acceptPlan({ summary: 's', steps: [] }, 'g', ALL)).toBeNull();
    expect(acceptPlan({ summary: 's', steps: Array.from({ length: 7 }, () => step('doc')) }, 'g', ALL)).toBeNull();
    expect(acceptPlan({ summary: 's', steps: Array.from({ length: 6 }, () => step('doc')) }, 'g', ALL)).not.toBeNull();
    expect(acceptPlan({ summary: 's', steps: [step('meeting:create')] }, 'g', allowedKinds('pipelines', 'pipelines:def:d-1'))).toBeNull();
    expect(acceptPlan({ summary: 's', steps: [step('box')] }, 'g', ALL)).toBeNull();
    expect(acceptPlan({ summary: 's', steps: [step('summarize', { acceptance: ' ' })] }, 'g', ALL)).toBeNull();
    expect(acceptPlan({ summary: '', steps: [step('summarize')] }, 'g', ALL)).toBeNull();
  });

  it('only Social may plan a deck', () => {
    expect(allowedKinds('social')).toContain('deck');
    for (const t of ['orgiq', 'assessment', 'pipelines'] as const) expect(allowedKinds(t)).not.toContain('deck');
    expect(acceptPlan({ summary: 's', steps: [step('deck')] }, 'g', allowedKinds('orgiq'))).toBeNull();
  });

  it('the deterministic plan is one valid step', () => {
    const plan = deterministicPlan('wrap up', allowedKinds('orgiq'));
    expect(plan).toMatchObject({ fallback: true, steps: [{ kind: 'summarize', title: 'wrap up' }] });
    expect(acceptPlan({ summary: plan.summary, steps: plan.steps }, 'wrap up', allowedKinds('orgiq'))).not.toBeNull();
  });
});

describe('creation steps are offered only where the tenant has the path', () => {
  it('document:create: Social and assessment; meeting:create: Social and lobby conversations only', () => {
    expect(allowedKinds('social')).toEqual(expect.arrayContaining(['document:create', 'meeting:create']));
    expect(allowedKinds('assessment', 'assessment:doc:d-1')).toEqual(expect.arrayContaining(['document:create', 'meeting:create']));
    expect(allowedKinds('orgiq', 'orgiq:initiative:p-auth')).toContain('meeting:create');
    expect(allowedKinds('orgiq', 'orgiq:initiative:p-auth')).not.toContain('document:create');
    expect(allowedKinds('orgiq', 'orgiq:work:w-1')).not.toContain('meeting:create');
    expect(allowedKinds('orgiq')).not.toContain('meeting:create');
    expect(allowedKinds('orgiq', 'orgiq:huddle:abc')).not.toContain('meeting:create');
    for (const kind of ['document:create', 'meeting:create']) expect(allowedKinds('pipelines', 'pipelines:def:d-1')).not.toContain(kind);
    // A run page is a huddle lobby (realtime-parity gap 3): its discussion may open the run's huddle.
    expect(allowedKinds('pipelines', 'pipelines:run:r-1')).toContain('meeting:create');
    expect(allowedKinds('pipelines', 'pipelines:run:r-1')).not.toContain('document:create');
    expect(allowedKinds('assessment', 'assessment:team:TEAM-005')).toEqual(expect.arrayContaining(['document:create', 'meeting:create']));
  });

  it('keeps a document body with its line breaks, drops it from other kinds, and refuses a kind the tenant lacks', () => {
    const body = '# Notes\n\n- one\n- two\u0000';
    const plan = acceptPlan({ summary: 's', steps: [step('document:create', { body }), step('meeting:create', { body: 'x' })] }, 'g', allowedKinds('social'));
    expect(plan?.steps[0]).toMatchObject({ kind: 'document:create', body: '# Notes\n\n- one\n- two' });
    expect(plan?.steps[1]).not.toHaveProperty('body');
    expect(acceptPlan({ summary: 's', steps: [step('document:create')] }, 'g', allowedKinds('orgiq', 'orgiq:initiative:p-auth'))).toBeNull();
    expect(acceptPlan({ summary: 's', steps: [step('document:create', { body: 'y'.repeat(5000) })] }, 'g', allowedKinds('social'))?.steps[0]?.body).toHaveLength(4000);
  });

  it('the mock planner filters the kickoff plan to what the conversation offers', async () => {
    const lines = [{ messageId: 'm', author: 'a', text: 't', at: '2026-10-01T00:00:00.000Z' }];
    const ask = (tenant: 'social' | 'orgiq' | 'assessment' | 'pipelines', channel: string) => requestPlan({ tenant, channel, sub: 'u', runId: 'r', goal: 'plan the kickoff', lines, agentAuth: false });
    expect((await ask('social', 'social:ch:general')).steps.map(s => s.kind)).toEqual(['document:create', 'meeting:create']);
    expect((await ask('assessment', 'assessment:doc:d-1')).steps.map(s => s.kind)).toEqual(['document:create', 'meeting:create']);
    expect((await ask('orgiq', 'orgiq:initiative:p-auth')).steps.map(s => s.kind)).toEqual(['meeting:create']);
    // Nothing left to offer: the deterministic one-step plan stands in.
    expect((await ask('pipelines', 'pipelines:run:r-1')).steps.map(s => s.kind)).toEqual(['meeting:create']);
    expect(await ask('pipelines', 'pipelines:def:d-1')).toMatchObject({ fallback: true, steps: [{ kind: 'summarize' }] });
  });
});

describe('the mock planner is a registered fixture', () => {
  it('answers from agent.plans rows, resets, and shows the empty scenario', async () => {
    const lines = [{ messageId: 'm', author: 'a', text: 't', at: '2026-10-01T00:00:00.000Z' }];
    const ask = (goal: string, tenant: 'social' | 'orgiq' = 'social') => requestPlan({ tenant, sub: 'u', runId: 'r', goal, lines, agentAuth: false });
    expect((await ask('plan it')).steps.map(s => s.kind)).toEqual(['summarize', 'diagram']);
    expect((await ask('make slides')).steps.map(s => s.kind)).toEqual(['summarize', 'deck']);
    expect((await ask('make slides', 'orgiq')).steps.map(s => s.kind)).toEqual(['summarize']);
    agentPlansFixture.rows().length = 0;
    agentPlansFixture.rows().push({ id: 'x', keywords: [], summary: 'Edited', steps: [{ kind: 'note', title: 'N', instruction: 'i', acceptance: 'a' }] });
    expect((await ask('anything')).summary).toBe('Edited');
    agentPlansFixture.reset();
    expect((await ask('anything')).steps).toHaveLength(2);
  });
});

describe('execution authority', () => {
  async function plannedRun(steps: unknown[]) {
    agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'S', steps: steps as never });
    const flow = defineAgentFlow({ tenant: 'orgiq', kind: 'orgiq.agent', idPrefix: 'oag', agentAuth: true });
    const run = await flow.startRun({ userId: 'u-1', channel: 'orgiq:initiative:p-auth', goal: 'g', lines: [] });
    await settle();
    return { flow, run: (await flowRunStore.get(run.id))! };
  }

  it('reloads the session before EVERY step; a revoked session stops the loop at that step', async () => {
    const { flow, run } = await plannedRun([step('summarize'), step('diagram'), step('doc')]);
    expect(agentStage(run)).toBe('awaiting-approval');
    const started: string[] = [];
    setStepDispatcher(async (_s, _t, _c, st) => {
      started.push(st.kind);
      const child = await flowRunStore.create({ tenant: 'orgiq', kind: `orgiq.${st.kind}`, requestedBy: 'u-1', scope: 'orgiq:initiative:p-auth', input: null });
      await flowRunStore.claim({ kinds: [child.kind], owner: 'x', leaseMs: 1000, id: child.id });
      await flowRunStore.finish(child.id, 'x', { status: 'completed', result: { summary: `did ${st.kind}` } });
      return { kind: st.kind === 'summarize' ? 'summary' : (st.kind as 'diagram' | 'doc'), runId: child.id };
    });
    jest.mocked(currentLiveSession).mockResolvedValueOnce(session).mockRejectedValueOnce(new AppError(401, 'The session is no longer current. Sign in again.'));
    expect(await flow.approve(run, session)).toBe('started');
    await settle();
    expect(jest.mocked(currentLiveSession)).toHaveBeenCalledTimes(2);
    expect(started).toEqual(['summarize']);
    const done = (await flowRunStore.get(run.id))!;
    expect(agentStage(done)).toBe('stopped');
    expect(agentStatus(done)).toMatchObject({ phase: 'failed', error: expect.stringContaining('Step 2 stopped the loop: authorization-unavailable (403)') });
    expect(done.progress.map(s => s.status)).toEqual(['completed', 'failed', 'pending']);
    expect(done.progress[0]!.detail).toBe('did summarize');
    expect((done.result as AgentResult).stoppedAt).toBe(1);
  });

  it('Approve is a once-only compare-and-set, and a run with no stored approval never runs steps', async () => {
    const { flow, run } = await plannedRun([step('summarize')]);
    const [a, b] = await Promise.all([flow.approve(run, session, 'req-aaaaaaaa'), flow.approve(run, session, 'req-bbbbbbbb')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await settle();
    const second = await plannedRun([step('note', { instruction: 'remember' })]);
    // An approval row without the approver's identity.
    await flowRunStore.requeueRevision(second.run.id, 1, 'r', { phase: 'execute' });
    setStepDispatcher(async () => { throw new Error('must not run'); });
    // A note needs no session either way, but the guard comes first.
    kickFlowRun(second.run.id, 'orgiq.agent'); await settle();
    const out = (await flowRunStore.get(second.run.id))!;
    expect(agentStage(out)).toBe('stopped');
    expect(out.error ?? (out.result as AgentResult).error).toMatch(/authorization-unavailable/);
  });

  it('a note step runs nothing and records its text; a child that fails stops the loop with its error', async () => {
    const { flow, run } = await plannedRun([step('note', { instruction: 'Remember the cutover' }), step('summarize')]);
    jest.mocked(currentLiveSession).mockResolvedValue(session);
    setStepDispatcher(async () => {
      const child = await flowRunStore.create({ tenant: 'orgiq', kind: 'orgiq.summarize', requestedBy: 'u-1', scope: 's', input: null });
      await flowRunStore.claim({ kinds: ['orgiq.summarize'], owner: 'x', leaseMs: 1000, id: child.id });
      await flowRunStore.finish(child.id, 'x', { status: 'failed', error: 'The summary could not be verified against the conversation.' });
      return { kind: 'summary', runId: child.id };
    });
    expect(await flow.approve(run, session)).toBe('started'); await settle();
    const done = (await flowRunStore.get(run.id))!;
    expect(done.progress.map(s => s.status)).toEqual(['completed', 'failed']);
    expect(done.progress[0]!.detail).toBe('Remember the cutover');
    expect(done.progress[1]!.detail).toMatch(/could not be verified/);
    expect(agentStage(done)).toBe('stopped');
  });
});
