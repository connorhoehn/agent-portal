// The voice relay (order, size, burst guard, drops) and the echo guard (docs/meeting-assistant-design.md decision 4 and the Echo risk).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true } } }));
import { callChatChannel } from '../../call-chat.js';
import { NovaSpeech, VoiceRelay, voiceChannel, VOICE_ECHO_TAIL_MS, type AssistantAudioFrame } from '../voice.js';

const frame = (n = 4800, fill = 7) => Buffer.alloc(n, fill);
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('the channel', () => {
  it('is the call chat channel', () => { expect(voiceChannel('call-9')).toBe(callChatChannel('call-9')); });
});

describe('VoiceRelay', () => {
  it('sends frames one at a time in order with a growing seq, base64 PCM, 24 kHz and last only on the marked one', async () => {
    const sent: AssistantAudioFrame[] = [];
    const relay = new VoiceRelay('c1', 'orgiq:huddle:c1', () => async (_ch, f) => { await tick(); sent.push(f); return true; });
    relay.push(frame(), false); relay.push(frame(), false); relay.push(frame(), true);
    while (relay.relayed < 3) await tick();
    expect(sent.map((f) => f.data.seq)).toEqual([1, 2, 3]);
    expect(sent.map((f) => f.data.last === true)).toEqual([false, false, true]);
    expect(sent[0]).toMatchObject({ type: 'assistant-audio', channel: 'orgiq:huddle:c1', data: { callId: 'c1', sampleRate: 24000 } });
    expect(Buffer.from(sent[0]!.data.pcm, 'base64')).toEqual(frame());
    expect(relay.dropped).toBe(0);
  });

  it('cuts a larger buffer into frames of at most 100 ms, marking only the final piece', async () => {
    const sent: AssistantAudioFrame[] = [];
    const relay = new VoiceRelay('c1', 'orgiq:huddle:c1', () => (_ch, f) => { sent.push(f); return true; });
    relay.push(frame(10_000), true);
    while (relay.relayed < 3) await tick();
    expect(sent.map((f) => Buffer.from(f.data.pcm, 'base64').length)).toEqual([4800, 4800, 400]);
    expect(sent.map((f) => f.data.last === true)).toEqual([false, false, true]);
  });

  it('drops frames beyond 3 seconds of queued audio, counts them, but never drops a frame marked last', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: AssistantAudioFrame[] = [];
    const relay = new VoiceRelay('c1', 'ch', () => async (_c, f) => { await gate; sent.push(f); return true; });
    for (let i = 0; i < 40; i += 1) relay.push(frame(), false);
    relay.push(frame(), true);
    await tick();
    expect(relay.queuedFrames()).toBeLessThanOrEqual(31); // 30 (3 s) plus the one marked last
    release();
    while (relay.queuedFrames() > 0) await tick();
    await tick();
    expect(relay.dropped).toBe(9); // 1 in flight, 30 queued, the rest dropped
    expect(sent.at(-1)!.data.last).toBe(true);
    expect(relay.relayed + relay.dropped).toBe(41);
  });

  it('counts a frame as dropped when no gateway runs (sink says false) or the sink throws, and clear drops what is queued', async () => {
    const none = new VoiceRelay('c1', 'ch', () => () => false);
    none.push(frame(), false); none.push(frame(), true);
    while (none.dropped < 2) await tick();
    expect(none.relayed).toBe(0);
    const boom = new VoiceRelay('c1', 'ch', () => () => { throw new Error('x'); });
    boom.push(frame(), true);
    while (boom.dropped < 1) await tick();
    let release: () => void = () => undefined; const gate = new Promise<void>((r) => { release = r; });
    const held = new VoiceRelay('c1', 'ch', () => async () => { await gate; return true; });
    held.push(frame(), false); held.push(frame(), false); held.push(frame(), false);
    await tick();
    held.clear();
    release();
    await tick(); await tick();
    expect(held.relayed).toBe(0);
    expect(held.dropped).toBe(3);
  });
});

describe('NovaSpeech (the echo guard)', () => {
  const nova = (frames: number[], said: string) => {
    const s = new NovaSpeech();
    s.noteText(frames[0]!, said, false);
    for (const t of frames) s.noteFrame(t);
    s.noteText(frames.at(-1)! + 200, said, true);
    return s;
  };
  // Frames at 1000..1500 mean Nova is speaking from 1000 to 1500 + 100 + 400 = 2000.
  const speech = () => nova([1000, 1100, 1200, 1300, 1400, 1500], 'Here is the result for the budget.');

  it('records the span: during the frames and for 400 ms after the last one, not before and not later', () => {
    const s = speech();
    expect(s.speakingAt(999)).toBe(false);
    expect(s.speakingAt(1000)).toBe(true);
    expect(s.speakingAt(1500 + 100 + VOICE_ECHO_TAIL_MS)).toBe(true);
    expect(s.speakingAt(2001)).toBe(false);
  });

  it('treats a caption entirely inside the span whose words are Nova\'s own as an echo (containment, or at least 80% of three or more words)', () => {
    const s = speech();
    expect(s.isEcho({ text: 'here is the result', startAt: 1100, endAt: 1900 })).toBe(true);
    expect(s.isEcho({ text: 'Here is, the RESULT for the budget!', startAt: 1100, endAt: 1950 })).toBe(true);
    expect(s.isEcho({ text: 'the result is for budget', startAt: 1100, endAt: 1900 })).toBe(true); // 5 of 5 words are hers, out of order
  });

  it('keeps a person: different words, only partly overlapping words, a span that leaves Nova\'s, or no known span', () => {
    const s = speech();
    expect(s.isEcho({ text: 'Nova what is the weather', startAt: 1100, endAt: 1900 })).toBe(false);
    expect(s.isEcho({ text: 'the result looks wrong to me', startAt: 1100, endAt: 1900 })).toBe(false); // talks over her, 2 of 6 words hers
    expect(s.isEcho({ text: 'here is the result', startAt: 1100, endAt: 2600 })).toBe(false); // ends after her span
    expect(s.isEcho({ text: 'here is the result', startAt: 900, endAt: 1900 })).toBe(false); // starts before it
    expect(s.isEcho({ text: 'here is the result', startAt: 5000, endAt: 5500 })).toBe(false);
    expect(s.isEcho({ text: 'result', startAt: 1100, endAt: 1900 })).toBe(false); // one word is never judged
    expect(s.isEcho(null)).toBe(false);
    expect(new NovaSpeech().isEcho({ text: 'here is the result', startAt: 1100, endAt: 1900 })).toBe(false);
  });

  it('a later utterance is its own span with its own words', () => {
    const s = speech();
    for (const t of [9000, 9100]) s.noteFrame(t);
    s.noteText(9200, 'Four.', true);
    expect(s.isEcho({ text: 'here is the result', startAt: 9050, endAt: 9400 })).toBe(false);
    expect(s.isEcho({ text: 'here is the result', startAt: 1100, endAt: 1900 })).toBe(true);
  });
});
