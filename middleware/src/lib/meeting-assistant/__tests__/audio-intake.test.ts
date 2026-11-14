// The PCM sink's rules (docs/meeting-assistant-design.md decisions 1, 2, 8, 9), against the real runtime, store, intake and mixer
// with a stand-in provider session: the token, the participant map, the acknowledgement gate, pause and leave, session replacement,
// and who a transcript piece is attributed to when it is made from the audio the provider actually received.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => id, postReply: async () => ({ id: 'm' }), postPrivately: async () => true, postNoticeQuietly: async () => undefined,
  postAction: async () => ({ message: { id: 'm' }, created: true }), moveAction: async () => null,
}));

import { createHash } from 'node:crypto';
import { AudioIntake, hashToken } from '../audio-intake.js';
import { FRAME_MS, OUT_RATE, int16ToPcm, pcmToInt16 } from '../mixer.js';
import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime, type StartContext } from '../orchestrator.js';
import { SessionEmitter, SessionTextUnsupported, type LiveMeetingSession, type SessionStartInput } from '../session.js';
import { newAssistantSession, sessionOf } from '../types.js';
import { setAssistantStore } from '../store-select.js';

const CALL = 'call-1', ARN = 'arn:aws:ivs:us-east-1:000000000000:channel/room-1';
const ANA = 'u-ana', BEN = 'u-ben', CY = 'u-cy', DEE = 'u-dee';
const PID = { ana: `${ANA}-lq1a2b`, ben: `${BEN}-lq1a2c`, cy: `${CY}-lq1a2d`, dee: `${DEE}-lq1a2e` };
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r)); };

class FakeSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const; readonly acceptsText = false;
  readonly frames: Buffer[] = [];
  async start(_i: SessionStartInput) { /* nothing */ }
  appendAudio(b: Buffer) { this.frames.push(b); }
  sendText(): void { throw new SessionTextUnsupported(); }
  answerToolCall() { return false; } appendContext() { return true; }
  async close() { this.emit('closed', { reason: 'closed' }); }
  hear(text: string, startMs: number, endMs: number) { this.emit('inputTranscript', { text, startMs, endMs }); }
  drop() { this.emit('closed', { reason: 'socket-closed' }); }
  /** What the provider heard: the voiced spans of the frames it received, on the session timeline. */
  spans(): Array<{ startMs: number; endMs: number }> {
    const out: Array<{ startMs: number; endMs: number }> = [];
    this.frames.forEach((f, k) => {
      const s = pcmToInt16(f); let sum = 0; for (const v of s) sum += v * v;
      if (Math.sqrt(sum / s.length) > 400) {
        const last = out[out.length - 1];
        if (last && last.endMs === k * FRAME_MS) last.endMs = (k + 1) * FRAME_MS; else out.push({ startMs: k * FRAME_MS, endMs: (k + 1) * FRAME_MS });
      }
    });
    return out;
  }
}

const sine = (hz: number, ms: number, phase = 0): Buffer => int16ToPcm(Int16Array.from({ length: Math.round(ms * 16) }, (_, i) => Math.round(8000 * Math.sin(2 * Math.PI * hz * ((i + phase) / 16000)))));
const headers = (participantId: string, over: Partial<Record<string, string>> = {}) => ({ channelArn: ARN, participantId, sampleRate: '16000', encoding: 'pcm_s16le', channels: '1', ...over });

let now: number;
let store: MemoryAssistantStore;
let source: MockTranscriptSource;
let intake: LineIntake;
let audio: AudioIntake;
let runtime: AssistantRuntime;
let sessions: FakeSession[];
let token: string;
const ctx: StartContext = { callId: CALL, tenant: 'orgiq', inviterId: ANA, roster: ['Ana', 'Ben', 'Cy'], recordName: null };
const session = () => sessions[sessions.length - 1]!;

async function setUp(acked: string[]): Promise<void> {
  now = T0; sessions = [];
  store = new MemoryAssistantStore(); setAssistantStore(store);
  source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  intake.start(CALL);
  audio = new AudioIntake(() => store, { clock: () => now, tickMs: 0 });
  runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => { const s = new FakeSession(); sessions.push(s); return s; },
    rolesOf: async () => ['member'], audio }, { tickMs: 0 });
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby: 'orgiq:dm:a:b:c', initiativeId: null, state: 'listening', invitedBy: ANA, invitedAt: now, pausedBy: null, leftAt: null, leftBy: null,
    acked, attendees: [ANA, BEN, CY], presentAtInvite: [ANA, BEN, CY], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
  await runtime.start(ctx);
  token = await audio.arm(CALL, ARN);
  for (const [who, id] of [[ANA, PID.ana], [BEN, PID.ben], [CY, PID.cy]] as const) await audio.bindParticipant(CALL, id, who);
}
afterEach(async () => { await runtime.dispose(); audio.dispose(); intake.dispose(); setAssistantStore(null); });

/** One speaker talks for `ms`, 200 ms of audio at a time at real-time pace; everyone else's chunks are not sent (a tap sends nothing in silence). */
async function speak(who: keyof typeof PID, hz: number, ms: number, tok = token): Promise<string[]> {
  const results: string[] = [];
  for (let t = 0; t < ms; t += 200) {
    results.push(audio.accept(tok, headers(PID[who]), sine(hz, 200, t * 16)));
    now += 200; await audio.tick();
  }
  return results;
}
const quiet = async (ms: number) => { for (let t = 0; t < ms; t += 100) { now += 100; await audio.tick(); } };
const send = async (frames: Array<{ who: keyof typeof PID; hz: number }>) => { for (const f of frames) audio.accept(token, headers(PID[f.who]), sine(f.hz, 200)); };

describe('the sink token', () => {
  beforeEach(() => setUp([ANA, BEN, CY]));

  it('lets a chunk in only with the live token and the call\'s own channel; everything else looks the same', () => {
    expect(audio.admit(token, ARN)).toBe('ok');
    expect(audio.admit(token, `${ARN}x`)).toBe('unknown');
    expect(audio.admit(token, undefined)).toBe('unknown');
    expect(audio.admit(`${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`, ARN)).toBe('unknown');
    expect(audio.admit('short', ARN)).toBe('unknown');
    expect(audio.admit('A'.repeat(43), ARN)).toBe('unknown');
    expect(audio.accept(token, headers(PID.ana, {}), sine(300, 200))).toBe('mixed');
    expect(audio.accept('A'.repeat(43), headers(PID.ana), sine(300, 200))).toBe('unknown');
  });

  it('is 32 random bytes, and only its hash is kept on the record', async () => {
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const rec = (await store.get(CALL))!;
    expect(sessionOf(rec).sinkTokenHash).toBe(createHash('sha256').update(token).digest('base64url'));
    expect(JSON.stringify(rec)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(32);
  });

  it('dies the moment the assistant is paused, and a resumed call gets a new token (the old one stays dead)', async () => {
    expect(audio.admit(token, ARN)).toBe('ok');
    await store.transition(CALL, { from: ['listening'], to: 'paused', by: BEN, at: now });
    await runtime.pause(CALL);
    expect(audio.admit(token, ARN)).toBe('unknown');
    expect(audio.accept(token, headers(PID.ana), sine(300, 200))).toBe('unknown');
    expect((await store.get(CALL))!.session?.sinkTokenHash).toBeNull();
    await store.transition(CALL, { from: ['paused'], to: 'listening', by: BEN, at: now });
    await runtime.resume(CALL);
    expect(audio.admit(token, ARN)).toBe('unknown');
    const fresh = await audio.arm(CALL, ARN);
    expect(fresh).not.toBe(token);
    expect(audio.admit(fresh, ARN)).toBe('ok');
    expect(audio.admit(token, ARN)).toBe('unknown');
  });

  it('dies when the assistant leaves', async () => {
    await store.transition(CALL, { from: ['listening'], to: 'left', by: ANA, at: now });
    await runtime.stop(CALL);
    expect(audio.admit(token, ARN)).toBe('unknown');
    expect(audio.accept(token, headers(PID.ana), sine(300, 200))).toBe('unknown');
  });

  it('is rate limited per token, generously: a tap\'s five chunks a second for eight speakers never trips it', () => {
    let limited = 0;
    for (let i = 0; i < 400; i += 1) if (audio.admit(token, ARN) === 'limited') limited += 1;
    expect(limited).toBeGreaterThan(150);
    now += 1000;
    expect(audio.admit(token, ARN)).toBe('ok');
    // Forty chunks a second for ten seconds (8 speakers x 5) is fine.
    for (let t = 0; t < 10; t += 1) for (let i = 0; i < 40; i += 1) { now += 25; expect(audio.admit(token, ARN)).toBe('ok'); }
  });

  it('refuses a chunk in the wrong format and an oversize one', () => {
    expect(audio.accept(token, headers(PID.ana, { sampleRate: '48000' }), sine(300, 200))).toBe('bad-format');
    expect(audio.accept(token, headers(PID.ana, { channels: '2' }), sine(300, 200))).toBe('bad-format');
    expect(audio.accept(token, headers(PID.ana, { encoding: 'opus' }), sine(300, 200))).toBe('bad-format');
    expect(audio.accept(token, headers(PID.ana), Buffer.alloc(64 * 1024 + 2))).toBe('bad-format');
    expect(audio.accept(token, headers(PID.ana), Buffer.alloc(0))).toBe('bad-format');
  });
});

describe('who a participant is', () => {
  beforeEach(() => setUp([ANA, BEN, CY]));

  it('audio from a participant id nobody bound is dropped, never mixed, and counted on the record', async () => {
    expect(audio.accept(token, headers(PID.dee), sine(300, 200))).toBe('unmapped');
    expect(audio.accept(token, headers('stranger-1'), sine(300, 200))).toBe('unmapped');
    expect(audio.accept(token, headers(''), sine(300, 200))).toBe('unmapped');
    await quiet(1000);
    expect(session().frames.every((f) => f.every((b) => b === 0))).toBe(true);
    await audio.flush(CALL);
    expect(sessionOf((await store.get(CALL))!).unmappedChunks).toBe(3);
  });

  it('an id is bound to one person: a second person cannot take it, the same person can repeat it, the count per person is capped', async () => {
    expect(await audio.bindParticipant(CALL, PID.dee, DEE)).toBe('bound');
    expect(await audio.bindParticipant(CALL, PID.dee, DEE)).toBe('bound');
    expect(await audio.bindParticipant(CALL, PID.dee, BEN)).toBe('taken');
    expect(audio.userOf(CALL, PID.dee)).toBe(DEE);
    for (let i = 0; i < 7; i += 1) expect(await audio.bindParticipant(CALL, `${DEE}-x${i}`, DEE)).toBe('bound');
    expect(await audio.bindParticipant(CALL, `${DEE}-x9`, DEE)).toBe('too-many');
  });

  it('the bindings survive on the record (a resumed call keeps them)', async () => {
    expect(sessionOf((await store.get(CALL))!).participants).toMatchObject({ [PID.ana]: ANA, [PID.ben]: BEN });
  });
});

describe('the acknowledgement gate (decision 8)', () => {
  it('audio from someone who has not acknowledged is dropped before the timeline and the mixer', async () => {
    await setUp([ANA]); // the inviter only: Ben and Cy have not acknowledged
    expect(await speak('ben', 300, 1000)).toEqual(Array(5).fill('unacked'));
    await quiet(1500);
    expect(session().frames.every((f) => f.every((b) => b === 0))).toBe(true);
    expect(session().spans()).toEqual([]);
    // ...and the timeline never saw him: a piece spoken over that time has no speaker.
    session().hear('I think the cookie is wrong', 200, 1100);
    await flush();
    expect((await store.lines(CALL, 0, 5)).map((l) => l.userId)).toEqual([null]);
    await audio.flush(CALL);
    expect(sessionOf((await store.get(CALL))!).unackedChunks).toBe(5);
  });

  it('the inviter is admitted without an ack; an acknowledgement opens the gate at once', async () => {
    await setUp([ANA]);
    expect(await speak('ana', 300, 400)).toEqual(['mixed', 'mixed']);
    await store.ack(CALL, BEN);
    await audio.refresh(CALL);
    expect(await speak('ben', 300, 400)).toEqual(['mixed', 'mixed']);
  });

  it('while paused every chunk is dropped even before the session is torn down, and after leaving the token is dead', async () => {
    await setUp([ANA, BEN, CY]);
    await store.transition(CALL, { from: ['listening'], to: 'paused', by: ANA, at: now });
    await audio.refresh(CALL);
    expect(await speak('ana', 300, 400)).toEqual(['not-listening', 'not-listening']);
    await runtime.pause(CALL);
    expect(audio.accept(token, headers(PID.ana), sine(300, 200))).toBe('unknown');
    expect(session().spans()).toEqual([]);
  });
});

describe('time base, timeline and attribution (decision 2)', () => {
  beforeEach(() => setUp([ANA, BEN, CY]));

  it('three speakers taking turns give three lines, each with the right person', async () => {
    await speak('ana', 220, 1600); await quiet(1000);
    await speak('ben', 360, 1400); await quiet(1000);
    await speak('cy', 510, 1800); await quiet(1500);
    const spans = session().spans();
    expect(spans).toHaveLength(3);
    ['one', 'two', 'three'].forEach((text, i) => session().hear(text, spans[i]!.startMs, spans[i]!.endMs));
    await flush();
    const lines = await store.lines(CALL, 0, 10);
    expect(lines.map((l) => [l.text, l.userId])).toEqual([['one', ANA], ['two', BEN], ['three', CY]]);
    expect(lines.every((l) => l.speakers === undefined)).toBe(true);
    expect(lines[0]).toMatchObject({ startMs: spans[0]!.startMs, endMs: spans[0]!.endMs });
  });

  it('overlapping speech stores both people in `speakers`, the one heard longest first', async () => {
    // Ana starts, Ben joins in half way: 200 ms steps, both sending.
    for (let t = 0; t < 2400; t += 200) {
      audio.accept(token, headers(PID.ana), sine(220, 200, t * 16));
      if (t >= 800) audio.accept(token, headers(PID.ben), sine(360, 200, t * 16));
      now += 200; await audio.tick();
    }
    await quiet(1500);
    const spans = session().spans();
    expect(spans).toHaveLength(1);
    session().hear('both at once', spans[0]!.startMs, spans[0]!.endMs);
    await flush();
    const [line] = await store.lines(CALL, 0, 5);
    expect(line!.userId).toBe(ANA);
    expect([...line!.speakers!].sort()).toEqual([ANA, BEN]);
  });

  it('a replaced session starts a new time base and the same tap keeps working: the next speaker is still attributed', async () => {
    await speak('ana', 220, 1000); await quiet(1500);
    const first = session();
    expect(first.spans()).toHaveLength(1);
    first.drop(); await flush();
    expect(sessions).toHaveLength(2);
    expect(audio.admit(token, ARN)).toBe('ok'); // the tap was not re-armed: the token still lives
    await speak('ben', 360, 1000); await quiet(1500);
    const second = session();
    expect(second).not.toBe(first);
    const spans = second.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startMs).toBeLessThan(2500); // measured from the new session's own start
    second.hear('after the reconnect', spans[0]!.startMs, spans[0]!.endMs);
    await flush();
    const lines = await store.lines(CALL, 0, 10);
    expect(lines[lines.length - 1]).toMatchObject({ text: 'after the reconnect', userId: BEN });
  });

  it('sends the provider silence between utterances, one 100 ms 24 kHz frame per 100 ms of wall time', async () => {
    await quiet(2000);
    expect(session().frames).toHaveLength(20);
    expect(session().frames.every((f) => f.length === (OUT_RATE * FRAME_MS) / 1000 * 2)).toBe(true);
  });
});

describe('the audio is never kept', () => {
  it('nothing about the audio lands on the record: only counters and the hash', async () => {
    await setUp([ANA, BEN, CY]);
    await send([{ who: 'ana', hz: 300 }]); await quiet(500); await audio.flush(CALL);
    const json = JSON.stringify(await store.get(CALL));
    expect(json.length).toBeLessThan(4000);
  });
});
