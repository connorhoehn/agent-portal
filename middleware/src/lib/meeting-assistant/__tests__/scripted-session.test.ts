import { SCRIPT_FALLBACK, SCRIPT_RULES, ScriptedSession, scriptedSpeech, scriptFor } from '../scripted-session.js';
import type { SessionEvents } from '../session.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('the rule table', () => {
  it.each([
    ['what is two plus two', { say: 'Four.' }],
    ["What's 2 plus 2?", { say: 'Four.' }],
    ['please what is two plus two.', { say: 'Four.' }],
    ['create a work item for the login cookie bug', { call: { name: 'create', args: { kind: 'work-item', fields: { title: 'the login cookie bug' } } } }],
    ['Create a work item for the login cookie bug and assign it to Priya.', { call: { name: 'create', args: { kind: 'work-item', fields: { title: 'the login cookie bug', assignee: 'Priya' } } } }],
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

describe('ScriptedSession', () => {
  function make(now = { t: 1_000_000 }) {
    const s = new ScriptedSession(() => now.t);
    const seen: { [K in keyof SessionEvents]: SessionEvents[K][] } = { inputTranscript: [], outputTranscript: [], toolCall: [], delegation: [], usage: [], closed: [], error: [] };
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
    expect(seen.outputTranscript).toEqual([{ text: 'Here is the result.', final: true }]);
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
