// Running a consented proposal (docs/meeting-consent-design.md, package 3): exactly one turn for the executor, the decision's
// arguments decided on the server, the rights checked when the turn is made and again at the claim, a take-over by another
// consenter, a tab that is gone, a changed digest, a result from someone else, and the delete. Nothing is ever posted in the call.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
const mockPosted: string[] = [];
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => ({ 'u-priya': 'Priya', 'u-sam': 'Sam', 'u-lee': 'Lee' } as Record<string, string>)[id] ?? id,
  postReply: async (_c: string, r: { text: string }) => { mockPosted.push(r.text); return { id: 'm' }; },
  postPrivately: async (_c: string, _u: string, r: { text: string }) => { mockPosted.push(r.text); return true; },
  postNoticeQuietly: async (_c: string, text: string) => { mockPosted.push(text); },
  postAction: async () => { mockPosted.push('action'); return null; },
  moveAction: async () => null,
}));

import { MemoryAssistantStore } from '../store.js';
import { AssistantRuntime, setAssistantRuntime } from '../orchestrator.js';
import { buildProposal, createProposal, respondToProposal } from '../proposals.js';
import { PROPOSAL_TURN_TTL_MS } from '../proposal-run.js';
import { ScriptedSession } from '../scripted-session.js';
import { newAssistantSession, type AssistantRecord, type ProposalOutcome } from '../types.js';
import type { LineIntake } from '../intake.js';

const CALL = 'call-1';
const PRIYA = 'u-priya', SAM = 'u-sam', LEE = 'u-lee';
const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const STATEMENT = 'Cut over the smallest tenants first';
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };

let now: number;
let store: MemoryAssistantStore;
let runtime: AssistantRuntime;
let roles: Record<string, string[]>;
let deciders: Set<string>;
let allowed: boolean;

const record = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: PRIYA,
  invitedAt: T0, pausedBy: null, leftAt: null, leftBy: null, acked: [PRIYA, SAM, LEE], attendees: [PRIYA, SAM, LEE], presentAtInvite: [PRIYA, SAM, LEE],
  requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600), ...over,
});

async function propose(outcome: ProposalOutcome = { kind: 'decision', initiativeId: null }, executor = PRIYA) {
  return (await createProposal(store, { id: 'p-1', callId: CALL, tenant: 'orgiq', statement: STATEMENT, outcome, named: [], executor, source: 'dev', at: now })).proposal;
}
const consent = (userId: string, asExecutor = false) => respondToProposal(store, CALL, 'p-1', { userId, response: 'consent', at: now, ...(asExecutor ? { asExecutor } : {}) });
const proposal = async () => (await store.getProposal(CALL, 'p-1'))!;
const turns = () => store.listTurns(CALL, {});
/** Sam then Priya consent; the hook starts the run. */
async function consented(outcome?: ProposalOutcome, executor = PRIYA) {
  await propose(outcome, executor);
  await consent(SAM); await consent(executor === SAM ? LEE : executor);
  await flush();
}

beforeEach(async () => {
  now = T0; mockPosted.length = 0;
  roles = { [PRIYA]: ['member'], [SAM]: ['member'], [LEE]: [] };
  deciders = new Set([PRIYA]); allowed = true;
  store = new MemoryAssistantStore();
  await store.create(record());
  runtime = new AssistantRuntime({
    store: () => store, intake: () => ({}) as unknown as LineIntake, clock: () => now, makeSession: () => new ScriptedSession(() => now),
    rolesOf: async (u) => roles[u] ?? [], actionAllowed: async () => allowed, mayDecide: async (u, _t, initiative) => initiative === 'p-auth' && deciders.has(u),
  }, { tickMs: 0 });
  setAssistantRuntime(runtime);
});
afterEach(() => { setAssistantRuntime(null); });

describe('consent completes', () => {
  it('moves it to running and makes exactly one write turn for the executor, even with two final consents at once', async () => {
    await propose();
    await Promise.all([consent(SAM), consent(PRIYA)]);
    await Promise.all([runtime.startProposal(CALL, 'p-1'), runtime.startProposal(CALL, 'p-1')]);
    await flush();
    const made = await turns();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ askedBy: PRIYA, kind: 'write', status: 'running', proposalId: 'p-1' });
    expect(made[0]!.actionId).toBeUndefined();
    expect(await proposal()).toMatchObject({ state: 'running', run: { turnId: made[0]!.turnId, by: PRIYA, note: null } });
    expect(await runtime.turnsFor(CALL, PRIYA)).toHaveLength(1);
    expect(mockPosted).toEqual([]);
  });

  it('a decision is recorded on the call\'s initiative with the statement, the consenters and the call: resolved when the executor may decide', async () => {
    await consented();
    expect((await turns())[0]!.tool).toEqual({ name: 'create', args: { kind: 'decision', fields: {
      initiative: 'initiative:p-auth', statement: STATEMENT, state: 'resolved', participants: [SAM, PRIYA], call: CALL } } });
  });

  it('waiting when the executor may not decide on that initiative', async () => {
    deciders.clear();
    await consented();
    expect(((await turns())[0]!.tool.args as { fields: { state: string } }).fields.state).toBe('waiting');
  });

  it('a tool outcome runs with its frozen arguments', async () => {
    const outcome: ProposalOutcome = { kind: 'tool', name: 'create', args: { kind: 'work-item', fields: { title: 'Cutover runbook' } } };
    await consented(outcome);
    expect((await turns())[0]!.tool).toEqual({ name: 'create', args: outcome.args });
  });

  it('a changed digest is refused: nothing runs and it fails with a reason', async () => {
    const built = buildProposal({ id: 'p-1', callId: CALL, tenant: 'orgiq', statement: STATEMENT, outcome: { kind: 'tool', name: 'create', args: { kind: 'work-item', fields: { title: 'A' } } }, named: [], executor: PRIYA, source: 'dev', at: now });
    await store.createProposal({ ...built, outcome: { kind: 'tool', name: 'create', args: { kind: 'work-item', fields: { title: 'B' } } } });
    await consent(SAM); await consent(PRIYA); await flush();
    expect(await turns()).toEqual([]);
    expect(await proposal()).toMatchObject({ state: 'failed', run: { note: expect.stringMatching(/changed after people consented/) } });
  });
});

describe('the executor\'s rights', () => {
  it('an executor who may not run it gets no turn; it stays consented with a note naming who could', async () => {
    roles[PRIYA] = [];
    await consented();
    expect(await turns()).toEqual([]);
    expect(await proposal()).toMatchObject({ state: 'consented', run: { turnId: null, by: PRIYA, note: 'Priya cannot run this; Sam can, by consenting again to run it.' } });
  });

  it('the executor loses the right before the claim: refused, back to consented; Sam takes over and gets the one new turn', async () => {
    await consented();
    const [first] = await turns();
    roles[PRIYA] = [];
    expect(await runtime.claimTurn(CALL, first!.turnId, PRIYA)).toEqual({ conflict: 'not allowed' });
    expect((await store.getTurn(CALL, first!.turnId))!.status).toBe('declined');
    expect(await proposal()).toMatchObject({ state: 'consented', run: { note: expect.stringMatching(/^Priya cannot run this; Sam can/) } });
    expect((await consent(LEE, true))).toMatchObject({ ok: false, why: 'not-a-consenter' });
    expect((await consent(SAM, true)).ok).toBe(true);
    await flush();
    const open = (await turns()).filter((t) => t.status === 'running');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ askedBy: SAM, proposalId: 'p-1' });
    // Sam may not decide on the initiative: the record is raised for the owner instead.
    expect((open[0]!.tool.args as { fields: { state: string } }).fields.state).toBe('waiting');
    expect(await proposal()).toMatchObject({ state: 'running', executor: SAM });
  });

  it('a resolved record needs the decide rule still at the claim', async () => {
    await consented();
    const [first] = await turns();
    deciders.clear();
    expect(await runtime.claimTurn(CALL, first!.turnId, PRIYA)).toEqual({ conflict: 'not allowed' });
    expect((await proposal()).state).toBe('consented');
  });
});

describe('the result', () => {
  async function claimed() {
    await consented();
    const [t] = await turns();
    const claim = await runtime.claimTurn(CALL, t!.turnId, PRIYA);
    if (!claim || !('turn' in claim)) throw new Error('not claimed');
    return claim.turn;
  }

  it('done with the statement as title and a link built from the record id; nothing is said in the call', async () => {
    const t = await claimed();
    const out = await runtime.submitResult(CALL, t.turnId, PRIYA, { ok: true, claimId: t.claimId!, output: { id: 'd-new', href: 'https://elsewhere.example', say: 'Recorded.' } });
    expect(out).toMatchObject({ turn: { status: 'done' } });
    expect(await proposal()).toMatchObject({ state: 'done', run: { title: STATEMENT, href: '/iq/decisions/d-new', note: null } });
    expect(mockPosted).toEqual([]);
  });

  it('failed with the browser\'s reason', async () => {
    const t = await claimed();
    await runtime.submitResult(CALL, t.turnId, PRIYA, { ok: false, claimId: t.claimId!, error: 'You are not on this initiative.' });
    expect(await proposal()).toMatchObject({ state: 'failed', run: { note: 'You are not on this initiative.', href: null } });
  });

  it('a result or a claim from someone else is refused and the proposal keeps running', async () => {
    await consented();
    const [t] = await turns();
    expect(await runtime.claimTurn(CALL, t!.turnId, SAM)).toBeNull();
    expect(await runtime.submitResult(CALL, t!.turnId, SAM, { ok: true, claimId: 'x', output: { id: 'd-1' } })).toBeNull();
    expect((await proposal()).state).toBe('running');
  });
});

describe('time and delete', () => {
  it('the executor\'s tab is gone: the turn expires and the proposal goes back to consented, not failed', async () => {
    await consented();
    now += PROPOSAL_TURN_TTL_MS + 1;
    expect(await runtime.sweepTurns()).toBe(1);
    expect((await turns())[0]!.status).toBe('expired');
    expect(await proposal()).toMatchObject({ state: 'consented', run: { turnId: null, note: expect.stringMatching(/browser was not there/) } });
    expect(mockPosted).toEqual([]);
    // The executor tries again: one new turn.
    expect((await consent(PRIYA, true)).ok).toBe(true);
    await flush();
    expect((await turns()).filter((t) => t.status === 'running')).toHaveLength(1);
  });

  it('deleted while running: the turn expires, the proposal is gone, and a late result is refused', async () => {
    await consented();
    const [t] = await turns();
    const claim = await runtime.claimTurn(CALL, t!.turnId, PRIYA);
    await store.transition(CALL, { from: ['listening'], to: 'left', by: PRIYA, at: now });
    await store.tombstoneMinutes(CALL, PRIYA, now);
    expect((await store.getTurn(CALL, t!.turnId))!.status).toBe('expired');
    expect(await store.getProposal(CALL, 'p-1')).toBeNull();
    const claimId = claim && 'turn' in claim ? claim.turn.claimId! : 'x';
    expect(await runtime.submitResult(CALL, t!.turnId, PRIYA, { ok: true, claimId, output: { id: 'd-1' } })).toEqual({ conflict: 'expired' });
  });
});
