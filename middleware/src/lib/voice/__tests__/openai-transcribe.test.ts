// The provider transcription stream over a fake socket: the session it asks for, its own commits, deltas and finals in stream ms.
import { SegmentVad, TranscribeConfigError, _setTranscribeWebSocket, openOpenAiTranscriber } from '../openai-transcribe.js';

class FakeSocket {
  static last: FakeSocket | null = null;
  sent: Array<Record<string, unknown>> = []; url: string; headers: Record<string, string>;
  private ls: Record<string, Array<(e: unknown) => void>> = {};
  constructor(url: string, init: { headers: Record<string, string> }) { this.url = url; this.headers = init.headers; FakeSocket.last = this; setImmediate(() => this.fire('open', {})); }
  addEventListener(t: string, fn: (e: unknown) => void): void { (this.ls[t] ??= []).push(fn); }
  fire(t: string, e: unknown): void { for (const fn of this.ls[t] ?? []) fn(e); }
  msg(o: unknown): void { this.fire('message', { data: JSON.stringify(o) }); }
  send(d: string): void { this.sent.push(JSON.parse(d) as Record<string, unknown>); if ((this.sent.at(-1)!['type']) === 'session.update') setImmediate(() => this.msg({ type: 'session.updated' })); }
  close(): void { setImmediate(() => this.fire('close', { code: 1000 })); }
}

const voiced = (n: number): Buffer => { const b = Buffer.alloc(n * 48); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 3000 : -3000, i); return b; };
const quiet = (n: number): Buffer => Buffer.alloc(n * 48);
const saved = process.env['OPENAI_API_KEY'];

beforeEach(() => { process.env['OPENAI_API_KEY'] = 'test-key'; _setTranscribeWebSocket(FakeSocket as never); });
afterEach(() => { if (saved === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = saved; _setTranscribeWebSocket(null); });

describe('the provider transcription stream', () => {
  it('asks for delay minimal, the keywords and no turn detection', async () => {
    await openOpenAiTranscriber({ keywords: ['Milo', 'Mylo'] });
    const s = FakeSocket.last!;
    expect(s.url).toMatch(/\/realtime\?intent=transcription$/);
    expect(s.sent[0]).toMatchObject({ type: 'session.update', session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null,
      transcription: { model: 'gpt-live-transcribe', delay: 'minimal', keywords: ['Milo', 'Mylo'] } } } } });
  });

  it('commits at its own end of speech and reports deltas and finals in stream ms', async () => {
    const t = await openOpenAiTranscriber({ keywords: ['Milo'] });
    const s = FakeSocket.last!;
    const deltas: unknown[] = []; const finals: unknown[] = [];
    t.on('delta', (e) => deltas.push(e)); t.on('final', (e) => finals.push(e));
    t.append(quiet(500)); t.append(voiced(1000));
    s.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it1', delta: 'Milo,' });
    t.append(quiet(700));
    expect(s.sent.filter((m) => m['type'] === 'input_audio_buffer.commit')).toHaveLength(1);
    s.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it1', transcript: 'Milo, hi.' });
    expect(deltas).toEqual([{ itemId: 'it1', delta: 'Milo,', streamMs: 1500 }]);
    expect(finals).toEqual([{ itemId: 'it1', text: 'Milo, hi.', startStreamMs: 500, endStreamMs: 1500 }]);
    expect(s.sent.filter((m) => m['type'] === 'input_audio_buffer.append')).toHaveLength(3);
  });

  it('emits closed once, and refuses to open with no key', async () => {
    const t = await openOpenAiTranscriber({ keywords: ['Milo'] });
    const closed: unknown[] = [];
    t.on('closed', (e) => closed.push(e));
    FakeSocket.last!.fire('close', { code: 1006 });
    FakeSocket.last!.fire('close', { code: 1006 });
    expect(closed).toEqual([{ error: 'closed 1006' }]);
    delete process.env['OPENAI_API_KEY'];
    await expect(openOpenAiTranscriber({ keywords: ['Milo'] })).rejects.toBeInstanceOf(TranscribeConfigError);
  });

  it('the segment check cuts long speech and ignores a short pause', () => {
    const v = new SegmentVad(600, 15_000);
    expect(v.push(voiced(500))).toEqual([]);
    expect(v.push(quiet(400))).toEqual([]); // "Hey Milo, <pause>"
    expect(v.push(voiced(500))).toEqual([]);
    expect(v.push(quiet(600))).toEqual([[0, 1400]]);
    expect(v.push(voiced(16_000))).toEqual([[2000, 17_000]]);
  });
});
