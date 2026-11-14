import { SCRIPT_FALLBACK, SCRIPT_RULES, ScriptedSession, scriptedSpeech, scriptFor } from '../scripted-session.js';
import type { SessionEvents } from '../session.js';
import AjvImport from 'ajv';
import { meetingTools } from '../instructions.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvImport as any).default ?? AjvImport;

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('the rule table', () => {
  it.each([
    ['what is two plus two', { say: 'Four.' }],
    ["What's 2 plus 2?", { say: 'Four.' }],
    ['please what is two plus two.', { say: 'Four.' }],
    ['create a work item for the login cookie bug', { call: { name: 'create', args: { kind: 'work-item', fields: { title: 'the login cookie bug' } } } }],
    ['Create a work item for the login cookie bug and assign it to Priya.', { call: { name: 'create', args: { kind: 'work-item', fields: { title: 'the login cookie bug' } } } }],
    ['how much budget do I have', { call: { name: 'budget', args: { scope: 'me' } } }],
    ["what's my budget?", { call: { name: 'budget', args: { scope: 'me' } } }],
    ['find the Kubernetes experts', { call: { name: 'search', args: { query: 'the Kubernetes experts' } } }],
    ['search for runbooks about outages', { call: { name: 'search', args: { query: 'runbooks about outages' } } }],
    ['sing me a song', { say: SCRIPT_FALLBACK }],
  ])('%s', (text, step) => { expect(scriptFor(text)).toEqual(step); });

  it('has a small table with unique ids', () => {
    expect(SCRIPT_RULES.length).toBeLessThanOrEqual(6);
    expect(new Set(SCRIPT_RULES.map((r) => r.id)).size).toBe(SCRIPT_RULES.length);
  });

  it('speaks from a result by its shape and never repeats the data', () => {
    expect(scriptedSpeech('{"status":"waiting_for_confirmation","person":"Alice"}')).toContain('Alice');
    expect(scriptedSpeech('{"refused":"not addressed"}')).toMatch(/cannot/);
    expect(scriptedSpeech('{"error":"x"}')).toMatch(/could not/);
    expect(scriptedSpeech('{"rows":[{"title":"SECRET"}]}')).not.toContain('SECRET');
  });
});

describe('ScriptedSession voice', () => {
  it('emits 600 ms of tone then a 300 ms silent tail, in 100 ms frames, last marked, for each spoken reply', async () => {
    const s = new ScriptedSession(() => 1);
    const frames: Array<{ pcm: Buffer; seq: number; last?: true }> = [];
    s.on('outputAudio', (f) => frames.push(f));
    await s.start({ instructions: 'i', tools: [], backendInstructions: 'b' });
    s.sendText('u-1', 'what is two plus two'); await flush();
    expect(frames).toHaveLength(9);
    expect(frames.every((f) => f.pcm.length === 4800)).toBe(true);
    expect(frames.slice(0, 6).every((f) => f.pcm.some((b) => b !== 0))).toBe(true);
    expect(frames.slice(6).every((f) => f.pcm.every((b) => b === 0))).toBe(true);
    expect(frames.map((f) => f.last === true)).toEqual([false, false, false, false, false, false, false, false, true]);
    s.sendText('u-1', 'what is two plus two'); await flush();
    expect(frames[9]!.seq).toBe(10);
  });
});

describe('ScriptedSession', () => {
  function make(now = { t: 1_000_000 }) {
    const s = new ScriptedSession(() => now.t);
    const seen: { [K in keyof SessionEvents]: SessionEvents[K][] } = { inputTranscript: [], outputTranscript: [], toolCall: [], delegation: [], usage: [], outputAudio: [], expires: [], closed: [], error: [] };
    (Object.keys(seen) as Array<keyof SessionEvents>).forEach((k) => s.on(k, ((e: never) => { (seen[k] as unknown[]).push(e); }) as never));
    return { s, seen, now };
  }

  it('answers a plain question with output and a work item request with a tool call that names the asker the server gave', async () => {
    const { s, seen } = make();
    await s.start({ instructions: 'i', tools: [], backendInstructions: 'b' });
    expect(s.acceptsText).toBe(true);
    s.sendText('u-1', 'what is two plus two'); await flush();
    expect(seen.outputTranscript).toEqual([{ text: 'Four.', final: true }]);
    s.sendText('u-2', 'create a work item for the cookie bug'); await flush();
    expect(seen.toolCall).toEqual([{ callId: 'sc_1', name: 'create', args: { kind: 'work-item', fields: { title: 'the cookie bug' } }, atMs: 0, askedBy: 'u-2' }]);
  });

  it('answers a call once and speaks after it', async () => {
    const { s, seen } = make();
    await s.start({ instructions: 'i', tools: [], backendInstructions: 'b' });
    const id = s.emitToolCall('u-1', 'search', { query: 'x' });
    expect(s.answerToolCall(id, '{"rows":[]}')).toBe(true);
    expect(s.answerToolCall(id, '{"rows":[]}')).toBe(false);
    await flush();
    expect(seen.outputTranscript).toEqual([{ text: 'Here is the result.', final: true, inReplyTo: id }]); // the speech names the call it continues (audit B1)
  });

  it('reports usage as the elapsed seconds on close, once', async () => {
    const { s, seen, now } = make();
    await s.start({ instructions: 'i', tools: [], backendInstructions: 'b' });
    now.t += 125_900;
    await s.close(); await s.close();
    expect(seen.usage).toEqual([{ seconds: 125 }]);
    expect(seen.closed).toEqual([{ reason: 'close_requested' }]);
    expect(s.appendContext('late')).toBe(false);
  });
});

describe('scripted calls against the catalogue', () => {
  // The scripted session must raise calls the real executor accepts, so the mock walk exercises the real path.
  const phrases = [
    'create a work item for the login cookie bug', 'create a work item for the login cookie bug and assign it to Priya',
    'how much budget do I have', 'find the Kubernetes experts', 'search for runbooks about outages',
  ];
  it.each(phrases)('%s validates against the tenant tool schema', (text) => {
    const step = scriptFor(text);
    if (!('call' in step)) throw new Error('expected a call');
    const tool = meetingTools('orgiq').find((t) => t.name === step.call.name);
    expect(tool).toBeDefined();
    const validate = new Ajv({ strict: false }).compile(tool!.parameters);
    const ok = validate(step.call.args);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
  it('every rule that makes a call is covered by a phrase above', () => {
    const covered = new Set(phrases.map((p) => SCRIPT_RULES.find((r) => r.match.test(p.replace(/[.!?\s]+$/, '')))?.id));
    for (const r of SCRIPT_RULES) {
      const step = r.run(r.match.exec('x') ?? ([ 'x', 'x' ] as unknown as RegExpMatchArray));
      if ('call' in step) expect(covered.has(r.id)).toBe(true);
    }
  });
});
