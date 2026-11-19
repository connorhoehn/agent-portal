// The live session's half of approved speech (session.ts `sayVerbatim`), on HAND-BUILT provider frames from a local socket: no
// network, no key (the key below is a placeholder the local server never checks). The words go out as spoken commentary; the next
// utterance that begins from quiet is claimed for the request: its frames and its final transcript carry `say`, and `ended` is called
// once both its transcript has been flushed and its audio has ended.
import { WebSocketServer, WebSocket } from 'ws';
const mockTrace: Array<{ ev: string; f: Record<string, unknown> }> = [];
jest.mock('../trace.js', () => ({ trace: (ev: string, f: Record<string, unknown> = {}) => { mockTrace.push({ ev, f }); } }));
import type { AddressInfo } from 'node:net';
import { _setVoiceWebSocket } from '../../voice/openai.js';
import { OpenAiLiveSession } from '../live-session.js';
import { readAloudContent, READ_ALOUD_MARK, saidVerbatim } from '../approved-speech.js';
import type { SessionEvents } from '../session.js';
import type { ResponsesFunctionTool } from '../../voice/catalogue.js';

const KEY = 'sk-test-THE_SERVER_SIDE_KEY_never_in_a_body';
const TOOL: ResponsesFunctionTool = {
  type: 'function', name: 'search', description: 'Search',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
};
const START = { instructions: 'You are Milo.', tools: [TOOL], backendInstructions: 'Run functions.' };

let server: WebSocketServer;
let received: Array<Record<string, unknown>>;
let serverSocket: WebSocket | null;
let headers: Record<string, string | string[] | undefined>;
let url: string | undefined;
let onClientEvent: (ev: Record<string, unknown>, s: WebSocket) => void;
const saved = { key: process.env['OPENAI_API_KEY'], base: process.env['OPENAI_BASE_URL'] };

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const frame = (ev: Record<string, unknown>) => serverSocket!.send(JSON.stringify(ev));

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => server.on('listening', () => r()));
  server.on('connection', (s, req) => {
    serverSocket = s; headers = req.headers; url = req.url;
    s.on('message', (d) => { const ev = JSON.parse(String(d)) as Record<string, unknown>; received.push(ev); onClientEvent(ev, s); });
  });
  process.env['OPENAI_API_KEY'] = KEY;
  process.env['OPENAI_BASE_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  _setVoiceWebSocket(WebSocket as never);
});
afterAll(async () => {
  _setVoiceWebSocket(null);
  for (const c of server.clients) c.terminate();
  await new Promise<void>((r) => server.close(() => r()));
  if (saved.key === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = saved.key;
  if (saved.base === undefined) delete process.env['OPENAI_BASE_URL']; else process.env['OPENAI_BASE_URL'] = saved.base;
});
beforeEach(() => {
  received = []; serverSocket = null;
  onClientEvent = (ev, s) => { if (ev['type'] === 'session.start') s.send(JSON.stringify({ type: 'session.started', client_event_id: ev['event_id'], session: { id: 'live_u0_abc', status: 'active' } })); };
});

function make(over: Partial<ConstructorParameters<typeof OpenAiLiveSession>[0]> = {}) {
  const s = new OpenAiLiveSession({ model: 'gpt-live-1', voice: 'marin', delegationModel: 'gpt-6-luna', idleFlushMs: 40, closeTimeoutMs: 120, ...over });
  const seen: { [K in keyof SessionEvents]: SessionEvents[K][] } = { inputTranscript: [], outputTranscript: [], toolCall: [], delegation: [], delegationReady: [], messageReady: [], usage: [], outputAudio: [], expires: [], closed: [], error: [] };
  (Object.keys(seen) as Array<keyof SessionEvents>).forEach((k) => s.on(k, ((e: never) => { (seen[k] as unknown[]).push(e); }) as never));
  return { s, seen };
}

const pcmB64 = (amp: number, bytes = 4800) => {
  const b = Buffer.alloc(bytes);
  if (amp) for (let i = 0; i < Math.floor(bytes / 2); i += 1) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b.toString('base64');
};
const audio = (amp: number) => frame({ type: 'session.output_audio.delta', delta: pcmB64(amp), event_id: 'e' });
const words = (delta: string, at: number) => frame({ type: 'session.output_transcript.delta', start_ms: at, end_ms: at + 200, delta });
const Q = 'How would you shard this table?';

describe('sayVerbatim on the live session', () => {
  it('sends the words as spoken commentary with no delegation id, and is refused before the session opens', async () => {
    const { s } = make();
    expect(s.sayVerbatim('say_0', Q, () => undefined)).toBe(false);
    await s.start(START);
    expect(s.sayVerbatim('say_1', Q, () => undefined)).toBe(true);
    await tick(20);
    expect(received.find((e) => e['type'] === 'session.commentary.append')).toEqual(expect.objectContaining({ delegation_id: null, content: readAloudContent(Q) }));
    expect(s.sayVerbatim('say_2', '   ', () => undefined)).toBe(false);
    await s.close();
  });

  it('claims the next utterance from quiet: its frames and final transcript carry `say`, and `ended` gets the transcript once', async () => {
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(20);
    audio(3000); words('How would you', 0); audio(3000); words(' shard this table?', 200);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(seen.outputAudio.length).toBe(5);
    expect(seen.outputAudio.every((f) => f.say === 'say_1')).toBe(true);
    const final = seen.outputTranscript.filter((e) => e.final);
    expect(final).toEqual([expect.objectContaining({ text: Q, say: 'say_1' })]);
    expect(ended).toEqual([Q]);
    // The next utterance is nobody's request: nothing is tagged.
    audio(3000); words('Something else.', 900);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(seen.outputAudio.slice(5).every((f) => f.say === undefined)).toBe(true);
    expect(seen.outputTranscript.filter((e) => e.final).at(-1)).toEqual(expect.not.objectContaining({ say: expect.anything() }));
    expect(ended).toEqual([Q]);
    await s.close();
  });

  it('an utterance already running when the request is sent is not claimed; the next one from quiet is', async () => {
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    audio(3000); words('I was saying', 0);
    await tick(20);
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(20);
    audio(3000);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(seen.outputAudio.every((f) => f.say === undefined)).toBe(true);
    audio(3000); words(Q, 1000);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(seen.outputAudio.filter((f) => f.say === 'say_1').length).toBe(4);
    expect(ended).toEqual([Q]);
    await s.close();
  });

  it('the spoken repeat (18 November film): a line asked for during the model\'s own reply is held unsent until quiet, then sent and claimed', async () => {
    // The provider, as measured: a commentary that lands while its own response runs is never spoken. This fake does the same.
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    let speaking = false;
    const heard: string[] = [];
    onClientEvent = (ev) => { if (ev['type'] === 'session.commentary.append') heard.push(speaking ? 'ignored' : 'read'); };
    const ended: Array<string | null> = [];
    const sentAt: number[] = [];
    // The candidate asked "Milo, can you repeat the question?" and the live model starts its own answer (policy drops it).
    speaking = true;
    audio(3000); words('Sure, the question was', 0);
    await tick(20);
    s.sayVerbatim('say_1', Q, (t) => ended.push(t), () => sentAt.push(Date.now()));
    await tick(20);
    audio(3000); words(' how you would shard it.', 200);
    await tick(20);
    expect(received.filter((e) => e['type'] === 'session.commentary.append')).toEqual([]);
    expect(sentAt).toEqual([]);
    for (let i = 0; i < 4; i += 1) audio(0);
    speaking = false; // the provider's reply is over; the client learns it once its words flush and its voice tail ends
    await tick(100);
    expect(received.filter((e) => e['type'] === 'session.commentary.append')).toEqual([expect.objectContaining({ content: readAloudContent(Q) })]);
    expect(sentAt.length).toBe(1);
    expect(heard).toEqual(['read']);
    // The model's own reply was not claimed; the line it now reads is.
    expect(seen.outputAudio.filter((f) => f.say).length).toBe(0);
    audio(3000); words(Q, 2000);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(seen.outputAudio.filter((f) => f.say === 'say_1').length).toBe(4);
    expect(ended).toEqual([Q]);
    await s.close();
  });

  it('a line waits while a person is speaking, and goes out once their turn is over and no reply began', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 20 });
    await s.start(START);
    frame({ type: 'session.input_transcript.delta', start_ms: 0, end_ms: 200, delta: 'So I was thinking that' });
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(20);
    expect(received.filter((e) => e['type'] === 'session.commentary.append')).toEqual([]);
    await tick(60); // the person's turn ends (idle flush)
    expect(received.filter((e) => e['type'] === 'session.commentary.append').length).toBe(1);
    await s.close();
  });

  it('a line asked as a person\'s turn is flushed waits out the voice\'s reply to it (no provider event announces one)', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 60 });
    await s.start(START);
    const commentaries = () => received.filter((e) => e['type'] === 'session.commentary.append').length;
    frame({ type: 'session.input_transcript.delta', start_ms: 0, end_ms: 200, delta: 'Milo, can you repeat the question?' });
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(20);
    // The turn is flushed (a sentence end); the voice begins its own reply 30 ms later. Nothing was sent into that window.
    expect(commentaries()).toBe(0);
    audio(3000); words('Sure.', 400);
    await tick(10);
    expect(commentaries()).toBe(0);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(80);
    expect(commentaries()).toBe(1);
    await s.close();
  });

  it('a turn flushed after its quiet (no sentence end) does not wait again: the reply wait counts from the turn\'s last words', async () => {
    // Recorded (18 November takes): the voice's own reply, or its delegation, came 0 to 1.2 s after a turn's last input delta,
    // inside the 1.5 s of quiet that flushes the turn; waiting a full reply wait after the flush only delayed the intro by 1 s.
    const { s } = make({ idleFlushMs: 100, utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 80 });
    await s.start(START);
    const commentaries = () => received.filter((e) => e['type'] === 'session.commentary.append').length;
    frame({ type: 'session.input_transcript.delta', start_ms: 0, end_ms: 200, delta: 'Milo, introduce yourself' });
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(60);
    expect(commentaries()).toBe(0); // the turn is still open
    await tick(70); // flushed at 100 ms, longer than the reply wait after its last words: sent then
    expect(commentaries()).toBe(1);
    await s.close();
  });

  it('a turn ended by the next words after a pause (a gap flush) does not send the line: the person is speaking again', async () => {
    // The provider's stamps put a pause of 1 to 1.5 s between two pieces of one person's speech: the first is flushed as a turn of
    // its own when the second arrives, and the reply wait measured from the first piece's arrival is long over by then.
    const { s } = make({ idleFlushMs: 200, gapMs: 1000, utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 20 });
    await s.start(START);
    const commentaries = () => received.filter((e) => e['type'] === 'session.commentary.append').length;
    frame({ type: 'session.input_transcript.delta', start_ms: 0, end_ms: 400, delta: 'So the first thing I would do' });
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(60);
    expect(commentaries()).toBe(0); // the turn is open
    frame({ type: 'session.input_transcript.delta', start_ms: 1_700, end_ms: 2_000, delta: ' is sort the input' });
    await tick(20);
    expect(commentaries()).toBe(0); // the person resumed: nothing is sent into their words
    await tick(260); // their turn ends (idle flush) with no reply
    expect(commentaries()).toBe(1);
    await s.close();
  });

  it('a turn with no reply: the line goes once the reply wait has passed', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 60 });
    await s.start(START);
    const commentaries = () => received.filter((e) => e['type'] === 'session.commentary.append').length;
    frame({ type: 'session.input_transcript.delta', start_ms: 0, end_ms: 200, delta: 'That is my answer.' });
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(20);
    expect(commentaries()).toBe(0);
    await tick(70);
    expect(commentaries()).toBe(1);
    await s.close();
  });

  it('a server line pre-empts delegated work: it goes at once while a delegation\'s response runs, its call awaits output and a continuation is awaited', async () => {
    // Live film, 19 November: the ready line queued 2.9 to 21.6 s behind the model's delegated response (busy), then the caller's
    // quiet wait withheld it. The server's words go first now; the next line still waits for the first one's utterance (order).
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 100 });
    await s.start(START);
    mockTrace.length = 0;
    const sent = () => received.filter((e) => e['type'] === 'session.commentary.append').map((e) => e['content']);
    const env = (event: Record<string, unknown>) => frame({ type: 'response.event', delegation_id: 'item_1', event });
    frame({ type: 'session.delegation.created', offset_ms: 100, delegation: { id: 'item_1', type: 'delegation', target: 'responses', response_id: 'resp_1' } });
    env({ type: 'response.created', response: { id: 'resp_1' } });
    env({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"query":"x"}' } });
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(10);
    expect(sent()).toEqual([readAloudContent(Q)]); // not behind the running response nor the open call
    expect(mockTrace.find((t) => t.ev === 'say.sent')?.f['preempted']).toBe(true);
    s.answerToolCall('call_1', '{"ok":true}'); // continuation asked for: its wait does not hold a line either
    s.sayVerbatim('say_2', 'Second.', () => undefined);
    await tick(20);
    expect(sent()).toEqual([readAloudContent(Q)]); // the first line is sent and not yet said: the second waits (order kept)
    audio(3000); words(Q, 2000);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(sent()).toEqual([readAloudContent(Q), readAloudContent('Second.')]);
    await s.close();
  });

  it('a server line still waits for voice already running (the provider cannot be cut)', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 60 });
    await s.start(START);
    const commentaries = () => received.filter((e) => e['type'] === 'session.commentary.append').length;
    frame({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    audio(3000); words('The delegated answer', 0);
    await tick(10);
    s.sayVerbatim('say_1', Q, () => undefined);
    await tick(20);
    expect(commentaries()).toBe(0);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(80);
    expect(commentaries()).toBe(1); // the voice is over; the response still running does not hold it
    await s.close();
  });

  it('the real interview take: a delegation the provider never answers (no response.event follows) does not hold a line for ever', async () => {
    // As recorded in the 18 November film (trace of the take): the candidate asks Milo to repeat the question, the voice
    // delegates, and then only input transcript deltas and usage arrive; no response.event, no output.
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 60 });
    await s.start(START);
    const commentaries = () => received.filter((e) => e['type'] === 'session.commentary.append').length;
    frame({ type: 'session.input_transcript.delta', start_ms: 108800, end_ms: 111200, delta: 'Milo, can you repeat the question' });
    await tick(5);
    frame({ type: 'session.delegation.created', offset_ms: 112000, delegation: { id: 'item_1', type: 'delegation', target: 'responses', response_id: 'resp_1' } });
    await tick(5);
    s.sayVerbatim('say_1', Q, () => undefined);
    frame({ type: 'session.usage.updated', usage: { seconds: 112 } });
    await tick(20);
    expect(commentaries()).toBe(1); // a delegation's wait is pre-empted: the line goes at once
    await s.close();
  });

  it('a top-level error ends the open response (it used to run to its 30 s expiry) and its trace keeps code, param, type and client event id only', async () => {
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 20, responseStuckMs: 30_000 });
    await s.start(START);
    frame({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.created', response: { id: 'resp_1' } } });
    await tick(10);
    mockTrace.length = 0;
    s.sayVerbatim('probe_1', Q, () => undefined);
    expect(mockTrace.find((t) => t.ev === 'say.asked')?.f['busy']).toBe(true); // the response runs
    s.cancelSay('probe_1');
    frame({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', param: 'item.call_id', message: 'Said: how would you shard it', event_id: 'ma_7' } });
    await tick(15);
    const traced = mockTrace.find((t) => t.ev === 'provider' && t.f['type'] === 'error')!.f;
    expect(traced).toEqual(expect.objectContaining({ code: 'invalid_value', param: 'item.call_id', errType: 'invalid_request_error', clientEventId: 'ma_7' }));
    expect(JSON.stringify(traced)).not.toMatch(/shard|Said/);
    expect(seen.error[0]).toEqual({ message: 'invalid_value', info: { code: 'invalid_value', param: 'item.call_id', type: 'invalid_request_error' } });
    for (let i = 0; i < 4; i += 1) audio(0); // let the probe line's claim lapse
    mockTrace.length = 0;
    s.sayVerbatim('say_2', Q, () => undefined);
    expect(mockTrace.find((t) => t.ev === 'say.asked')?.f['busy']).toBe(false); // the response is over
    await s.close();
  });

  it('an error naming the event a line was sent with ends that line at once with no words (the commentary was refused)', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150, answerWaitMs: 20 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(10);
    const sentId = received.find((e) => e['type'] === 'session.commentary.append')!['event_id'];
    frame({ type: 'error', client_event_id: 'ma_999', error: { code: 'invalid_value' } }); // another event's: not this line
    await tick(10);
    expect(ended).toEqual([]);
    frame({ type: 'error', client_event_id: sentId, error: { code: 'invalid_value' } });
    await tick(10);
    expect(ended).toEqual([null]);
    s.sayVerbatim('say_2', 'Next.', () => undefined); // the queue is free again
    await tick(10);
    expect(received.filter((e) => e['type'] === 'session.commentary.append').length).toBe(2);
    await s.close();
  });

  it('one line at a time: the second goes out only after the first one\'s utterance is over', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    s.sayVerbatim('say_2', 'About 58 minutes are left.', (t) => ended.push(t));
    await tick(20);
    expect(received.filter((e) => e['type'] === 'session.commentary.append').map((e) => e['content'])).toEqual([readAloudContent(Q)]);
    audio(3000); words(Q, 0);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(ended).toEqual([Q]);
    expect(received.filter((e) => e['type'] === 'session.commentary.append').map((e) => e['content'])).toEqual([readAloudContent(Q), readAloudContent('About 58 minutes are left.')]);
    await s.close();
  });

  it('a line the provider takes in part way through an utterance already running was absorbed: it ends at once with no words', async () => {
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(20);
    const sent = received.find((e) => e['type'] === 'session.commentary.append')!;
    // The model begins something of its own at once; the line is taken in two seconds into it.
    audio(3000); words('Sure, the question was about', 1000);
    await tick(10);
    frame({ type: 'session.commentary.appended', client_event_id: sent['event_id'], start_ms: 3000, end_ms: 3000 });
    await tick(10);
    expect(ended).toEqual([null]);
    audio(3000); words(' sharding a table.', 3200);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    // Frames after the absorption are nobody's; nothing ends twice.
    expect(seen.outputAudio.slice(-4).every((f) => f.say === undefined)).toBe(true);
    expect(ended).toEqual([null]);
    await s.close();
  });

  it('an acknowledgement naming an event id no line was sent with is nobody\'s: it never ends the line waiting to be said', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(20);
    audio(3000); words('Sure, the question was about', 1000);
    await tick(10);
    // Some other commentary's acknowledgement (not this line's id), taken in two seconds into the running utterance.
    frame({ type: 'session.commentary.appended', client_event_id: 'ma_999', start_ms: 3000, end_ms: 3000 });
    await tick(10);
    expect(ended).toEqual([]);
    await s.close();
  });

  it('a line taken in as its utterance begins is spoken as usual (the acknowledgement does not end it)', async () => {
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(20);
    const sent = received.find((e) => e['type'] === 'session.commentary.append')!;
    audio(3000); words('How would you', 5000);
    frame({ type: 'session.commentary.appended', client_event_id: sent['event_id'], start_ms: 5000, end_ms: 5000 });
    audio(3000); words(' shard this table?', 5200);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(ended).toEqual([Q]);
    expect(seen.outputAudio.filter((f) => f.say === 'say_1').length).toBe(5);
    await s.close();
  });

  it('cancelSay forgets a request the caller withheld: the next utterance is nobody\'s (it used to claim it)', async () => {
    const { s, seen } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await tick(20);
    s.cancelSay('say_1');
    audio(3000); words('About 58 minutes are left.', 0);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(120);
    expect(seen.outputAudio.every((f) => f.say === undefined)).toBe(true);
    expect(ended).toEqual([]);
    await s.close();
  });

  it('a close forgets the request (the caller\'s bound withholds it)', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 150 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await s.close();
    expect(ended).toEqual([]);
    expect(s.sayVerbatim('say_2', Q, () => undefined)).toBe(false);
  });

  // The real provider (17 November): words stream as the audio plays and stall part way through a sentence for longer than the 900 ms
  // that ends an ordinary utterance. Cutting there handed the check half a line, and every approved line was withheld.
  const TIME = 'About 59 minutes are left in this round.';
  const QUESTION = 'Can you walk me through how you would design a rate limiter for an API that serves many customers?';
  const stalled = async (text: string, cutAt: number, stallMs: number) => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 400 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', text, (t) => ended.push(t));
    await tick(20);
    const w = text.split(' ');
    audio(3000); words(w.slice(0, cutAt).join(' '), 0);
    for (let i = 0; i < 4; i += 1) audio(0); // the voice stops too: its tail ends
    await tick(stallMs);
    const duringStall = [...ended];
    audio(3000); words(` ${w.slice(cutAt).join(' ')}`, 2000);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(150);
    await s.close();
    return { duringStall, ended };
  };

  it('a stall longer than the ordinary gap does not end a claimed utterance: the time-left line reaches the check whole', async () => {
    const { duringStall, ended } = await stalled(TIME.replace('59', 'fifty-nine'), 3, 200);
    expect(duringStall).toEqual([]);
    expect(ended).toEqual(['About fifty-nine minutes are left in this round.']);
    expect(saidVerbatim(TIME, ended[0])).toBe(true);
  });

  it('the long approved question, stalled mid-sentence, reaches the check whole', async () => {
    const { ended } = await stalled(QUESTION, 9, 250);
    expect(ended).toEqual([QUESTION]);
    expect(saidVerbatim(QUESTION, ended[0])).toBe(true);
  });

  it('words that never complete end at the long gap with what was said, and that partial line fails the check', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 200 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', TIME, (t) => ended.push(t));
    await tick(20);
    audio(3000); words('About fifty-nine minutes are', 0);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(100);
    expect(ended).toEqual([]); // past the ordinary gap, inside the long one: still open
    await tick(250);
    expect(ended).toEqual(['About fifty-nine minutes are']);
    expect(saidVerbatim(TIME, ended[0])).toBe(false);
    await s.close();
  });

  it('a paraphrase, or words that run on past the line, still reach the check as said and fail it', async () => {
    const { s } = make({ utteranceGapMs: 40, saySettleMs: 40, sayGapMs: 200 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', TIME, (t) => ended.push(t));
    await tick(20);
    audio(3000); words('About fifty-nine minutes are left in this round.', 0);
    audio(3000); words(' Good luck.', 400); // still voicing: the run-on joins the line
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(350);
    expect(ended).toEqual(['About fifty-nine minutes are left in this round. Good luck.']);
    expect(saidVerbatim(TIME, ended[0])).toBe(false);
    s.sayVerbatim('say_2', TIME, (t) => ended.push(t));
    await tick(20);
    audio(3000); words('There are still about fifty-nine minutes left.', 1000);
    for (let i = 0; i < 4; i += 1) audio(0);
    await tick(350);
    expect(ended).toHaveLength(2);
    expect(saidVerbatim(TIME, ended[1])).toBe(false);
    await s.close();
  });

  it('the line is sent quoted after the read-aloud mark, which the session instructions explain', () => {
    expect(readAloudContent(' Say "hi" now. ')).toBe(`${READ_ALOUD_MARK} "Say \\"hi\\" now."`);
  });
});
