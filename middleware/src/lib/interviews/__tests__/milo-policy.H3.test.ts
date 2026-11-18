// Milo's policy for an interview call (lib/interviews/milo-policy.ts, row I3.2), the edges hardening lane H3 owes:
//   O-099  the candidate's audio is admitted only when they accepted the transcript (Milo or not), shown on the seat itself: the
//          policy's answer becomes the record's acknowledgement (as routes/meeting-assistant.ts does at the invite and when a
//          seat is taken), and the audio intake then mixes or drops the guest's chunks;
//   O-101  the decision watcher's checks are booked on the opening, never on the lead's budget;
//   O-103  the listening limit is the round's minutes plus 15, and nothing extends past it (the route's words are pinned in
//          routes/__tests__/meeting-assistant-interviews.test.ts).
// The seeded round iv-n5z9f2cq (op-em): lead u-wen, panel u-hugo.
jest.mock('../../../config.js', () => ({
  config: {
    region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true },
    meetingAssistant: { enabled: true, transcriptRetentionDays: 30 },
  },
}));
jest.mock('../../meeting-assistant/chat.js', () => ({
  nameOf: async (id: string) => id, postReply: async () => ({ id: 'm' }), postPrivately: async () => true, postNoticeQuietly: async () => undefined,
  postAction: async () => ({ message: { id: 'm' }, created: true }), moveAction: async () => null,
}));

import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { spendHolds } from '../../../mock/spend-holds.js';
import { spendEntries } from '../../../mock/spend-ledger.js';
import { userSpendThisPeriod } from '../../../providers/user-budgets.js';
import { AudioIntake } from '../../meeting-assistant/audio-intake.js';
import { LineIntake } from '../../meeting-assistant/intake.js';
import { int16ToPcm } from '../../meeting-assistant/mixer.js';
import { AssistantRuntime } from '../../meeting-assistant/orchestrator.js';
import { limitsOfCall, payerFields, type PolicyCall } from '../../meeting-assistant/policy.js';
import { SessionEmitter, SessionTextUnsupported, type LiveMeetingSession, type SessionStartInput } from '../../meeting-assistant/session.js';
import { realWatcherSpend, watcherSourceId } from '../../meeting-assistant/spend.js';
import { MemoryAssistantStore } from '../../meeting-assistant/store.js';
import { setAssistantStore } from '../../meeting-assistant/store-select.js';
import { MockTranscriptSource } from '../../meeting-assistant/transcript-source.js';
import { newAssistantSession, sessionOf, type AssistantRecord } from '../../meeting-assistant/types.js';
import { MemoryInviteStore, setInviteStore } from '../invite/store.js';
import {
  INTERVIEWS_MILO_POLICY as P, LISTEN_PAST_ROUND_MINUTES, registerInterviewsMiloPolicy, setInterviewConsentSource, unregisterInterviewsMiloPolicy,
} from '../milo-policy.js';
import { interviewSpendState } from '../spend.js';

const IV = 'iv-n5z9f2cq';
const LOBBY = `interviews:interview:${IV}`;
const CALL_ID = 'call-nadia';
const CALL: PolicyCall = { callId: CALL_ID, lobby: LOBBY, tenant: 'interviews' };
const LEAD = 'u-wen'; const PANEL = 'u-hugo';
const ARN = 'arn:aws:ivs:us-east-1:000000000000:channel/room-iv';
const T0 = Date.parse('2026-11-17T10:00:00.000Z');

let guestId: string;

beforeEach(async () => {
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  setInviteStore(new MemoryInviteStore());
  const { inviteStore } = await import('../invite/store.js');
  const inv = await inviteStore().issueInvite({ interviewId: IV, tokenHash: 'b'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  guestId = `guest:${inv.id}`;
  setInterviewConsentSource(null);
});
afterAll(() => { setInviteStore(null); setInterviewConsentSource(null); unregisterInterviewsMiloPolicy(); });

// ── O-099: the seat's admission ─────────────────────────────────────────────────────────────────────────────────────────

class FakeSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const; readonly acceptsText = false;
  readonly frames: Buffer[] = [];
  async start(_i: SessionStartInput) { /* nothing */ }
  appendAudio(b: Buffer) { this.frames.push(b); }
  pendingInputText() { return ''; }
  sendText(): void { throw new SessionTextUnsupported(); }
  answerToolCall() { return false; } appendContext() { return true; }
  async close() { this.emit('closed', { reason: 'closed' }); }
}

const tone = (ms: number): Buffer => int16ToPcm(Int16Array.from({ length: Math.round(ms * 16) }, (_, i) => Math.round(8000 * Math.sin(2 * Math.PI * 300 * (i / 16000)))));
const headers = (participantId: string) => ({ channelArn: ARN, participantId, sampleRate: '16000', encoding: 'pcm_s16le', channels: '1' });

describe('O-099: the candidate\'s audio and their answers', () => {
  let now: number; let store: MemoryAssistantStore; let intake: LineIntake; let audio: AudioIntake; let runtime: AssistantRuntime; let token: string;

  /** Milo is invited with the guest present: the record's acknowledgements are the lead and whoever the policy says acknowledged elsewhere (the invite route's `ackedElsewhereAt`). */
  async function inviteWith(present: string[]): Promise<void> {
    now = T0;
    store = new MemoryAssistantStore(); setAssistantStore(store);
    const source = new MockTranscriptSource();
    intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
    intake.start(CALL_ID);
    audio = new AudioIntake(() => store, { clock: () => now, tickMs: 0 });
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => new FakeSession(), rolesOf: async () => ['interviewer'], audio }, { tickMs: 0 });
    const elsewhere = present.filter((u) => u !== LEAD && P.acknowledgement(CALL, u) === 'elsewhere');
    const acked = [LEAD, ...(elsewhere.length ? await P.acknowledgedElsewhere!(CALL, elsewhere) : [])];
    await store.create({
      callId: CALL_ID, tenant: 'interviews', lobby: LOBBY, initiativeId: null, state: 'listening', invitedBy: LEAD, invitedAt: now, pausedBy: null, leftAt: null, leftBy: null,
      acked, attendees: [LEAD, PANEL, ...present], presentAtInvite: [LEAD, PANEL, ...present], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
    } as AssistantRecord);
    await runtime.start({ callId: CALL_ID, tenant: 'interviews', inviterId: LEAD, roster: ['Wen', 'Hugo', 'Candidate'], recordName: null, lobby: LOBBY });
    token = await audio.arm(CALL_ID, ARN);
    await audio.bindParticipant(CALL_ID, 'pid-guest', guestId);
    await audio.bindParticipant(CALL_ID, 'pid-lead', LEAD);
  }

  /** A seat taken after the invite: the seat route's `ackElsewhere`, which asks the policy for this one person and refreshes the gate. */
  async function takeSeat(userId: string): Promise<void> {
    const record = (await store.get(CALL_ID))!;
    if (record.acked.includes(userId) || P.acknowledgement(CALL, userId) !== 'elsewhere') return;
    if (!(await P.acknowledgedElsewhere!(CALL, [userId])).includes(userId)) return;
    await store.ack(CALL_ID, userId);
    await audio.refresh(CALL_ID);
  }

  const speak = (pid: string) => audio.accept(token, headers(pid), tone(200));

  afterEach(async () => { await runtime.dispose(); audio.dispose(); intake.dispose(); setAssistantStore(null); });

  it.each([
    ['nothing answered', null],
    ['the transcript declined', { transcription: false, milo: false }],
  ])('with %s the guest\'s audio is never admitted, at the invite or on taking a seat', async (_l, answer) => {
    setInterviewConsentSource(async () => answer);
    await inviteWith([guestId]);
    expect((await store.get(CALL_ID))!.acked).toEqual([LEAD]);
    expect(speak('pid-guest')).toBe('unacked');
    await takeSeat(guestId);
    expect((await store.get(CALL_ID))!.acked).toEqual([LEAD]);
    expect(speak('pid-guest')).toBe('unacked');
    expect(speak('pid-lead')).toBe('mixed');
    await audio.flush(CALL_ID);
    expect(sessionOf((await store.get(CALL_ID))!).unackedChunks).toBe(2);
  });

  it('with the transcript accepted and Milo declined the guest is transcribed (admitted at the invite and on the seat)', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: false }));
    await inviteWith([guestId]);
    expect((await store.get(CALL_ID))!.acked).toEqual([LEAD, guestId]);
    expect(speak('pid-guest')).toBe('mixed');
  });

  it('with both accepted the guest present at the invite is admitted at once', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: true }));
    await inviteWith([guestId]);
    expect((await store.get(CALL_ID))!.acked).toEqual([LEAD, guestId]);
    expect(speak('pid-guest')).toBe('mixed');
  });

  it('with both accepted a guest who takes the seat after the invite is admitted on the seat, and only then', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: true }));
    await inviteWith([]);
    expect(speak('pid-guest')).toBe('unacked');
    await takeSeat(guestId);
    expect((await store.get(CALL_ID))!.acked).toEqual([LEAD, guestId]);
    expect(speak('pid-guest')).toBe('mixed');
  });

  it('a guest id minted for another interview is never admitted on this call\'s seat, whatever this interview\'s answers', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: true }));
    const { inviteStore } = await import('../invite/store.js');
    const other = await inviteStore().issueInvite({ interviewId: 'iv-k1p5w8ra', tokenHash: 'c'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const stranger = `guest:${other.id}`;
    await inviteWith([stranger]);
    await audio.bindParticipant(CALL_ID, 'pid-stranger', stranger);
    await takeSeat(stranger);
    expect((await store.get(CALL_ID))!.acked).toEqual([LEAD]);
    expect(speak('pid-stranger')).toBe('unacked');
  });
});

// ── O-101: the watcher's spend ──────────────────────────────────────────────────────────────────────────────────────────

describe('O-101: the decision watcher\'s checks land on the opening', () => {
  it('a watch check is booked under the interviews source, attributed to this interview and its opening, and on nobody\'s budget', async () => {
    registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' });
    interviewsFixture.rows().find((i) => i.id === IV)!.callId = CALL_ID;
    const rec = { callId: CALL_ID, tenant: 'interviews', lobby: LOBBY, initiativeId: null, invitedBy: LEAD } as unknown as AssistantRecord;
    // What the watcher's `book` sends (decision-watcher.ts): the call, the record's payer fields, the check's number.
    await realWatcherSpend.record({ callId: CALL_ID, ...payerFields(rec), n: 1, model: 'amazon.nova-lite-v1:0', costUsd: 0.004, basis: 'reported', tokensIn: 1200, tokensOut: 40 });
    await realWatcherSpend.record({ callId: CALL_ID, ...payerFields(rec), n: 2, model: 'amazon.nova-lite-v1:0', costUsd: 0.004, basis: 'reported', tokensIn: 1200, tokensOut: 40 });
    const rows = spendEntries.rows().filter((e) => String(e.sourceId).startsWith(`ma:${CALL_ID}:watch:`));
    expect(rows.map((e) => e.sourceId)).toEqual([watcherSourceId(CALL_ID, 1), watcherSourceId(CALL_ID, 2)]);
    for (const row of rows) expect(row).toMatchObject({ source: 'interviews', initiativeId: null });
    const state = await interviewSpendState({ openingId: 'op-em', interviewId: IV });
    expect(state.interview.spentUsd).toBeCloseTo(0.008, 6);
    expect(state.opening.spentUsd).toBe(state.interview.spentUsd);
    expect((await userSpendThisPeriod(LEAD)).spentUsd).toBe(0);
    // Another opening's interview is not charged.
    const other = await interviewSpendState({ openingId: 'op-backend', interviewId: 'iv-k1p5w8ra' }).catch(() => null);
    if (other) expect(other.interview.spentUsd).toBe(0);
  });
});

// ── O-103: the listening limit ──────────────────────────────────────────────────────────────────────────────────────────

describe('O-103: the round plus 15, never more', () => {
  beforeEach(() => { registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' }); });

  it('is the round\'s minutes plus 15 for a 45-minute and a 90-minute round, as both the first ceiling and the most', async () => {
    const iv = interviewsFixture.rows().find((i) => i.id === IV)!;
    expect(LISTEN_PAST_ROUND_MINUTES).toBe(15);
    for (const minutes of [45, 90]) {
      iv.minutes = minutes;
      expect(await P.listeningLimitMinutes!(CALL)).toBe(minutes + 15);
      expect(await limitsOfCall(CALL)).toMatchObject({ maxSeconds: (minutes + 15) * 60, hardMaxSeconds: (minutes + 15) * 60 });
    }
  });

  it('an unreadable length (zero, negative, not a number) is read as 60, so the limit is 75', async () => {
    const iv = interviewsFixture.rows().find((i) => i.id === IV)!;
    for (const minutes of [0, -30, Number.NaN]) {
      iv.minutes = minutes;
      expect(await P.listeningLimitMinutes!(CALL)).toBe(75);
    }
  });

  it('an extend at the limit adds nothing: the runtime refuses it as already at its longest', async () => {
    const iv = interviewsFixture.rows().find((i) => i.id === IV)!;
    const store = new MemoryAssistantStore(); setAssistantStore(store);
    const now = T0;
    const source = new MockTranscriptSource();
    const intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
    const runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => new FakeSession(), rolesOf: async () => ['interviewer'] }, { tickMs: 0 });
    const ceiling = (iv.minutes + 15) * 60;
    await store.create({
      callId: CALL_ID, tenant: 'interviews', lobby: LOBBY, initiativeId: null, state: 'listening', invitedBy: LEAD, invitedAt: now, pausedBy: null, leftAt: null, leftBy: null,
      acked: [LEAD], attendees: [LEAD], presentAtInvite: [LEAD], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: { ...newAssistantSession(ceiling), listeningSince: now },
    } as AssistantRecord);
    try {
      await runtime.start({ callId: CALL_ID, tenant: 'interviews', inviterId: LEAD, roster: ['Wen'], recordName: null, lobby: LOBBY });
      const out = await runtime.extend(CALL_ID, { sub: LEAD }, false);
      expect(out).toEqual({ ok: false, why: 'at-maximum' });
      expect(sessionOf((await store.get(CALL_ID))!).ceilingSeconds).toBe(ceiling);
    } finally {
      await runtime.dispose(); intake.dispose(); setAssistantStore(null);
    }
  });
});
