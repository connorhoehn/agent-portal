// The live session's half of approved speech (session.ts `sayVerbatim`), on HAND-BUILT provider frames from a local socket: no
// network, no key (the key below is a placeholder the local server never checks). The words go out as spoken commentary; the next
// utterance that begins from quiet is claimed for the request: its frames and its final transcript carry `say`, and `ended` is called
// once both its transcript has been flushed and its audio has ended.
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { _setVoiceWebSocket } from '../../voice/openai.js';
import { OpenAiLiveSession } from '../live-session.js';
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
    expect(received.find((e) => e['type'] === 'session.commentary.append')).toEqual(expect.objectContaining({ delegation_id: null, content: Q }));
    expect(s.sayVerbatim('say_2', '   ', () => undefined)).toBe(false);
    await s.close();
  });

  it('claims the next utterance from quiet: its frames and final transcript carry `say`, and `ended` gets the transcript once', async () => {
    const { s, seen } = make({ utteranceGapMs: 40 });
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
    const { s, seen } = make({ utteranceGapMs: 40 });
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

  it('a close forgets the request (the caller\'s bound withholds it)', async () => {
    const { s } = make({ utteranceGapMs: 40 });
    await s.start(START);
    const ended: Array<string | null> = [];
    s.sayVerbatim('say_1', Q, (t) => ended.push(t));
    await s.close();
    expect(ended).toEqual([]);
    expect(s.sayVerbatim('say_2', Q, () => undefined)).toBe(false);
  });
});
