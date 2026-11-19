// The coach for the lead (lib/interviews/coach/service.ts; row I3.3, contract D7): fixed transcripts through the scripted
// model and the rules, the money, the log, and the lead's answer.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture } from '../../../../mock/interviews.js';
import { interviewSuggestionsFixture } from '../../../../mock/interviews-suggestions.js';
import { ScriptedCoachModel, type CoachModel } from '../model.js';
import type { CoachLine } from '../prompt.js';
import { MAX_ATTEMPTS_PER_INTERVIEW, SUGGESTION_GAP_MS } from '../rules.js';
import { MODEL_FAILURES_BEFORE_PAUSE, MODEL_FAILURES_KEPT, answerSuggestion, modelFailuresOf, noteModelCall, setCoachDeps, suggestionFor, type CoachDeps, type CoachRef } from '../service.js';
import { MemorySuggestionStore } from '../store.js';
import type { CoachTranscript } from '../transcript.js';
import { MemorySaidStore, setSaidStore, setSpeakDeps } from '../../speak/index.js';

const IV = 'iv-n5z9f2cq';
const WEN = { userId: 'u-wen' };
const HUGO = { userId: 'u-hugo' };

function refOf(state = 'live'): CoachRef {
  const interview = { ...interviewsFixture.rows().find((i) => i.id === IV)!, state: state as never };
  const app = interviewApplicationsFixture.rows().find((a) => a.id === interview.applicationId)!;
  return { interview, opening: interviewOpeningsFixture.rows().find((o) => o.id === app.openingId)! };
}

let now = Date.UTC(2026, 11, 1, 15, 0);
let n = 0;
let transcript: CoachTranscript | null;
let consent: { transcription: boolean; milo: boolean } | null;
let deps: { [K in keyof CoachDeps]: jest.Mock };
const store = new MemorySuggestionStore();

const lines = (...said: [CoachLine['side'], string][]): CoachLine[] => said.map(([side, text], i) => ({ seq: i + 1, side, text }));
const say = (side: CoachLine['side'], text: string) => {
  const seq = (transcript?.lastSeq ?? 0) + 1;
  transcript = { callId: 'call-1', lastSeq: seq, lines: [...(transcript?.lines ?? []), { seq, side, text }] };
};

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  interviewSuggestionsFixture.rows().splice(0);
  now = Date.UTC(2026, 11, 1, 15, 0);
  n = 0;
  consent = { transcription: true, milo: true };
  transcript = { callId: 'call-1', lastSeq: 2, lines: lines(
    ['panel', 'Tell me about someone on your team who was struggling. What did you do, and what happened?'],
    ['candidate', 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.']) };
  deps = {
    store: jest.fn(() => store),
    consents: jest.fn(async () => consent),
    transcript: jest.fn(async () => transcript),
    model: jest.fn(() => new ScriptedCoachModel()),
    reserve: jest.fn(async (i) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `iv:op-em:${IV}:coach:${i.key}`, amountUsd: i.estimateUsd })),
    settle: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    now: jest.fn(() => now),
    newId: jest.fn(() => `sg-${++n}`),
  };
  setCoachDeps(deps as unknown as CoachDeps);
  post = jest.fn(async () => true);
  setSpeakDeps({ post });
});
afterAll(() => { setCoachDeps(null); setSpeakDeps(null); });
/** The call chat post behind speak/index.ts `logAndPost` (the coach posts through it). */
let post: jest.Mock;

const read = async (viewer = WEN, ref = refOf()) => {
  const out = await suggestionFor(ref, viewer);
  if (out.kind !== 'ok') throw new Error(out.kind);
  return out.body;
};

describe('a fixed transcript through the scripted model', () => {
  it('suggests the next competency\'s question (not keyed to a line, so it quotes none), logs it shown, and books the hold', async () => {
    const body = await read();
    expect(body).toEqual({
      suggestion: {
        id: 'sg-1', text: 'Your team\'s roadmap slips by a quarter. Walk me through how you tell your stakeholders and what you change.',
        competency: { id: 'delivery', name: 'Delivery' },
        basedOn: null, shownAt: new Date(now).toISOString(),
      },
      paused: null, retryAfterMs: 15_000,
    });
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ interviewId: IV, part: 'coach', key: 'sg-1' }));
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ sourceId: `iv:op-em:${IV}:coach:sg-1`, costUsd: 0, model: 'scripted-coach' }));
    const [row] = await store.listSuggestions(IV);
    expect(row).toMatchObject({ callId: 'call-1', throughSeq: 2, answer: null, spoken: false, modelId: 'scripted-coach', promptVersion: 'coach-2026-11-18.1', dropped: null });
  });

  it('reading again returns the same waiting suggestion, makes no call and keeps the first shown time', async () => {
    const first = await read();
    now += 5 * 60_000;
    say('candidate', 'And then we reviewed the plan after a month.');
    const again = await read();
    expect(again.suggestion).toEqual(first.suggestion);
    expect(deps.reserve).toHaveBeenCalledTimes(1);
  });

  it('after an answer: nothing for 90 seconds, nothing without new lines, then the next one', async () => {
    const first = await read();
    expect(await answerSuggestion(refOf(), WEN, first.suggestion!.id, 'ask')).toEqual({ kind: 'ok' });
    now += 30_000;
    expect(await read()).toEqual({ suggestion: null, paused: null, retryAfterMs: SUGGESTION_GAP_MS - 30_000 });
    now += SUGGESTION_GAP_MS;
    expect(await read()).toMatchObject({ suggestion: null, retryAfterMs: 15_000 });
    say('candidate', 'I told them early and moved two items to the next quarter.');
    const next = await read();
    expect(next.suggestion).toMatchObject({ id: 'sg-2', competency: { id: 'influence' }, basedOn: null });
    expect(deps.reserve).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_ATTEMPTS_PER_INTERVIEW} attempts`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_INTERVIEW; i += 1) {
      await store.appendSuggestion({ id: `old-${i}`, interviewId: IV, callId: 'call-1', throughSeq: 0, text: '', competencyId: null, basedOn: null,
        madeAt: new Date(now - 3_600_000 + i).toISOString(), shownAt: null, answer: null, answeredAt: null, spoken: false, modelId: 'm', promptVersion: 'v', dropped: 'error' });
    }
    expect(await read()).toMatchObject({ suggestion: null, retryAfterMs: 600_000 });
    expect(deps.reserve).not.toHaveBeenCalled();
  });
});

describe('who and when', () => {
  it('not-found for a panel member, and nothing is read for them', async () => {
    expect(await suggestionFor(refOf(), HUGO)).toEqual({ kind: 'not-found' });
    expect(deps.consents).not.toHaveBeenCalled();
    expect(deps.transcript).not.toHaveBeenCalled();
  });

  it('nothing while the interview is not live, and the transcript is not read', async () => {
    expect(await read(WEN, refOf('ready'))).toEqual({ suggestion: null, paused: null, retryAfterMs: 30_000 });
    expect(deps.transcript).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing answered', null],
    ['Milo declined', { transcription: true, milo: false }],
  ])('consent off (%s): no suggestion, the transcript is not read and no money is held', async (_l, c) => {
    consent = c;
    expect(await read()).toEqual({ suggestion: null, paused: null, retryAfterMs: 120_000 });
    expect(deps.transcript).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it('a refused hold makes no call and answers paused: budget', async () => {
    const model = { kind: 'scripted', modelId: 'x', suggest: jest.fn() } as unknown as CoachModel;
    deps.model.mockReturnValue(model);
    deps.reserve.mockResolvedValue({ ok: false, refusal: { status: 402, body: {} } });
    expect(await read()).toEqual({ suggestion: null, paused: 'budget', retryAfterMs: SUGGESTION_GAP_MS });
    expect(model.suggest).not.toHaveBeenCalled();
    expect(await store.listSuggestions(IV)).toEqual([]);
  });

  it('one call in flight per interview: a second read while the first thinks gets nothing', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    const slow = new ScriptedCoachModel();
    deps.model.mockReturnValue({ kind: 'scripted', modelId: slow.modelId, suggest: async (i: never) => { await gate; return slow.suggest(i); } });
    const first = read();
    await new Promise((r) => setImmediate(r));
    expect(await read()).toEqual({ suggestion: null, paused: null, retryAfterMs: 5_000 });
    finish();
    expect((await first).suggestion).not.toBeNull();
    expect(deps.reserve).toHaveBeenCalledTimes(1);
  });
});

describe('a dropped answer', () => {
  it.each([
    ['malformed', 'Ask about the plan.'],
    ['judges', JSON.stringify({ text: 'That was a strong answer, ask for more?', competencyId: 'delivery', basedOn: null })],
    ['personal', JSON.stringify({ text: 'They sound nervous, slow down?', competencyId: 'delivery', basedOn: null })],
    ['off-kit', JSON.stringify({ text: 'What is a monad?', competencyId: 'functional', basedOn: null })],
  ])('%s: logged as its code with no text, never shown, nothing of it logged to the console', async (code, raw) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    deps.model.mockReturnValue({ kind: 'bedrock', modelId: 'amazon.nova-pro-v1:0', suggest: async () => ({ raw, code: 'ok', sent: true, usage: { inputTokens: 1000, outputTokens: 40 } }) });
    expect(await read()).toEqual({ suggestion: null, paused: null, retryAfterMs: SUGGESTION_GAP_MS });
    expect(await store.listSuggestions(IV)).toEqual([expect.objectContaining({ text: '', competencyId: null, basedOn: null, shownAt: null, dropped: code, modelId: 'amazon.nova-pro-v1:0' })]);
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ provider: 'bedrock', inputTokens: 1000, outputTokens: 40 }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/nervous|strong answer|monad|Ask about/);
    warn.mockRestore();
  });

  it('a call that never left releases its hold', async () => {
    deps.model.mockReturnValue({ kind: 'bedrock', modelId: 'amazon.nova-pro-v1:0', suggest: async () => { throw new Error('no client'); } });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await read();
    expect(deps.release).toHaveBeenCalledWith(['h-sg-1']);
    expect(deps.settle).not.toHaveBeenCalled();
  });
});

describe('a failing model', () => {
  const failing = (code: 'error' | 'timeout' = 'error') => ({ kind: 'bedrock', modelId: 'amazon.nova-pro-v1:0', suggest: async () => ({ raw: null, code, sent: true, usage: null }) });

  it('a thrown error is logged by its name only, never its message', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = Object.assign(new Error('secret prompt text'), { name: 'ThrottlingException' });
    deps.model.mockReturnValue({ kind: 'bedrock', modelId: 'm', suggest: async () => { throw boom; } });
    await read();
    expect(warn).toHaveBeenCalledWith('[interviews] coach model failed', 'ThrottlingException');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    warn.mockRestore();
  });

  it(`pauses with reason model after ${MODEL_FAILURES_BEFORE_PAUSE} failures in a row, and keeps saying so between attempts`, async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    deps.model.mockReturnValue(failing());
    for (let i = 1; i < MODEL_FAILURES_BEFORE_PAUSE; i += 1) {
      expect((await read()).paused).toBeNull();
      now += SUGGESTION_GAP_MS + 1;
      say('candidate', `Another point ${i}.`);
    }
    expect(await read()).toEqual({ suggestion: null, paused: 'model', retryAfterMs: SUGGESTION_GAP_MS });
    now += 1_000;
    expect((await read()).paused).toBe('model'); // inside the gap: no call, still paused
  });

  it(`holds counts for at most ${MODEL_FAILURES_KEPT} interviews, the least recently failed dropped first`, () => {
    noteModelCall('iv-first', true);
    noteModelCall('iv-kept', true);
    for (let i = 0; i < MODEL_FAILURES_KEPT - 2; i += 1) noteModelCall(`iv-round-${i}`, true);
    noteModelCall('iv-kept', true); // failed again: now the most recent
    noteModelCall('iv-one-more', true);
    expect([modelFailuresOf('iv-first'), modelFailuresOf('iv-kept'), modelFailuresOf('iv-one-more')]).toEqual([0, 2, 1]);
    noteModelCall('iv-kept', false);
    expect(modelFailuresOf('iv-kept')).toBe(0);
  });

  it('a success clears the count', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    deps.model.mockReturnValue(failing('timeout'));
    for (let i = 0; i < MODEL_FAILURES_BEFORE_PAUSE; i += 1) { await read(); now += SUGGESTION_GAP_MS + 1; say('candidate', `Point ${i}.`); }
    deps.model.mockReturnValue(new ScriptedCoachModel());
    const ok = await read();
    expect(ok.suggestion).not.toBeNull();
    expect(ok.paused).toBeNull();
    deps.model.mockReturnValue(failing());
    now += SUGGESTION_GAP_MS + 1;
    await answerSuggestion(refOf(), WEN, ok.suggestion!.id, 'skip');
    now += SUGGESTION_GAP_MS + 1;
    say('candidate', 'More to say here.');
    expect((await read()).paused).toBeNull(); // one failure after the success is not a pause
  });
});

describe('the lead\'s answer', () => {
  it('is written once; a second is answered; Have Milo ask is logged unspoken and then posted to the call chat', async () => {
    const { suggestion } = await read();
    // Posted, but no meeting assistant runs in this process to say it: in the chat, and why not aloud.
    expect(await answerSuggestion(refOf(), WEN, suggestion!.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'chat', why: 'not-in-call' });
    const [row] = await store.listSuggestions(IV);
    expect(row).toMatchObject({ answer: 'milo-ask', spoken: false, answeredAt: new Date(now).toISOString() });
    expect(post).toHaveBeenCalledWith('call-1', suggestion!.text, 'question');
    expect(await answerSuggestion(refOf(), WEN, suggestion!.id, 'skip')).toEqual({ kind: 'answered' });
  });

  it('Have Milo ask marks its said-log row posted once the chat has it, so the recap keeps the question', async () => {
    const said = new MemorySaidStore();
    setSaidStore(said);
    const posts: string[] = [];
    setSpeakDeps({ post: async (_c, text) => { posts.push(text); return true; } });
    setCoachDeps(deps as unknown as CoachDeps);
    try {
      const { suggestion } = await read();
      expect(await answerSuggestion(refOf(), WEN, suggestion!.id, 'milo-ask')).toMatchObject({ kind: 'ok', said: 'chat' });
      expect(posts).toEqual([suggestion!.text]);
      expect(await said.list(IV)).toEqual([expect.objectContaining({ kind: 'question', source: 'suggestion', suggestionId: suggestion!.id, posted: true })]);
    } finally { setSaidStore(null); }
  });

  it('I will ask it and Skip post nothing', async () => {
    const { suggestion } = await read();
    await answerSuggestion(refOf(), WEN, suggestion!.id, 'skip');
    expect(post).not.toHaveBeenCalled();
  });

  it('only the lead, only while live, only a suggestion of this interview', async () => {
    const { suggestion } = await read();
    expect(await answerSuggestion(refOf(), HUGO, suggestion!.id, 'ask')).toEqual({ kind: 'not-found' });
    expect(await answerSuggestion(refOf('ended'), WEN, suggestion!.id, 'ask')).toEqual({ kind: 'not-live' });
    expect(await answerSuggestion(refOf(), WEN, 'sg-unknown', 'ask')).toEqual({ kind: 'not-found' });
  });
});

describe('the consent read (D4)', () => {
  it('agrees with consentsFor: Milo only with the transcript, null when nothing was answered', async () => {
    const { coachConsents } = await import('../service.js');
    const { consentsFor } = await import('../../consent/index.js');
    const { interviewConsentsFixture } = await import('../../../../mock/interviews-consents.js');
    const row = interviewConsentsFixture.rows()[0]!;
    for (const [transcription, milo] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      Object.assign(row, { transcription, milo });
      expect(await coachConsents(row.interviewId)).toEqual({ transcription: (await consentsFor(row.interviewId))!.transcription, milo: (await consentsFor(row.interviewId))!.milo });
    }
    expect(await coachConsents('iv-nobody')).toBeNull();
    expect(await consentsFor('iv-nobody')).toBeNull();
  });
});

// Lane SPEAK (row I3.5): after the log row and the chat post, the words are said aloud; `spoken` only when relayed.
describe('Have Milo ask, said aloud (I3.5)', () => {
  it('logs, posts, then says; spoken and `said: spoken` only when relayed; chat only otherwise, with why', async () => {
    const steps: string[] = [];
    let out: { spoken: true } | { spoken: false; why: string } = { spoken: true };
    const speak = {
      post: jest.fn(async (_i: unknown, _c: unknown, input: { text: string }) => { steps.push('log, post, mark'); return { row: { id: 'said-1', text: input.text, askedBy: 'u-wen' }, posted: true } as never; }),
      say: jest.fn(async () => { steps.push('say'); return out; }),
    };
    setCoachDeps({ ...(deps as unknown as CoachDeps), speak: speak as unknown as CoachDeps['speak'] });
    let { suggestion } = await read();
    expect(await answerSuggestion(refOf(), WEN, suggestion!.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'spoken' });
    expect(steps).toEqual(['log, post, mark', 'say']);
    expect((await store.listSuggestions(IV)).find((r) => r.id === suggestion!.id)).toMatchObject({ answer: 'milo-ask', spoken: true });
    out = { spoken: false, why: 'budget' }; now += 10 * 60_000;
    ({ suggestion } = await read());
    if (suggestion) {
      expect(await answerSuggestion(refOf(), WEN, suggestion.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'chat', why: 'budget' });
      expect((await store.listSuggestions(IV)).find((r) => r.id === suggestion!.id)).toMatchObject({ spoken: false });
    }
  });

  it('nothing posted (Milo not in the call, or no call found) answers `said: none` with why, never a chat claim', async () => {
    const speak = { post: jest.fn(async () => ({ row: { id: 'said-1' }, posted: false }) as never), say: jest.fn() };
    setCoachDeps({ ...(deps as unknown as CoachDeps), speak: speak as unknown as CoachDeps['speak'] });
    const { suggestion } = await read();
    expect(await answerSuggestion(refOf(), WEN, suggestion!.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'none', why: 'not-in-call' });
    expect(speak.say).not.toHaveBeenCalled();
  });

  it('a failure after the chat post still says the words are in the chat; one before it says nothing was posted', async () => {
    const speak = { post: jest.fn(async () => ({ row: { id: 'said-1' }, posted: true }) as never), say: jest.fn(async () => { throw new Error('boom'); }) };
    setCoachDeps({ ...(deps as unknown as CoachDeps), speak: speak as unknown as CoachDeps['speak'] });
    let { suggestion } = await read();
    expect(await answerSuggestion(refOf(), WEN, suggestion!.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'chat', why: 'not-said' });
    speak.post.mockImplementation(async () => { throw new Error('log down'); });
    now += 10 * 60_000;
    ({ suggestion } = await read());
    if (suggestion) expect(await answerSuggestion(refOf(), WEN, suggestion.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'none', why: 'not-said' });
  });
});

describe('the edges (hardening H3, O-108)', () => {
  const kit = () => refOf().opening.kit;
  // The seeded kit is shared by reference across resets: the edits below are made on a copy, put back after each test.
  let saved: ReturnType<typeof kit>;
  beforeEach(() => { const opening = refOf().opening; saved = opening.kit; opening.kit = structuredClone(saved); });
  afterEach(() => { refOf().opening.kit = saved; });

  it('the kit edited mid-interview: a waiting suggestion is shown under the competency\'s new name, or a plain one once the competency is gone', async () => {
    const first = await read();
    expect(first.suggestion!.competency).toEqual({ id: 'delivery', name: 'Delivery' });
    kit().competencies.find((c) => c.id === 'delivery')!.name = 'Shipping';
    expect((await read()).suggestion).toEqual({ ...first.suggestion, competency: { id: 'delivery', name: 'Shipping' } });
    kit().competencies.splice(kit().competencies.findIndex((c) => c.id === 'delivery'), 1);
    expect((await read()).suggestion).toEqual({ ...first.suggestion, competency: { id: 'delivery', name: 'Competency' } });
    expect(deps.reserve).toHaveBeenCalledTimes(1);
  });

  it('the kit edited mid-interview: the next call reads the kit as it is now, and an answer tied to a removed competency is dropped off-kit', async () => {
    const first = await read();
    await answerSuggestion(refOf(), WEN, first.suggestion!.id, 'ask');
    const seen: string[][] = [];
    let answer = JSON.stringify({ text: 'Who did you tell first when it slipped?', competencyId: 'delivery', basedOn: null });
    deps.model.mockReturnValue({ kind: 'bedrock', modelId: 'amazon.nova-pro-v1:0', suggest: async (input: { competencies: { id: string }[] }) => {
      seen.push(input.competencies.map((c) => c.id));
      return { raw: answer, code: 'ok', sent: true, usage: { inputTokens: 900, outputTokens: 30 } };
    } });
    kit().competencies.splice(kit().competencies.findIndex((c) => c.id === 'delivery'), 1);
    now += SUGGESTION_GAP_MS + 1;
    say('candidate', 'I told my manager the same day.');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await read()).toEqual({ suggestion: null, paused: null, retryAfterMs: SUGGESTION_GAP_MS });
    warn.mockRestore();
    expect(seen[0]).not.toContain('delivery');
    expect((await store.listSuggestions(IV)).at(-1)).toMatchObject({ dropped: 'off-kit', text: '' });
    answer = JSON.stringify({ text: 'Who did you tell first?', competencyId: kit().competencies[0]!.id, basedOn: null });
    now += SUGGESTION_GAP_MS + 1;
    say('candidate', 'And the team the next morning.');
    expect((await read()).suggestion).toMatchObject({ text: 'Who did you tell first?', competency: { id: kit().competencies[0]!.id } });
  });

  it('Bedrock answers with no usage: the suggestion is shown and the hold is settled on the estimate, marked estimated', async () => {
    const { BedrockCoachModel, estimateCoachTokens } = await import('../model.js');
    const { coachInput } = await import('../service.js');
    const { estimateUsageCost } = await import('../../../pricing.js');
    const send = jest.fn(async () => ({ output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ text: 'Who did you bring in first?', competencyId: 'delivery', basedOn: null }) }] } } }));
    deps.model.mockReturnValue(new BedrockCoachModel({ send: send as never, modelId: 'amazon.nova-pro-v1:0' }));
    const body = await read();
    expect(body.suggestion).toMatchObject({ text: 'Who did you bring in first?', competency: { id: 'delivery' } });
    expect(send).toHaveBeenCalledTimes(1);
    const estimate = estimateCoachTokens(coachInput(refOf(), transcript!.lines, []));
    expect(deps.settle).toHaveBeenCalledWith({
      sourceId: `iv:op-em:${IV}:coach:sg-1`, costUsd: estimateUsageCost('amazon.nova-pro-v1:0', estimate), basis: 'estimated', model: 'amazon.nova-pro-v1:0', actorId: 'u-wen',
      provider: 'bedrock', inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens,
    });
    expect(estimate.inputTokens).toBeGreaterThan(0);
  });
});
