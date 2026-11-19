// Hands-free Milo, lane C (handsfree/rules.ts): who may trigger Milo, mention vs request on the clean sentence, the follow-up
// window's asides, echo vs barge-in, and the Work/Social instructions. The interview family's part is in
// interviews/__tests__/milo-policy.handsfree.test.ts.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));

import { HANDSFREE_TURN_RULES, meetingInstructions } from '../instructions.js';
import { DEFAULT_POLICY, type HandsfreeFamily, type MeetingAssistantPolicy, type PolicyCall } from '../policy.js';
import { addressedRequest, createHandsfreeRules, followUpKind, handsfreeFamilyRules, overlapOf, talksAboutMilo } from '../handsfree/rules.js';
import { HANDSFREE } from '../handsfree/types.js';
import type { AssistantRecord } from '../types.js';

const CALL: PolicyCall = { callId: 'call-1', lobby: 'orgiq:initiative:p-auth', tenant: 'orgiq' };
const SOCIAL: PolicyCall = { callId: 'call-s', lobby: 'social:ch:general', tenant: 'social' };
const UNA = 'u-una'; const VERA = 'u-vera'; const LATE = 'u-late';

const record = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: CALL.callId, tenant: 'orgiq', lobby: CALL.lobby, state: 'listening', acked: [UNA, VERA], attendees: [UNA, VERA], ...over,
} as unknown as AssistantRecord);

const rulesWith = (rec: AssistantRecord | null, extra: Parameters<typeof createHandsfreeRules>[0] = {}) =>
  createHandsfreeRules({ record: async (id) => (rec && rec.callId === id ? rec : null), ...extra });

describe('admit: who may cause Milo to listen to them', () => {
  it('routes a person who acknowledged, while Milo is listening (Work and Social, no family rule)', async () => {
    const rules = rulesWith(record());
    expect(await rules.admit(CALL, UNA)).toBe('route');
    expect(await rules.admit(CALL, VERA)).toBe('route');
    const social = createHandsfreeRules({ record: async () => record({ callId: SOCIAL.callId, lobby: SOCIAL.lobby!, tenant: 'social' }) });
    expect(await social.admit(SOCIAL, UNA)).toBe('route');
  });

  it('denies someone who has not acknowledged, an empty id, a paused or left Milo, no record, and another call\'s record', async () => {
    expect(await rulesWith(record()).admit(CALL, LATE)).toBe('deny');
    expect(await rulesWith(record()).admit(CALL, '')).toBe('deny');
    for (const state of ['paused', 'left', 'invited'] as const) expect([state, await rulesWith(record({ state })).admit(CALL, UNA)]).toEqual([state, 'deny']);
    expect(await rulesWith(null).admit(CALL, UNA)).toBe('deny');
    const other = createHandsfreeRules({ record: async () => record({ callId: 'call-other' }) });
    expect(await other.admit(CALL, UNA)).toBe('deny');
  });

  it('a store that throws or does not answer within admitWaitMs is deny', async () => {
    expect(await createHandsfreeRules({ record: async () => { throw new Error('down'); } }).admit(CALL, UNA)).toBe('deny');
    expect(HANDSFREE.admitWaitMs).toBe(150);
    const t0 = Date.now();
    expect(await createHandsfreeRules({ record: () => new Promise(() => undefined), admitWaitMs: 30 }).admit(CALL, UNA)).toBe('deny');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a family answer is taken only when it is one of the three, and only after the rules\' own checks', async () => {
    const family = (admit: HandsfreeFamily['admit']): MeetingAssistantPolicy => ({ ...DEFAULT_POLICY, handsfree: () => ({ admit, instructions: () => null }) });
    const asked: string[] = [];
    const fixed = rulesWith(record(), { policy: () => family(async (u) => { asked.push(u); return 'fixed-lines'; }) });
    expect(await fixed.admit(CALL, UNA)).toBe('fixed-lines');
    expect(await fixed.admit(CALL, LATE)).toBe('deny'); // not acknowledged: the family is never asked
    expect(asked).toEqual([UNA]);
    expect(await rulesWith(record(), { policy: () => family(async () => 'yes' as never) }).admit(CALL, UNA)).toBe('deny');
    expect(await rulesWith(record(), { policy: () => family(async () => { throw new Error('x'); }) }).admit(CALL, UNA)).toBe('deny');
  });

  it('a person acknowledged elsewhere (not the in-call notice) is asked of the policy, and nobody is by default', async () => {
    const elsewhere = (who: string[]): MeetingAssistantPolicy => ({ ...DEFAULT_POLICY, acknowledgement: () => 'elsewhere', acknowledgedElsewhere: async (_c, ids) => ids.filter((u) => who.includes(u)) });
    expect(await rulesWith(record({ acked: [] }), { policy: () => elsewhere([LATE]) }).admit(CALL, LATE)).toBe('route');
    expect(await rulesWith(record(), { policy: () => elsewhere([]) }).admit(CALL, UNA)).toBe('deny'); // acked in-call does not count there
    expect(await rulesWith(record(), { policy: () => ({ ...DEFAULT_POLICY, acknowledgement: () => 'elsewhere' }) }).admit(CALL, UNA)).toBe('deny');
  });
});

describe('verdict on the clean sentence: mention vs request', () => {
  const MENTIONS = [
    "I saw Milo's summary yesterday.",
    "Milo's notes are in the doc.",
    'Milo said twelve.',
    'Milo is wrong about that.',
    'Milo got the numbers from the sprint.',
    'Milo answered that already.',
    'I think Milo got that wrong.',
    'Just ask Milo about that later.',
    'Thanks Milo.',
    'Can Milo do that?',
    'Milo should know this.',
    // the live gate's mentions (2026-11-19): a tag question is a statement about him, a name after "called" is a mention
    "Milo was fast at this yesterday, wasn't he?",
    'Milo is quick today, isn’t he?',
    "Milo did well there, didn't he?",
    "My cousin's dog is called Milo, which is funny.",
    'We named the bot Milo, after my dog.',
  ];
  const REQUESTS: Array<[string, string]> = [
    ["Milo, what's the capital of France?", "what's the capital of France?"],
    ["What's the capital of France, Milo?", ''],
    ['Hey Milo, what time is it?', 'what time is it?'],
    ['Mylo, repeat the question.', 'repeat the question.'],
    ['Okay Milo, add twelve test cases.', 'add twelve test cases.'],
    ['Milo can you summarise the call?', 'can you summarise the call?'],
    ["Milo what's next on the list?", "what's next on the list?"],
    ['Milo add an item for Vera.', 'add an item for Vera.'],
    ['Milo is a tomato a fruit?', 'is a tomato a fruit?'],
    ['Milo does the bus stop here?', 'does the bus stop here?'],
    ['Milo, was the call long, or was it short?', 'was the call long, or was it short?'],
    ["Milo, the call ran long, didn't it?", "the call ran long, didn't it?"],
  ];

  it.each(MENTIONS)('%j is a mention: talksAboutMilo or no address, and the verdict drops it', async (text) => {
    expect(addressedRequest(text)).toBeNull();
    expect(await rulesWith(record()).verdict(CALL, { userId: UNA, text, via: 'name' })).toEqual({ kind: 'mention' });
  });

  it.each(REQUESTS)('%j is a request', async (text, rest) => {
    expect(talksAboutMilo(text)).toBe(false);
    expect(addressedRequest(text)).toBe(rest);
    expect(await rulesWith(record()).verdict(CALL, { userId: UNA, text, via: 'name' })).toEqual({ kind: 'request' });
  });

  it('the verdict is in before Milo\'s first audio could be: no timer, no I/O beyond the record (well under verdictWaitMs)', async () => {
    const rules = rulesWith(record());
    let settled = false;
    const p = rules.verdict(CALL, { userId: UNA, text: "I saw Milo's summary yesterday.", via: 'name' }).then((v) => { settled = true; return v; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(true); // before any timer of the router (held audio waits up to verdictWaitMs after its first frame)
    expect(await p).toEqual({ kind: 'mention' });
    // The provider's first audio came 841 ms after speech end at the soonest (probe (a)); the verdict needs none of that.
    expect(HANDSFREE.verdictWaitMs).toBeLessThanOrEqual(841);
  });

  it('"Milo, never mind" drops the turn; "Milo, stop" too (and is a barge-in while he speaks)', async () => {
    const rules = rulesWith(record());
    expect(await rules.verdict(CALL, { userId: UNA, text: 'Milo, never mind.', via: 'name' })).toEqual({ kind: 'mention' });
    expect(await rules.verdict(CALL, { userId: UNA, text: 'Milo, stop.', via: 'name' })).toEqual({ kind: 'mention' });
  });

  it('a person who is not admitted gets nothing, whatever they say; a broken policy fails closed', async () => {
    expect(await rulesWith(record()).verdict(CALL, { userId: LATE, text: "Milo, what's the time?", via: 'name' })).toEqual({ kind: 'mention' });
    expect(await rulesWith(record({ state: 'paused' })).verdict(CALL, { userId: UNA, text: "Milo, what's the time?", via: 'name' })).toEqual({ kind: 'mention' });
    const broken = rulesWith(record(), { policy: () => ({ ...DEFAULT_POLICY, handsfree: () => ({ admit: async () => 'route', heldAnswer: async () => { throw new Error('x'); }, instructions: () => null }) }) });
    expect(await broken.verdict(CALL, { userId: UNA, text: "Milo, what's the time?", via: 'name' })).toEqual({ kind: 'mention' });
  });

  it('a family\'s held answer is a fixed line; an empty one is handled with nothing to say; fixed-lines people get the refusal otherwise', async () => {
    const policy = (admission: 'route' | 'fixed-lines'): MeetingAssistantPolicy => ({
      ...DEFAULT_POLICY,
      handsfree: () => ({
        admit: async () => admission, refusal: 'I can only tell you the time.', instructions: () => null,
        heldAnswer: async ({ text }) => (/time/.test(text) ? 'Ten minutes left.' : /repeat/.test(text) ? '' : null),
      }),
    });
    const routed = rulesWith(record(), { policy: () => policy('route') });
    expect(await routed.verdict(CALL, { userId: UNA, text: 'Milo, how much time is left?', via: 'name' })).toEqual({ kind: 'fixed', line: 'Ten minutes left.' });
    expect(await routed.verdict(CALL, { userId: UNA, text: 'Milo, repeat that.', via: 'name' })).toEqual({ kind: 'mention' });
    expect(await routed.verdict(CALL, { userId: UNA, text: 'Milo, solve it for me.', via: 'name' })).toEqual({ kind: 'request' });
    const fixed = rulesWith(record(), { policy: () => policy('fixed-lines') });
    expect(await fixed.verdict(CALL, { userId: UNA, text: 'Milo, solve it for me.', via: 'name' })).toEqual({ kind: 'fixed', line: 'I can only tell you the time.' });
    expect(await fixed.verdict(CALL, { userId: UNA, text: "I saw Milo's summary.", via: 'name' })).toEqual({ kind: 'mention' });
    // A fixed-lines person has no follow-up window: without the name, nothing.
    expect(await fixed.verdict(CALL, { userId: UNA, text: 'How much time is left?', via: 'follow-up' })).toEqual({ kind: 'aside' });
  });
});

describe('the follow-up window: still for Milo, or an aside', () => {
  const STILL = ['And what about Germany?', 'What about Italy?', 'And in a regular year?', 'And in a regular year.', 'Or for a whole week.', 'Why is that?', 'Make it shorter.', 'Okay, now add two more.', 'How about next week', 'Can you send that to the channel?'];
  const ASIDES = ['Sarah, what do you think?', 'What do you think, Sarah?', 'Thanks.', 'Okay great.', 'Thank you so much.', "Let's move on to the next item.", 'I think we should ship it.', 'We can pick that up tomorrow.', 'Got it, makes sense.'];

  it.each(STILL)('%j continues the conversation (request)', async (text) => {
    expect(followUpKind(text)).toBe('request');
    expect(await rulesWith(record()).verdict(CALL, { userId: UNA, text, via: 'follow-up' })).toEqual({ kind: 'request' });
  });

  it.each(ASIDES)('%j is an aside: dropped, and the window closes', async (text) => {
    expect(followUpKind(text)).toBe('aside');
    expect(await rulesWith(record()).verdict(CALL, { userId: UNA, text, via: 'follow-up' })).toEqual({ kind: 'aside' });
  });

  it('a roster name turned to, lower case from the transcript, is an aside; a follow-up that mentions Milo is an aside', async () => {
    expect(followUpKind('vera, can you take that one?', ['Vera Lindqvist'])).toBe('aside');
    expect(followUpKind('can you take that one, vera?', ['Vera Lindqvist'])).toBe('aside');
    expect(followUpKind('can you take that one?', ['Vera Lindqvist'])).toBe('request');
    const rules = rulesWith(record(), { roster: () => ['Vera Lindqvist'] });
    expect(await rules.verdict(CALL, { userId: UNA, text: 'vera, can you take that one?', via: 'follow-up' })).toEqual({ kind: 'aside' });
    expect(await rules.verdict(CALL, { userId: UNA, text: "Milo's answer was right.", via: 'follow-up' })).toEqual({ kind: 'aside' });
    expect(await rules.verdict(CALL, { userId: UNA, text: 'Milo, and the year before?', via: 'follow-up' })).toEqual({ kind: 'request' });
  });
});

describe('overlap: echo vs barge-in, on words only', () => {
  const SAYING = "I'm Milo. The capital of France is Paris, and it has been since the tenth century.";

  it('Milo\'s own words coming back through a mic are echo (his name in them included), even misheard a little', () => {
    expect(overlapOf("I'm Milo, the capital", SAYING)).toBe('echo');
    expect(overlapOf('the capital of France is Paris', SAYING)).toBe('echo');
    expect(overlapOf('the capital of frants is paris and it has', SAYING)).toBe('echo');
    expect(createHandsfreeRules().overlap('Milo the capital of France', SAYING)).toBe('echo');
  });

  it('other words while he speaks are a barge-in; one word is a barge-in only when it is a stop he did not say', () => {
    expect(overlapOf('okay stop thanks', SAYING)).toBe('barge-in');
    expect(overlapOf("no that's not what I asked", SAYING)).toBe('barge-in');
    expect(overlapOf('Milo stop', SAYING)).toBe('barge-in'); // "Milo" is his word, "stop" is not
    expect(overlapOf('Milo the', SAYING)).toBe('echo');
    expect(overlapOf('Milo paris', SAYING)).toBe('unclear');
    expect(overlapOf('Milo stop please', SAYING)).toBe('barge-in');
    expect(overlapOf('wait', SAYING)).toBe('barge-in');
    expect(overlapOf('the', SAYING)).toBe('unclear');
    expect(overlapOf('hold on', SAYING)).toBe('barge-in');
  });

  it('too little to tell is unclear: nothing heard, his transcript not in yet, or his words running ahead of his transcript', () => {
    expect(overlapOf('', SAYING)).toBe('unclear');
    expect(overlapOf('the capital', '')).toBe('unclear');
    expect(overlapOf('wait a second please', '')).toBe('barge-in');
    expect(overlapOf('the capital of France is', 'The capital of')).toBe('unclear');
    expect(createHandsfreeRules().overlap(undefined as never, null as never)).toBe('unclear');
  });
});

describe('instructions: Work and Social are conversational under the flag; the flag off is today\'s text', () => {
  const base = { tenant: 'orgiq', roster: ['Una', 'Vera'], recordName: 'Auth' };

  it('the hands-free session hears one person, answers in short spoken turns and knows the follow-up window', () => {
    const text = meetingInstructions({ ...base, handsfree: {} });
    expect(text).toContain(HANDSFREE_TURN_RULES);
    expect(text).toContain('You hear only the person talking to you.');
    expect(text).not.toContain('You hear everyone at once');
    expect(text).not.toContain('Stay completely silent unless');
    expect(HANDSFREE_TURN_RULES).toMatch(/one or two short spoken sentences/);
    expect(HANDSFREE_TURN_RULES).toMatch(/without your name/);
    expect(HANDSFREE_TURN_RULES).toMatch(/turn to someone else.*say nothing/);
    expect(HANDSFREE_TURN_RULES).toMatch(/talked over, stop/);
    expect(handsfreeFamilyRules(CALL)).toBeNull();
    expect(handsfreeFamilyRules(SOCIAL)).toBeNull();
  });

  it('a family\'s rules follow the turn rules, and readAloudOnly gives way to hands-free', () => {
    const text = meetingInstructions({ ...base, readAloudOnly: true, delegates: true, handsfree: { familyRules: 'Never solve anything.' } });
    expect(text.indexOf('Never solve anything.')).toBeGreaterThan(text.indexOf(HANDSFREE_TURN_RULES));
    expect(text).not.toContain('in this meeting the system says every word');
  });

  it('without the flag nothing changes', () => {
    const off = meetingInstructions(base);
    expect(off).toContain('You hear everyone at once.');
    expect(off).toContain('Stay completely silent unless');
    expect(off).not.toContain(HANDSFREE_TURN_RULES);
    expect(meetingInstructions({ ...base, readAloudOnly: true })).toContain('Never answer anyone and never speak on your own');
  });
});

describe('provisional: the early verdict on words so far (review 1, item 9), and the admission cache', () => {
  const withFamily = (f: Partial<HandsfreeFamily>): MeetingAssistantPolicy => ({ ...DEFAULT_POLICY, handsfree: () => ({ admit: async () => 'route', instructions: () => null, ...f }) });

  it('is a request only for a person whose route admission is cached, on words addressed to Milo; never runs a held answer', async () => {
    const held = jest.fn(async () => 'There are ten minutes left.');
    const rules = rulesWith(record(), { policy: () => withFamily({ heldAnswer: held, mayBeHeld: ({ text }) => /time/.test(text) }) });
    expect(rules.provisional(CALL, { userId: UNA, text: "Milo, what's the capital of France", via: 'name' })).toBeNull(); // never admitted yet
    expect(await rules.admit(CALL, UNA)).toBe('route');
    expect(rules.provisional(CALL, { userId: UNA, text: "Milo, what's the capital of France", via: 'name' })).toBe('request');
    expect(rules.provisional(CALL, { userId: UNA, text: "I saw Milo's summary", via: 'name' })).toBeNull();
    expect(rules.provisional(CALL, { userId: UNA, text: 'Milo, never mind', via: 'name' })).toBeNull();
    expect(rules.provisional(CALL, { userId: UNA, text: 'Milo, how much time is left', via: 'name' })).toBeNull(); // may be held
    expect(rules.provisional(CALL, { userId: UNA, text: 'And in a leap year?', via: 'follow-up' })).toBe('request');
    expect(rules.provisional(CALL, { userId: UNA, text: 'Thanks.', via: 'follow-up' })).toBeNull();
    expect(held).not.toHaveBeenCalled();
  });

  it('mayBeFixed (film fix 4): words the family may hold, for a cached route admission, so the router asks the verdict on them now', async () => {
    const { INTERVIEWS_MILO_POLICY } = await import('../../interviews/milo-policy.js');
    const interview = INTERVIEWS_MILO_POLICY.handsfree!({ callId: CALL.callId, lobby: 'interviews:interview:iv-1', tenant: 't' });
    const rules = rulesWith(record(), { policy: () => withFamily({ heldAnswer: async () => null, mayBeHeld: interview.mayBeHeld! }) });
    expect(rules.mayBeFixed(CALL, { userId: UNA, text: 'Milo, how much time is left', via: 'name' })).toBe(false); // not admitted yet
    await rules.admit(CALL, UNA);
    expect(rules.mayBeFixed(CALL, { userId: UNA, text: 'Milo, how much time is left', via: 'name' })).toBe(true);
    expect(rules.mayBeFixed(CALL, { userId: UNA, text: 'Milo, can you repeat the question', via: 'name' })).toBe(true);
    expect(rules.mayBeFixed(CALL, { userId: UNA, text: 'Milo, what is a hash map', via: 'name' })).toBe(false);
    expect(rules.mayBeFixed(CALL, { userId: UNA, text: 'Milo, never mind', via: 'name' })).toBe(false);
    expect(rules.mayBeFixed(CALL, { userId: UNA, text: 'and how long is left', via: 'follow-up' })).toBe(true);
    const fixed = rulesWith(record(), { policy: () => withFamily({ admit: async () => 'fixed-lines', heldAnswer: async () => null, mayBeHeld: () => true }) });
    await fixed.admit(CALL, UNA);
    expect(fixed.mayBeFixed(CALL, { userId: UNA, text: 'Milo, how much time is left', via: 'name' })).toBe(false);
  });

  it('a family with a held answer and no mayBeHeld is never released early; fixed-lines and deny never', async () => {
    const rules = rulesWith(record(), { policy: () => withFamily({ heldAnswer: async () => null }) });
    await rules.admit(CALL, UNA);
    expect(rules.provisional(CALL, { userId: UNA, text: 'Milo, what is two plus two', via: 'name' })).toBeNull();
    const fixed = rulesWith(record(), { policy: () => withFamily({ admit: async () => 'fixed-lines' }) });
    await fixed.admit(CALL, UNA);
    expect(fixed.provisional(CALL, { userId: UNA, text: 'Milo, what is two plus two', via: 'name' })).toBeNull();
    const none = rulesWith(record());
    await none.admit(CALL, LATE);
    expect(none.provisional(CALL, { userId: LATE, text: 'Milo, what is two plus two', via: 'name' })).toBeNull();
  });

  it('caches an admission per person for about 3 s (injectable clock), then asks again; a failed read is not cached', async () => {
    let now = 1_000; let reads = 0; let rec: AssistantRecord | null = record();
    const rules = createHandsfreeRules({ record: async () => { reads += 1; return rec; }, now: () => now });
    expect(await rules.admit(CALL, UNA)).toBe('route');
    rec = record({ state: 'paused' });
    now += 2_900;
    expect(await rules.admit(CALL, UNA)).toBe('route');
    expect(await rules.verdict(CALL, { userId: UNA, text: 'Milo, what is two plus two?', via: 'name' })).toEqual({ kind: 'request' });
    expect(reads).toBe(1);
    expect(await rules.admit(CALL, VERA)).toBe('deny'); // per person
    now += 200;
    expect(await rules.admit(CALL, UNA)).toBe('deny');
    expect(rules.provisional(CALL, { userId: UNA, text: 'Milo, what is two plus two', via: 'name' })).toBeNull();
    let fail = true;
    const flaky = createHandsfreeRules({ record: async () => { if (fail) throw new Error('down'); return record(); }, now: () => now });
    expect(await flaky.admit(CALL, UNA)).toBe('deny');
    fail = false;
    expect(await flaky.admit(CALL, UNA)).toBe('route');
  });
});
