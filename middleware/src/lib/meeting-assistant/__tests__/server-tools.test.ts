// Milo's server tools are a registry (server-tools.ts): a family nobody else knows registers one tool in a few lines, and the
// orchestrator runs it through the scripted session with no change to the orchestrator and nothing of the interviews tenant.
// This is the test to copy when adding a family (docs/interviews-tenant-plan.md, "Adding a Milo tool").
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../social-notify.js', () => ({ notify: jest.fn(async () => []) }));
const mockApproved: string[] = [];
const mockTrace: Array<{ ev: string; f: Record<string, unknown> }> = [];
jest.mock('../trace.js', () => ({ trace: (ev: string, f: Record<string, unknown> = {}) => { mockTrace.push({ ev, f }); } }));
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => id,
  postReply: async () => ({ id: 'm' }),
  postApprovedAnswer: async (_c: string, text: string) => { mockApproved.push(text); return { id: 'a' }; },
  postPrivately: async () => true,
  postNoticeQuietly: async () => undefined,
  noticeText: (jest.requireActual('../chat.js') as typeof import('../chat.js')).noticeText,
  postAction: async () => ({ message: { id: 'x' }, created: true }),
  moveAction: async () => null,
}));

import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime } from '../orchestrator.js';
import { addScriptRules, ScriptedSession } from '../scripted-session.js';
import { newAssistantSession } from '../types.js';
import { setAssistantStore } from '../store-select.js';
import { DEFAULT_POLICY, registerMeetingAssistantPolicy } from '../policy.js';
import { registerServerTools, resetServerTools, runServerTool, serverToolPolicy, type ServerToolDef, type ServerToolFamily } from '../server-tools.js';

const CALL = 'call-standup';
const ALICE = 'u-alice', BOB = 'u-bob';
const FAMILY = 'orgiq:standup';
const AGENDA = 'Today: the release, then the on-call handover.';

// ── The whole of a new family: one tool and its registration ──────────────────────────────────────────────────────────────
const logged: Array<{ line: string; kind: string; via: string }> = [];
const READ_AGENDA: ServerToolDef<{ callId: string }> = {
  name: 'read_agenda', description: 'Read the stand-up agenda aloud.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  says: 'Says the agenda.', mapsTo: 'server: test read_agenda', writes: false, spend: null,
  mayAsk: async (_ctx, askedBy) => (askedBy === ALICE ? true : { refusal: 'Only the host can ask for the agenda.' }),
  run: async () => ({ line: AGENDA, kind: 'agenda' }),
};
const STANDUP: ServerToolFamily<{ callId: string }> = {
  family: FAMILY, tenants: ['orgiq'], tools: [READ_AGENDA],
  context: async (call) => ({ callId: call.callId }),
  backendInstructions: () => 'Call read_agenda when someone asks for the agenda.',
  whatICanDo: async () => 'I can read the agenda.',
  log: async (_ctx, _by, said, via) => { logged.push({ line: said.line, kind: said.kind, via }); },
};
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let now: number;
let store: MemoryAssistantStore;
let intake: LineIntake;
let runtime: AssistantRuntime;
let offTools: () => void;
let offPolicy: () => void;
let offRules: () => void;
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };

async function startCall(lobby: string): Promise<void> {
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby, initiativeId: null, state: 'listening', invitedBy: ALICE, invitedAt: now,
    pausedBy: null, leftAt: null, leftBy: null, acked: [ALICE, BOB], attendees: [ALICE, BOB], presentAtInvite: [ALICE, BOB],
    requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
  runtime = new AssistantRuntime({
    store: () => store, intake: () => intake, clock: () => now, makeSession: () => new ScriptedSession(() => now), rolesOf: async () => ['member'],
    voiceSink: () => true,
  }, { tickMs: 0 });
  await runtime.start({ callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice', 'Bob'], recordName: 'Stand-up' });
  await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
}
const ask = async (text: string, by = ALICE) => { await intake.handle(CALL, { userId: by, text, at: now }); now += 5000; await intake.tick(); await flush(); await new Promise((r) => setTimeout(r, 100)); await flush(); };

beforeAll(() => {
  offTools = registerServerTools(STANDUP);
  // The family's policy spreads in the tool answers and writes no tool code of its own.
  offPolicy = registerMeetingAssistantPolicy(FAMILY, { ...DEFAULT_POLICY, id: 'standup', relaysLiveSpeech: () => false, ...serverToolPolicy(FAMILY) });
  // The scripted session's stand-in for the background agent: "the agenda" calls the tool.
  offRules = addScriptRules([{ id: 'standup-agenda', match: /\bagenda\b/i, run: () => ({ call: { name: 'read_agenda', args: {} } }) }]);
});
afterAll(() => { offRules(); offPolicy(); offTools(); });
beforeEach(() => {
  now = Date.parse('2026-11-18T09:00:00.000Z'); mockApproved.length = 0; mockTrace.length = 0; logged.length = 0; resetServerTools();
  store = new MemoryAssistantStore(); setAssistantStore(store);
  const source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  intake.start(CALL);
});
afterEach(async () => { await runtime?.dispose(); intake.dispose(); setAssistantStore(null); });

describe('a family registered in a few lines (server-tools.ts)', () => {
  it('its tool is offered to its calls, run on the model\'s call through the orchestrator, logged by the family and posted as approved words', async () => {
    await startCall(`${FAMILY}:daily`);
    expect((runtime.sessionOf(CALL) as ScriptedSession).startInput?.tools.map((t) => t.name)).toEqual(['read_agenda']);
    await ask('Milo, what is on the agenda today?');
    expect(mockApproved).toEqual([AGENDA]);
    expect(logged).toEqual([{ line: AGENDA, kind: 'agenda', via: 'model' }]);
    expect(mockTrace.some((t) => t.ev === 'server.tool' && t.f['via'] === 'model' && t.f['outcome'] === 'ran')).toBe(true);
  });

  it('its refusal is the tool\'s own sentence, logged as a refusal', async () => {
    await startCall(`${FAMILY}:daily2`);
    await ask('Milo, read us the agenda', BOB);
    expect(mockApproved).toEqual(['Only the host can ask for the agenda.']);
    expect(logged.map((l) => l.kind)).toEqual(['refusal']);
  });

  it('no other family is offered it or runs it, and the runner does not assume a voice (a button or a typed request runs it the same way)', async () => {
    const other = { callId: 'c2', lobby: 'orgiq:initiative:p-1', tenant: 'orgiq' };
    expect((await serverToolPolicy(FAMILY).sessionTools(other)).tools).toEqual([]);
    expect(await runServerTool(other, ALICE, 'read_agenda', {}, 'model')).toBeNull();
    const mine = { callId: 'c3', lobby: `${FAMILY}:weekly`, tenant: 'orgiq' };
    expect(await runServerTool(mine, ALICE, 'read_agenda', {}, 'typed')).toEqual({ line: AGENDA, retry: false });
    expect(logged.map((l) => l.via)).toEqual(['typed']);
  });
});
