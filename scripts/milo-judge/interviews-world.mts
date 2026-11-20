// The interviews tenant as an interview call has it: the policy REGISTERED for the lobby family `interviews:interview`
// (middleware/src/lib/interviews/milo-policy.ts `registerInterviewsMiloPolicy`, which calls `registerMeetingAssistantPolicy`), looked
// up the way the orchestrator looks it up (`policyForLobby` of the call's lobby, then `turnPolicyOf`).
//
// So an interviews scenario is judged on the product's own roles (the live interview's lead, panel and candidate), its tools as the
// registered family offers and runs them (server-tools.ts `runServerTool`: time_left, repeat_question, introduce, pad_write), its
// Decide instructions and state string, its fixed lines, its said log, and its rule for whose lines a model may read. The judge hands
// the turn owner no `act` and no `modelReads` for these scenarios: both are the product's defaults.
//
// What the judge supplies is the world behind the tenant, through the seams the tenant's own tests use (`setMiloToolDeps`,
// `setSpeakDeps`, `setSaidStore`, `setInterviewConsentSource`), one room per scenario run, found by interview id:
//   * the interview record: live, a technical round on the code pad, the scenario's lead and panel, its minutes, its start;
//   * the candidate as a guest of that interview (`guest:<id>`), and their answer about Milo (`declined`: the transcript, not Milo);
//   * the said log in memory, holding the question Milo last asked when the round has one;
//   * a board round (`round.surface: 'board'`): its question as the candidate holds it, a drawn board, an answer key with made-up
//     names (truth.mts JUDGE_ANSWER_KEY) and the probe writer asked live through the product's own request (probe.ts);
//   * the lead's pad-help switch as it starts (off), no kit questions in a pad round, and a pad that takes nothing: the pad writer's model is not
//     called, the request it was handed is counted, and the pad tool then says its own sentence for a request it did not write;
//   * the tenant's clock: the scenario's fake clock, carried per scenario run (scenarios run side by side);
//   * the money for a spoken line (`holdSpeech`): granted. The budget stores are not part of the judge; it is the one member of the
//     registered policy the judge answers itself.
// Every AWS provider is its mock and nothing here reaches a cloud.
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeClock } from './fake-clock.mts';
import type { Scenario } from './types.mts';
import { JUDGE_ANSWER_KEY, T0 } from './truth.mts';
import type { MeetingAssistantPolicy, PolicyCall } from '../../middleware/src/lib/meeting-assistant/policy.ts';
import type { TurnPolicy } from '../../middleware/src/lib/meeting-assistant/turn/types.ts';
import type { Interview } from '../../middleware/src/lib/interviews/types.ts';
import type { MiloToolDeps } from '../../middleware/src/lib/interviews/milo-tools/deps.ts';
import type { ProbeInput } from '../../middleware/src/lib/interviews/milo-tools/probe.ts';
import type { TextToolReply, TextToolRequest } from '../../middleware/src/lib/voice/openai-text.ts';
import type { MemoryMiloSettingsStore } from '../../middleware/src/lib/interviews/milo-settings.ts';
import type { InterviewConsentSource } from '../../middleware/src/lib/interviews/milo-policy.ts';
import type { MemorySaidStore, SpeakDeps } from '../../middleware/src/lib/interviews/speak/index.ts';

// Read by the product's config when it is first loaded (by the turn owner's own imports): mock providers, no startup probe.
for (const k of ['MOCK_AURORA', 'MOCK_AGENTCORE', 'MOCK_GUARDRAILS', 'MOCK_CLOUDWATCH']) process.env[k] ??= 'true';
process.env.CAPABILITY_STARTUP_CHECK ??= 'off';

const here = dirname(fileURLToPath(import.meta.url));
const lib = (path: string): string => resolve(here, '../../middleware/src/lib', path);

export const INTERVIEWS = 'interviews';
/** The tenant a scenario is set in: `tenant` when it names one, else interviews (every scenario with a round, a lead, a panel and a candidate). */
export const tenantOf = (s: Scenario): string => s.tenant ?? INTERVIEWS;

/** The fake clock of the scenario run the caller is inside (owner-adapter.mts runs each scenario under it). */
export const scenarioClock = new AsyncLocalStorage<FakeClock>();
const now = (): number => {
  const clock = scenarioClock.getStore();
  if (!clock) throw new Error('milo judge: the interviews clock was read outside a scenario run');
  return clock.now();
};

interface Room { interview: Interview; guests: Set<string>; declined: boolean; startMs: number; padRequests: number; surface: 'pad' | 'board'; question: string | null }

/** The board of a board round as the candidate has drawn it: two frames, the newest change in "Redirect path". */
const JUDGE_BOARD: Array<Record<string, unknown>> = [
  { id: 'f1', type: 'frame', name: 'Create path', x: 0, y: 0, width: 600, height: 400, updated: 100 },
  { id: 'f2', type: 'frame', name: 'Redirect path', x: 800, y: 0, width: 600, height: 400, updated: 100 },
  { id: 't1', type: 'text', text: 'API gateway', frameId: 'f1', x: 20, y: 20, updated: 200 },
  { id: 't2', type: 'text', text: 'Shortener service', frameId: 'f1', x: 20, y: 120, updated: 300 },
  { id: 't3', type: 'text', text: 'CDN edge', frameId: 'f2', x: 820, y: 20, updated: 800 },
  { id: 't4', type: 'text', text: 'Redis cache', frameId: 'f2', x: 820, y: 120, updated: 900 },
  { id: 't5', type: 'text', text: 'Key-value store', frameId: 'f2', x: 820, y: 220, updated: 950 },
];
/** Is the owner rig scripted (owner-adapter.mts `ownerScripted`)? Then a probe is the product's scripted stand-in, with no model. */
const scriptedRun = (): boolean => { const v = (process.env.MILO_JUDGE_OWNER_MODEL ?? '').trim(); return v === 'scripted' || (v !== 'live' && !!process.env.NODE_TEST_CONTEXT); };
const rooms = new Map<string, Room>();
const byCall = new Map<string, Room>();

interface Product {
  policy: MeetingAssistantPolicy;
  turn: TurnPolicy;
  callOf: (interviewId: string) => PolicyCall;
  said: MemorySaidStore;
}
let product: Promise<Product> | null = null;

/** Register the interviews policy and put the judge's rooms behind the tenant's stores. Once per process. */
function load(): Promise<Product> {
  return (product ??= (async () => {
    const policies = await import(lib('meeting-assistant/policy.ts')) as {
      policyForLobby(lobby: string): MeetingAssistantPolicy; turnPolicyOf(p: MeetingAssistantPolicy): TurnPolicy | null;
    };
    const registered = await import(lib('interviews/milo-policy.ts')) as {
      registerInterviewsMiloPolicy(env: NodeJS.ProcessEnv): boolean; setInterviewConsentSource(fn: InterviewConsentSource | null): void;
    };
    const tools = await import(lib('interviews/milo-tools/index.ts')) as {
      interviewCall(interviewId: string): PolicyCall; setMiloToolDeps(next: Partial<MiloToolDeps> | null): void;
    };
    const speak = await import(lib('interviews/speak/index.ts')) as {
      MemorySaidStore: new () => MemorySaidStore; setSaidStore(store: MemorySaidStore | null): void; setSpeakDeps(next: Partial<SpeakDeps> | null): void;
    };
    const probe = await import(lib('interviews/milo-tools/probe.ts')) as {
      PROBE_TIMEOUT_MS: number; probeRequest(input: ProbeInput): TextToolRequest; probeOf(reply: Pick<TextToolReply, 'call'>): string | null; scriptedProbe(input: ProbeInput): string;
    };
    const text = await import(lib('voice/openai-text.ts')) as { requestToolChoice(req: TextToolRequest, opts: { timeoutMs: number }): Promise<TextToolReply> };
    const { MemoryMiloSettingsStore: Settings } = await import(lib('interviews/milo-settings.ts')) as { MemoryMiloSettingsStore: new () => MemoryMiloSettingsStore };

    if (!registered.registerInterviewsMiloPolicy({ ...process.env, INTERVIEWS_ENABLED: '1' })) throw new Error('milo judge: the interviews policy did not register');
    const callOf = tools.interviewCall;
    const policy = policies.policyForLobby(callOf('judge-probe').lobby!);
    const turn = policy.id === INTERVIEWS ? policies.turnPolicyOf(policy) : null;
    if (!turn) throw new Error(`milo judge: an interview call's registered policy (${policy.id}) has no turn contract`);

    const said = new speak.MemorySaidStore();
    const settings = new Settings();
    let ids = 0;
    const newId = (): string => `said-judge-${++ids}`;
    speak.setSaidStore(said);
    speak.setSpeakDeps({
      callOf: async (interview) => rooms.get(interview.id)?.interview.callId ?? null,
      miloJoinedAt: async (callId) => byCall.get(callId)?.startMs ?? null,
      now, newId,
    });
    registered.setInterviewConsentSource(async (interviewId) => {
      const room = rooms.get(interviewId);
      return room ? { recording: false, transcription: true, milo: !room.declined } : null;
    });
    tools.setMiloToolDeps({
      interview: async (interviewId) => rooms.get(interviewId)?.interview ?? null,
      guestOf: async (userId, interviewId) => rooms.get(interviewId)?.guests.has(userId) ?? false,
      settings: (interviewId) => settings.get(interviewId),
      // A board round has its question as the candidate holds it; the answer key goes to the tool's check only, never to the writer.
      questions: async (interview) => { const room = rooms.get(interview.id); return room?.surface === 'board' && room.question ? [{ id: 'judge-question', prompt: room.question, followUps: [], competencyId: 'system-design', roundType: 'technical' }] : []; },
      surface: async (interview) => rooms.get(interview.id)?.surface ?? 'pad',
      board: async (interview) => (rooms.get(interview.id)?.surface === 'board' ? JUDGE_BOARD : null),
      heard: async () => [],
      answerKey: async () => [...JUDGE_ANSWER_KEY],
      // The product's own request and reply parsing (probe.ts), asked live; the interview's money is not part of the judge.
      prober: async (_interview, input: ProbeInput) => {
        if (scriptedRun()) return probe.scriptedProbe(input);
        const reply = await text.requestToolChoice(probe.probeRequest(input), { timeoutMs: probe.PROBE_TIMEOUT_MS });
        return probe.probeOf(reply);
      },
      write: async (_interviewId, plan) => { await plan({ text: '', language: 'python' }); return { ok: false, code: 'nothing' }; },
      padLog: async () => 0,
      judge: async () => 'helper',
      writer: async (interview) => { const room = rooms.get(interview.id); if (room) room.padRequests += 1; return null; },
      now, newId,
    });
    return { policy, turn: { ...turn, holdSpeech: async () => ({ release: async () => {} }) }, callOf, said };
  })());
}

export interface InterviewRoom {
  call: PolicyCall;
  /** The registered interviews policy's turn contract (the money for a line granted). */
  policy: TurnPolicy;
  /** The registered policy's id: `interviews`. */
  policyId: string;
  /** A scenario person's id in the call: the candidate is a guest of this interview. */
  uid(id: string): string;
  /** The pad requests the pad tool has handed to its writer so far. */
  padRequests(): number;
  close(): void;
}

let runs = 0;

/** One scenario run's interview, live, with its people, its round and its question, behind the registered policy. */
export async function openInterview(s: Scenario): Promise<InterviewRoom> {
  const p = await load();
  const id = `judge-${s.id}-${++runs}`.replace(/:/g, '-');
  const call = p.callOf(id);
  const startMs = T0 + s.round.startedAtMs;
  const startedAt = new Date(startMs).toISOString();
  const uid = (person: string): string => (s.people.find((x) => x.id === person)?.role === 'candidate' ? `guest:${person}` : person);
  const interview = {
    id, leadId: s.people.find((x) => x.role === 'lead')?.id ?? 'judge-nobody', panelIds: s.people.filter((x) => x.role === 'panellist').map((x) => x.id),
    state: 'live', type: 'technical', callId: `call-${id}`, minutes: s.round.minutes, scheduledAt: startedAt, questionIds: [], applicationId: 'judge',
  } as unknown as Interview;
  const room: Room = {
    interview, startMs, padRequests: 0, surface: s.round.surface ?? 'pad', question: s.round.question,
    guests: new Set(s.people.filter((x) => x.role === 'candidate').map((x) => uid(x.id))),
    declined: s.people.some((x) => x.role === 'candidate' && x.declined),
  };
  rooms.set(id, room);
  byCall.set(interview.callId!, room);
  if (s.round.question) {
    await p.said.append({
      id: `question-${id}`, interviewId: id, callId: interview.callId, kind: 'question', source: 'kit', questionId: 'judge-question', suggestionId: null,
      text: s.round.question, askedBy: interview.leadId, saidAt: startedAt, posted: true, spoken: true,
    });
  }
  return {
    call, policy: p.turn, policyId: p.policy.id, uid,
    padRequests: () => room.padRequests,
    close: () => { rooms.delete(id); byCall.delete(interview.callId!); },
  };
}
