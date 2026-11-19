// The clarifying-question nudge (lib/interviews/coach/clarifying.ts; WHITEBOARD-PLAN step 2b): every branch of the rule,
// then the coach's read in a whiteboard round: the nudge shows once, by rule, with no model call and no hold.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture } from '../../../../mock/interviews.js';
import { interviewSuggestionsFixture } from '../../../../mock/interviews-suggestions.js';
import {
  CLARIFY_AFTER_MS, CLARIFY_INVITATION, CLARIFY_UNTIL_MS, CLARIFYING_MODEL_ID, asks, clarifyingNudge, keywords, type ClarifyFacts,
} from '../clarifying.js';
import type { CoachLine } from '../prompt.js';
import { answerSuggestion, setCoachDeps, suggestionFor, type CoachDeps, type CoachRef } from '../service.js';
import { MemorySuggestionStore, type SuggestionRecord } from '../store.js';
import type { CoachTranscript } from '../transcript.js';

const START = Date.UTC(2026, 11, 1, 15, 0);
const EXPECTED = ['How many reads per write: how often is a short link opened?', 'Do links expire, and can a user pick a custom alias?', 'How fast must a redirect be, and from where in the world?'];
const facts = (over: Partial<ClarifyFacts> = {}): ClarifyFacts => ({
  surface: 'board', startedAtMs: START, nowMs: START + CLARIFY_AFTER_MS + 1000,
  questions: [{ id: 'q-plain', competencyId: 'system-design' }, { id: 'q-short', competencyId: 'system-design', clarifying: EXPECTED }],
  lines: [{ seq: 1, side: 'panel', text: 'Design a URL shortener for 100M links a month.' }, { seq: 2, side: 'candidate', text: 'Sure. I will start with a service and a database.' }],
  log: [],
  ...over,
});
const logRow = (modelId: string): SuggestionRecord => ({
  id: 'sg-x', interviewId: 'iv', callId: 'c', throughSeq: 1, text: 't', competencyId: 'system-design', basedOn: null, madeAt: new Date(START).toISOString(),
  shownAt: null, answer: 'skip', answeredAt: null, spoken: false, modelId, promptVersion: 'v', dropped: null,
});
const candidate = (text: string): CoachLine => ({ seq: 9, side: 'candidate', text });

describe('the rule', () => {
  it('nudges a whiteboard round a few minutes in when the candidate asked none: the first clarifying question of the first question carrying them', () => {
    const nudge = clarifyingNudge(facts());
    expect(nudge).toMatchObject({ questionId: 'q-short', competencyId: 'system-design', expected: EXPECTED[0] });
    expect(nudge!.text).toContain(`"${EXPECTED[0]}"`);
  });

  it('never on the code pad, a behavioural round, or a round not started', () => {
    expect(clarifyingNudge(facts({ surface: 'pad' }))).toBeNull();
    expect(clarifyingNudge(facts({ surface: null }))).toBeNull();
    expect(clarifyingNudge(facts({ startedAtMs: null }))).toBeNull();
  });

  it('waits CLARIFY_AFTER_MS for the candidate to ask, and lets the moment pass after CLARIFY_UNTIL_MS', () => {
    expect(clarifyingNudge(facts({ nowMs: START + CLARIFY_AFTER_MS - 1 }))).toBeNull();
    expect(clarifyingNudge(facts({ nowMs: START + CLARIFY_AFTER_MS }))).not.toBeNull();
    expect(clarifyingNudge(facts({ nowMs: START + CLARIFY_UNTIL_MS }))).not.toBeNull();
    expect(clarifyingNudge(facts({ nowMs: START + CLARIFY_UNTIL_MS + 1 }))).toBeNull();
  });

  it('once per interview: a logged nudge (whatever its answer) stops another; a model suggestion does not', () => {
    expect(clarifyingNudge(facts({ log: [logRow(CLARIFYING_MODEL_ID)] }))).toBeNull();
    expect(clarifyingNudge(facts({ log: [logRow('amazon.nova-pro-v1:0')] }))).not.toBeNull();
  });

  it('nothing when no question of the round carries clarifying questions', () => {
    expect(clarifyingNudge(facts({ questions: [{ id: 'q', competencyId: 'c' }, { id: 'q2', competencyId: 'c', clarifying: ['  '] }] }))).toBeNull();
  });

  it('nothing once the candidate asked one: words of an expected question, or any question about what clarifying is about', () => {
    expect(clarifyingNudge(facts({ lines: [candidate('Before I draw: do the links expire, or live forever?')] }))).toBeNull();
    expect(clarifyingNudge(facts({ lines: [candidate('what is the read to write ratio we expect')] }))).toBeNull();
    expect(clarifyingNudge(facts({ lines: [candidate('How many users are we talking about?')] }))).toBeNull();
    // The panel saying it does not count, and a statement on another subject is not a question.
    expect(clarifyingNudge(facts({ lines: [{ seq: 1, side: 'panel', text: 'Do links expire? Can a user pick a custom alias?' }] }))).not.toBeNull();
    expect(clarifyingNudge(facts({ lines: [candidate('I would put a load balancer in front of the app servers.')] }))).not.toBeNull();
  });

  it('keywords drop short and stop words and a plural s; asks needs two shared words, or one inside a question', () => {
    expect([...keywords('How many links does the user open, per second?')].sort()).toEqual(['link', 'open', 'second', 'user']);
    expect(asks('links expire after a year I guess', 'Do links expire, and can a user pick a custom alias?')).toBe(true);
    expect(asks('the links are short', 'Do links expire, and can a user pick a custom alias?')).toBe(false);
    expect(asks('do the links expire?', 'Do links expire, and can a user pick a custom alias?')).toBe(true);
    expect(asks('is that okay?', 'Do links expire, and can a user pick a custom alias?')).toBe(false);
  });
});

describe('the coach in a whiteboard round', () => {
  const store = new MemorySuggestionStore();
  let transcript: CoachTranscript | null;
  let now = START;
  let n = 0;
  // The model is never asked in these reads: the nudge is a rule, and without it the hold is refused before any call.
  const suggest = jest.fn(async () => { throw new Error('no model call here'); });
  const model = jest.fn(() => ({ modelId: 'test-model', suggest }));
  const reserve = jest.fn(async () => ({ ok: false }));

  function boardRef(): CoachRef {
    const opening = interviewOpeningsFixture.rows().find((o) => o.kit.rounds.some((r) => r.surface === 'board') && o.kit.questions.some((q) => q.clarifying?.length))!;
    const round = opening.kit.rounds.find((r) => r.surface === 'board')!;
    const app = interviewApplicationsFixture.rows().find((a) => a.openingId === opening.id)!;
    const base = interviewsFixture.rows().find((i) => i.applicationId === app.id)!;
    const asked = opening.kit.questions.find((q) => q.clarifying?.length)!;
    return {
      opening,
      interview: { ...base, id: 'iv-board-test', roundId: round.id, type: 'technical', state: 'live', startedAt: new Date(START).toISOString(), questionIds: [asked.id] },
    };
  }

  beforeEach(() => {
    fixtureRegistry.resetAll('default');
    interviewSuggestionsFixture.rows().splice(0);
    now = START + 5 * 60_000;
    n = 0;
    model.mockClear(); suggest.mockClear(); reserve.mockClear();
    transcript = { callId: 'call-b', lastSeq: 2, lines: [
      { seq: 1, side: 'panel', text: 'Here is the prompt on the board. Take it away.' },
      { seq: 2, side: 'candidate', text: 'I will start with an API server and a database behind it.' }] };
    setCoachDeps({
      store: () => store, consents: async () => ({ transcription: true, milo: true }), transcript: async () => transcript, model, reserve,
      settle: jest.fn(), release: jest.fn(), now: () => now, newId: () => `sg-b${++n}`,
    } as unknown as CoachDeps);
  });
  afterAll(() => setCoachDeps(null));

  it('shows the lead one clarifying question by rule, logs it under the rule, calls no model and holds no money; the next read shows the same one', async () => {
    const ref = boardRef();
    const lead = { userId: ref.interview.leadId };
    const first = await suggestionFor(ref, lead);
    expect(first.kind).toBe('ok');
    const body = (first as { body: { suggestion: { id: string; text: string; competency: { id: string } } | null } }).body;
    const expected = ref.opening.kit.questions.find((q) => q.id === ref.interview.questionIds[0])!.clarifying![0]!;
    expect(body.suggestion).toMatchObject({ id: 'sg-b1', competency: { id: ref.opening.kit.questions.find((q) => q.id === ref.interview.questionIds[0])!.competencyId } });
    expect(body.suggestion!.text).toContain(expected);
    expect(suggest).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    const log = await store.listSuggestions('iv-board-test');
    expect(log.map((r) => [r.modelId, r.dropped, r.shownAt !== null])).toEqual([[CLARIFYING_MODEL_ID, null, true]]);
    const again = await suggestionFor(ref, lead);
    expect((again as { body: { suggestion: { id: string } } }).body.suggestion.id).toBe('sg-b1');
    expect(await store.listSuggestions('iv-board-test')).toHaveLength(1);
  });

  it('two tabs reading at once log the nudge once: the second read sees the first one\'s row and shows it', async () => {
    const ref = boardRef();
    const lead = { userId: ref.interview.leadId };
    // The second tab's transcript read waits until the first tab has logged its nudge: both read the empty log first.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reads = 0;
    setCoachDeps({
      store: () => store, consents: async () => ({ transcription: true, milo: true }),
      transcript: async () => { if (++reads === 2) await gate; return transcript; }, model, reserve,
      settle: jest.fn(), release: jest.fn(), now: () => now, newId: () => `sg-b${++n}`,
    } as unknown as CoachDeps);
    const one = suggestionFor(ref, lead);
    const two = suggestionFor(ref, lead);
    const first = await one;
    release();
    const second = await two;
    const ids = [first, second].map((o) => (o as { body: { suggestion: { id: string } | null } }).body.suggestion?.id);
    expect(ids).toEqual(['sg-b1', 'sg-b1']);
    expect((await store.listSuggestions('iv-board-test')).filter((r) => r.modelId === CLARIFYING_MODEL_ID)).toHaveLength(1);
  });

  it('Have Milo ask on the nudge says a neutral invitation to the candidate, never the lead\'s coaching note', async () => {
    const ref = boardRef();
    const lead = { userId: ref.interview.leadId };
    const shown = await suggestionFor(ref, lead);
    const note = (shown as { body: { suggestion: { id: string; text: string } } }).body.suggestion;
    const posted: string[] = [];
    const speak = {
      post: jest.fn(async (_i: unknown, _c: unknown, input: { text: string }) => { posted.push(input.text); return { row: { id: 'said-1', text: input.text, askedBy: lead.userId }, posted: true } as never; }),
      say: jest.fn(async (_i: unknown, row: { text: string }) => { posted.push(row.text); return { spoken: true }; }),
    };
    setCoachDeps({
      store: () => store, consents: async () => ({ transcription: true, milo: true }), transcript: async () => transcript, model, reserve,
      settle: jest.fn(), release: jest.fn(), now: () => now, newId: () => `sg-b${++n}`, speak,
    } as unknown as CoachDeps);
    expect(await answerSuggestion(ref, lead, note.id, 'milo-ask')).toEqual({ kind: 'ok', said: 'spoken' });
    expect(posted).toEqual([CLARIFY_INVITATION, CLARIFY_INVITATION]);
    expect(posted.join(' ')).not.toContain('strong candidate');
    // The lead's log keeps the note it was shown.
    expect((await store.listSuggestions('iv-board-test')).find((r) => r.id === note.id)).toMatchObject({ text: note.text, answer: 'milo-ask' });
  });

  it('no nudge when the candidate asked, too early, or on the code pad', async () => {
    const ref = boardRef();
    const lead = { userId: ref.interview.leadId };
    transcript!.lines.push({ seq: 3, side: 'candidate', text: 'Before I draw, how many users and how much traffic at peak?' });
    transcript!.lastSeq = 3;
    const asked = await suggestionFor(ref, lead);
    expect(asked.kind).toBe('ok');
    expect((await store.listSuggestions('iv-board-test')).filter((r) => r.modelId === CLARIFYING_MODEL_ID)).toHaveLength(0);

    transcript!.lines.pop();
    now = START + 60_000;
    const pad: CoachRef = { ...ref, interview: { ...ref.interview, id: 'iv-board-early' } };
    await suggestionFor(pad, lead);
    expect((await store.listSuggestions('iv-board-early')).filter((r) => r.modelId === CLARIFYING_MODEL_ID)).toHaveLength(0);

    now = START + 5 * 60_000;
    const coding = ref.opening.kit.rounds.find((r) => r.type === 'technical' && r.surface !== 'board')!;
    await suggestionFor({ ...ref, interview: { ...ref.interview, id: 'iv-pad', roundId: coding.id } }, lead);
    expect((await store.listSuggestions('iv-pad')).filter((r) => r.modelId === CLARIFYING_MODEL_ID)).toHaveLength(0);
  });
});
