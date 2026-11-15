// Asked writes that name someone else (docs/meeting-consent-design.md, package 7): a write whose arguments name another person
// becomes a proposal that needs them, with the asker as executor; a write that names only the asker, or nobody, keeps the asker's
// card. The person is resolved on the server from the call's roster or the directory; a name that matches nobody is refused.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null), listUsers: jest.fn(async () => []) }));
const mockPosts = { replies: [] as string[], actions: [] as Array<{ askedBy: string; summary: string }> };
const mockSent: Array<{ users: string[]; input: unknown }> = [];
jest.mock('../../social-notify.js', () => ({ notify: async (users: string[], input: unknown) => { mockSent.push({ users, input }); return users; } }));
jest.mock('../../call-chat.js', () => ({ callChatRuntime: () => ({ seatedUsers: async () => [{ userId: 'u-alice', active: true }, { userId: 'u-bob', active: true }] }) }));
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => ({ 'u-alice': 'Alice Moreau', 'u-bob': 'Bob Ito', 'u-carol': 'Carol Ndiaye', 'u-dana': 'Dana Reyes' } as Record<string, string>)[id] ?? id,
  postReply: async (_c: string, r: { text: string }) => { mockPosts.replies.push(r.text); return { id: 'm' }; },
  postPrivately: async () => true,
  postNoticeQuietly: async () => undefined,
  postAction: async (_c: string, input: { askedBy: string; summary: string }) => { mockPosts.actions.push(input); return { message: { id: 'msg' }, created: true }; },
  moveAction: async () => null,
}));

import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime, classifyCall, setAssistantRuntime } from '../orchestrator.js';
import { respondToProposal } from '../proposals.js';
import { forgetProposalNotices } from '../proposal-notify.js';
import { PERSON_ARGUMENTS, peopleSaid, resolvePeople } from '../named-people.js';
import { meetingTools } from '../instructions.js';
import { ScriptedSession } from '../scripted-session.js';
import { setAssistantStore } from '../store-select.js';
import { newAssistantSession, sessionOf } from '../types.js';

const TENANT_IDS = ['orgiq', 'social', 'assessment', 'pipelines', 'access'];

const CALL = 'call-1';
const ALICE = 'u-alice', BOB = 'u-bob', CAROL = 'u-carol', DANA = 'u-dana';
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };

let now: number;
let store: MemoryAssistantStore;
let intake: LineIntake;
let runtime: AssistantRuntime;

async function say(userId: string, text: string) {
  await intake.handle(CALL, { userId, text, at: now });
  now += 5000;
  await intake.tick();
  await flush();
}
const proposals = () => store.listProposals(CALL);
const consent = (userId: string) => respondToProposal(store, CALL, (proposalsNow[0]!).id, { userId, response: 'consent', at: now });
let proposalsNow: Awaited<ReturnType<typeof proposals>> = [];

beforeEach(async () => {
  now = T0; mockPosts.replies.length = 0; mockPosts.actions.length = 0; mockSent.length = 0; forgetProposalNotices();
  store = new MemoryAssistantStore(); setAssistantStore(store);
  const source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  intake.start(CALL);
  runtime = new AssistantRuntime({
    store: () => store, intake: () => intake, clock: () => now, makeSession: () => new ScriptedSession(() => now),
    rolesOf: async (u) => (u === CAROL ? [] : ['member']), actionAllowed: async () => true, mayDecide: async () => false,
    directory: async () => [{ userId: DANA, name: 'Dana Reyes' }, { userId: 'u-dan', name: 'Dan Okafor' }, { userId: 'u-danw', name: 'Dan Wu' }],
  }, { tickMs: 0 });
  setAssistantRuntime(runtime);
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: ALICE, invitedAt: now,
    pausedBy: null, leftAt: null, leftBy: null, acked: [ALICE, BOB, CAROL], attendees: [ALICE, BOB, CAROL], presentAtInvite: [ALICE, BOB, CAROL],
    requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
  await runtime.start({ callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice Moreau', 'Bob Ito', 'Carol Ndiaye'], recordName: 'Auth Migration' });
});
afterEach(async () => { setAssistantRuntime(null); intake.dispose(); setAssistantStore(null); });

describe('a write that names another person', () => {
  it('a work item assigned to Bob is a proposal needing Bob, run by Alice: no card, no turn, Nova says whose consent it needs', async () => {
    await say(ALICE, 'Nova, create a work item for the cutover runbook and assign it to Bob');
    expect(mockPosts.actions).toEqual([]);
    expect(await store.listTurns(CALL)).toEqual([]);
    const [p] = await proposals();
    expect(p).toMatchObject({
      source: 'asked', askedBy: ALICE, named: [BOB], executor: ALICE, state: 'open', responses: [],
      statement: 'Create a work item titled "the cutover runbook", owned by Bob Ito',
      outcome: { kind: 'tool', name: 'create', args: { kind: 'work-item', fields: { title: 'the cutover runbook', assignee: 'Bob' } } },
    });
    // The asker runs it and must consent too, and is told where to answer.
    expect(mockPosts.replies).toEqual(['This needs your consent and Bob Ito\'s. Answer in the prompt above the call controls.']);
    // Bob is seated: nobody is told by notification.
    expect(mockSent).toEqual([]);
  });

  it('assigned to the asker (by "me" or by name) keeps the asker\'s card', async () => {
    await say(ALICE, 'Nova, create a work item for the cutover runbook and assign it to me');
    await say(ALICE, 'Nova, create a work item for the release notes and assign it to Alice Moreau');
    expect(mockPosts.actions.map((a) => a.askedBy)).toEqual([ALICE, ALICE]);
    expect(await proposals()).toEqual([]);
  });

  it('no assignee keeps the asker\'s card', async () => {
    await say(ALICE, 'Nova, create a work item for the cutover runbook');
    expect(mockPosts.actions).toHaveLength(1);
    expect(mockPosts.actions[0]!.summary).toBe('Create a work item titled "the cutover runbook"');
    expect(await proposals()).toEqual([]);
  });

  it('a person not in the call is found in the directory: a proposal, and a notification with no words of it', async () => {
    await say(ALICE, 'Nova, create a work item for the cutover runbook and assign it to Dana Reyes');
    const [p] = await proposals();
    expect(p).toMatchObject({ named: [DANA], executor: ALICE });
    await flush();
    expect(mockSent.map((s) => s.users)).toEqual([[DANA]]);
    expect(mockSent[0]!.input).toMatchObject({ title: expect.stringMatching(/^A proposal from (the .+ call|a call) needs you$/) });
    expect(JSON.stringify(mockSent[0]!.input)).not.toMatch(/cutover|runbook|Alice|Dana|Bob|p-/i);
  });

  it('a name that matches nobody, or several people, is refused: no proposal, no card', async () => {
    await say(ALICE, 'Nova, create a work item for the cutover runbook and assign it to Zed');
    await say(ALICE, 'Nova, create a work item for the release notes and assign it to Dan');
    expect(await proposals()).toEqual([]);
    expect(mockPosts.actions).toEqual([]);
    expect(sessionOf((await store.get(CALL))!).refusedCalls).toBe(2);
  });
});

describe('the consent it needs', () => {
  beforeEach(async () => {
    await say(ALICE, 'Nova, create a work item for the cutover runbook and assign it to Bob');
    proposalsNow = await proposals();
  });

  it('the asker\'s consent and the named person\'s run it once, in the asker\'s browser, with the frozen call; the result closes it', async () => {
    await consent(ALICE);
    expect(await store.listTurns(CALL)).toEqual([]);
    await consent(BOB);
    await flush();
    // Bob's consent was the last one needed, not the asker's: it waits for the asker's own click ("Run it now").
    expect(await store.listTurns(CALL)).toEqual([]);
    expect((await proposals())[0]!.state).toBe('consented');
    await respondToProposal(store, CALL, proposalsNow[0]!.id, { userId: ALICE, response: 'consent', at: now, asExecutor: true });
    await flush();
    const turns = await runtime.turnsFor(CALL, ALICE);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ askedBy: ALICE, kind: 'write', status: 'running', proposalId: proposalsNow[0]!.id, tool: { name: 'create', args: proposalsNow[0]!.outcome.kind === 'tool' ? proposalsNow[0]!.outcome.args : null } });
    expect(await runtime.turnsFor(CALL, BOB)).toEqual([]);
    const claim = await runtime.claimTurn(CALL, turns[0]!.turnId, ALICE);
    expect(claim && 'turn' in claim).toBe(true);
    await runtime.submitResult(CALL, turns[0]!.turnId, ALICE, { ok: true, claimId: (claim as { turn: { claimId: string } }).turn.claimId, output: { say: 'Created it.' } });
    expect((await proposals())[0]!.state).toBe('done');
  });

  it('the named person objects: nothing runs, even with the asker and a third person consenting', async () => {
    await respondToProposal(store, CALL, proposalsNow[0]!.id, { userId: BOB, response: 'object', reason: 'I am out next week', at: now });
    await consent(ALICE); await consent(CAROL);
    await flush();
    expect(await store.listTurns(CALL)).toEqual([]);
    expect((await proposals())[0]!.state).toBe('objected');
  });

  it('the asker alone, or a third person instead of the named one, runs nothing', async () => {
    await consent(ALICE); await consent(CAROL);
    await flush();
    expect(await store.listTurns(CALL)).toEqual([]);
    expect((await proposals())[0]!.state).toBe('open');
  });
});

describe('which arguments name a person', () => {
  it('every write a meeting offers in any workspace has a row', () => {
    const writes = new Set<string>();
    for (const tenant of TENANT_IDS) for (const t of meetingTools(tenant)) if (classifyCall(t.name, {}) === 'write') writes.add(t.name);
    expect(writes.size).toBeGreaterThan(0);
    for (const w of writes) expect(PERSON_ARGUMENTS[w]).toBeDefined();
    expect(peopleSaid('not-a-tool', {})).toBeNull();
  });

  it('a message names its recipient unless it goes to a team or a channel; an unknown target kind counts', () => {
    expect(peopleSaid('message', { target: { kind: 'dm', name: 'Bob' }, text: 'hi' })).toEqual([{ said: 'Bob', role: 'recipient' }]);
    expect(peopleSaid('message', { target: { kind: 'channel', name: 'platform' }, text: 'hi' })).toEqual([]);
    expect(peopleSaid('message', { target: { kind: 'squad', name: 'Bob' }, text: 'hi' })).toEqual([{ said: 'Bob', role: 'recipient' }]);
    expect(peopleSaid('create', { kind: 'decision', fields: { participants: [ALICE, 'Bob'], delegate: null } })).toEqual([{ said: ALICE, role: 'participant' }, { said: 'Bob', role: 'participant' }]);
    expect(peopleSaid('update', { ref: 'work-item:wi-1', fields: { assignee: 'Bob' } })).toEqual([{ said: 'Bob', role: 'owner' }]);
    expect(peopleSaid('set_status', { status: 'away', message: 'with Bob' })).toEqual([]);
  });

  it('resolves by user id, exact name or a unique first name; the asker is never among the others', async () => {
    const roster = [{ userId: ALICE, name: 'Alice Moreau' }, { userId: BOB, name: 'Bob Ito' }];
    const dir = async () => [{ userId: DANA, name: 'Dana Reyes' }];
    expect(await resolvePeople([{ said: 'bob', role: 'owner' }, { said: ALICE, role: 'participant' }, { said: 'Dana Reyes', role: 'participant' }], ALICE, roster, dir))
      .toEqual({ ok: true, others: [{ userId: BOB, name: 'Bob Ito', role: 'owner' }, { userId: DANA, name: 'Dana Reyes', role: 'participant' }] });
    expect(await resolvePeople([{ said: 'Zed', role: 'owner' }], ALICE, roster, dir)).toEqual({ ok: false, why: 'unknown person' });
  });
});
