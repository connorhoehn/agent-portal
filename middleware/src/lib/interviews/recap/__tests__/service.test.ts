// Milo's recap (lib/interviews/recap/service.ts; row I5.2, contract E3): the open stores the ratings first, the first open
// writes the recap once, consent and money come before any call, at most three attempts, one in flight, reads never write.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture } from '../../../../mock/interviews.js';
import { interviewRecapOpensFixture, interviewRecapsFixture } from '../../../../mock/interviews-recaps.js';
import type { CoachModelResult } from '../../coach/model.js';
import type { CoachTranscript } from '../../coach/transcript.js';
import { ScriptedRecapModel, type RecapModel } from '../model.js';
import { RECAP_MAX_LINES, type RecapInput } from '../prompt.js';
import { checkOpenRatings, eraseRecapRows, openRecap, ratingsAtRecap, readRecap, recapInput, RECAP_MAX_ATTEMPTS, resetRecapAttempts, saidInCall, setRecapDeps, type RecapDeps, type RecapRef } from '../service.js';
import { MemoryRecapStore } from '../store.js';
import { MemorySaidStore, setSaidStore, type SaidRecord } from '../../speak/store.js';

// Nadia's leadership round, made to have ended: the Engineering Manager kit (behavioural).
const IV = 'iv-n5z9f2cq';
const WEN = { userId: 'u-wen' };
const HUGO = { userId: 'u-hugo' };

function refOf(): RecapRef {
  // The lead chose the people-leadership question for it.
  const interview = { ...interviewsFixture.rows().find((i) => i.id === IV)!, state: 'ended' as const, questionIds: ['q-em-struggling'] };
  const app = interviewApplicationsFixture.rows().find((a) => a.id === interview.applicationId)!;
  return { interview, opening: interviewOpeningsFixture.rows().find((o) => o.id === app.openingId)! };
}
const ratings = (rating: 1 | 2 | 3 | 4 = 3) => refOf().opening.kit.competencies.map((c) => ({ competencyId: c.id, rating }));
const firstQuestion = () => refOf().opening.kit.questions.find((q) => q.id === 'q-em-struggling')!;

let transcript: CoachTranscript | null;
let consent: { transcription: boolean; milo: boolean } | null;
let deps: { [K in keyof RecapDeps]: jest.Mock };
const store = new MemoryRecapStore();

/** A model that answers what it is given, in order. */
const answering = (...raws: (string | 'timeout')[]): RecapModel => {
  let n = 0;
  return {
    kind: 'bedrock', modelId: 'amazon.nova-pro-v1:0',
    write: jest.fn(async (_i: RecapInput): Promise<CoachModelResult> => {
      const raw = raws[Math.min(n++, raws.length - 1)]!;
      return raw === 'timeout' ? { raw: null, code: 'timeout', sent: true, usage: null } : { raw, code: 'ok', sent: true, usage: { inputTokens: 5000, outputTokens: 500 } };
    }),
  };
};

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  interviewRecapsFixture.rows().splice(0);
  interviewRecapOpensFixture.rows().splice(0);
  resetRecapAttempts();
  consent = { transcription: true, milo: true };
  const q = firstQuestion();
  transcript = { callId: 'call-1', lastSeq: 2, lines: [
    { seq: 1, side: 'panel', text: q.prompt },
    { seq: 2, side: 'candidate', text: 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.' },
  ] };
  deps = {
    store: jest.fn(() => store),
    consents: jest.fn(async () => consent),
    transcript: jest.fn(async () => transcript),
    taken: jest.fn(async () => []),
    said: jest.fn(async () => []),
    model: jest.fn(() => new ScriptedRecapModel()),
    reserve: jest.fn(async (i) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `iv:op:${IV}:coach:${i.key}`, amountUsd: i.estimateUsd })),
    settle: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    now: jest.fn(() => Date.UTC(2026, 11, 1, 16, 0)),
    suffix: jest.fn(() => 'abcd'),
  };
  setRecapDeps(deps as unknown as RecapDeps);
});
afterAll(() => setRecapDeps(null));

describe('a question Milo asked aloud (Have Milo ask): its answer is evidence, under its own question', () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 11, 1, 15, 0, sec)).toISOString();
  const slip = () => refOf().opening.kit.questions.find((q) => q.id === 'q-em-slip')!;
  // The lead asked the chosen people-leadership question; the candidate answered; Milo then asked the delivery question (a
  // suggestion, "Have Milo ask"); the candidate asked Milo to repeat it and answered. Milo's voice is no transcript line.
  const lines = () => [
    { seq: 1, side: 'panel' as const, text: firstQuestion().prompt, startAt: at(0) },
    { seq: 2, side: 'candidate' as const, text: 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.', startAt: at(10) },
    { seq: 3, side: 'candidate' as const, text: 'Milo, can you repeat the question?', startAt: at(40) },
    { seq: 4, side: 'candidate' as const, text: 'We cut the scope to the payments flow, told the client on day one and shipped that part on time.', startAt: at(50) },
  ];
  const said = () => [{ text: slip().prompt, saidAt: at(30) }, { text: slip().prompt, saidAt: at(45) }];
  const taken = () => [{ id: 'sug-1', text: slip().prompt, competencyId: slip().competencyId, answer: 'milo-ask' as const }];

  it('the timeline holds Milo\'s question (and its repeat) as panel lines with negative numbers, placed by when the lines began', () => {
    const input = recapInput(refOf(), lines(), taken(), said());
    expect(input.lines.map((l) => [l.seq, l.side])).toEqual([[1, 'panel'], [2, 'candidate'], [-1, 'panel'], [3, 'candidate'], [-2, 'panel'], [4, 'candidate']]);
    expect(input.lines.every((l) => !('startAt' in l))).toBe(true);
  });

  it('the scripted recap puts each answer under its own question: the answers no longer run on across Milo\'s question', async () => {
    transcript = { callId: 'call-1', lastSeq: 4, lines: lines() } as unknown as CoachTranscript;
    deps.taken.mockResolvedValue(taken());
    deps.said.mockResolvedValue(said());
    const body = await openRecap(refOf(), WEN, ratings(3));
    const by = Object.fromEntries(body.competencies.map((c) => [c.id, c.evidence.map((e) => e.source.seq)]));
    expect(by).toEqual({ 'people-leadership': [2], delivery: [4] });
  });

  it('lines without start times place nothing (the questions are left out), and a failing said log is not hidden', async () => {
    const plain = lines().map(({ startAt: _s, ...l }) => l);
    expect(recapInput(refOf(), plain, taken(), said()).lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    deps.said.mockRejectedValue(new Error('said store down'));
    await expect(openRecap(refOf(), WEN, ratings(3))).rejects.toThrow('said store down');
  });

  it('the said log gives only the questions (and repeats) that reached the call: a row never posted was asked of nobody', async () => {
    const log = new MemorySaidStore();
    setSaidStore(log);
    try {
      const row = (id: string, sec: number, over: Partial<SaidRecord>): SaidRecord => ({ id, interviewId: IV, callId: 'call-1', kind: 'question', source: 'suggestion',
        questionId: null, suggestionId: null, text: slip().prompt, askedBy: 'u-wen', saidAt: at(sec), posted: true, spoken: false, ...over });
      await log.append(row('said-1', 30, { spoken: true }));
      await log.append(row('said-2', 35, { posted: false, text: 'Milo was not in the call for this one.' }));
      await log.append(row('said-3', 45, { kind: 'answer', source: 'repeat' }));
      await log.append(row('said-4', 47, { kind: 'answer', source: 'repeat', posted: false }));
      await log.append(row('said-5', 50, { kind: 'answer', source: 'time', text: 'About 5 minutes are left in this round.' }));
      expect(await saidInCall(IV)).toEqual([{ text: slip().prompt, saidAt: at(30) }, { text: slip().prompt, saidAt: at(45) }]);
    } finally {
      setSaidStore(null);
    }
  });
});

describe('the first open', () => {
  it('stores the ratings, then writes the recap once from the scripted stand-in, held and settled at zero', async () => {
    const body = await openRecap(refOf(), WEN, ratings(3));
    const q = firstQuestion();
    expect(body.state).toBe('ready');
    expect(body.competencies).toEqual([{
      id: q.competencyId, name: refOf().opening.kit.competencies.find((c) => c.id === q.competencyId)!.name,
      evidence: [{ text: 'The candidate said this in answer to the question.',
        source: { kind: 'transcript', seq: 2, quote: 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.' } }],
    }]);
    // The round chose one question, so its one competency is the round's: nothing of the round is left uncovered.
    expect(body.notCovered).toEqual([]);
    expect(await ratingsAtRecap(IV, 'u-wen')).toEqual(ratings(3));
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ interviewId: IV, part: 'coach', key: 'recap-1-abcd' }));
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0, provider: 'local' }));
    const row = await store.getRecap(IV);
    expect(row).toMatchObject({ state: 'ready', attempts: 1, droppedCodes: [], modelId: 'scripted-recap', promptVersion: 'recap-2026-11-18.1' });
  });

  it('a later open stores that person\'s ratings, never changes the first, and makes no second call', async () => {
    await openRecap(refOf(), WEN, ratings(3));
    await openRecap(refOf(), WEN, ratings(1));
    await openRecap(refOf(), HUGO, ratings(2));
    expect(await ratingsAtRecap(IV, 'u-wen')).toEqual(ratings(3));
    expect(await ratingsAtRecap(IV, 'u-hugo')).toEqual(ratings(2));
    expect(deps.reserve).toHaveBeenCalledTimes(1);
  });

  it('two opens at once make one call', async () => {
    const [a, b] = await Promise.all([openRecap(refOf(), WEN, ratings()), openRecap(refOf(), HUGO, ratings())]);
    expect(a).toEqual(b);
    expect(deps.reserve).toHaveBeenCalledTimes(1);
  });
});

describe('before any call', () => {
  it('no transcript accepted: no-transcript, nothing read, no hold', async () => {
    consent = { transcription: false, milo: false };
    expect((await openRecap(refOf(), WEN, ratings())).state).toBe('no-transcript');
    expect(deps.transcript).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(await ratingsAtRecap(IV, 'u-wen')).toEqual(ratings());
  });

  it('Milo declined: none, nothing read, no hold', async () => {
    consent = { transcription: true, milo: false };
    expect((await openRecap(refOf(), WEN, ratings())).state).toBe('none');
    expect(deps.transcript).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it('no lines: no-transcript, no hold', async () => {
    transcript = null;
    expect((await openRecap(refOf(), WEN, ratings())).state).toBe('no-transcript');
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it('a refused hold: paused for the budget, no call, nothing stored, the next open tries again', async () => {
    const model = answering('{"competencies":[],"notCovered":[]}');
    deps.model.mockReturnValue(model);
    deps.reserve.mockResolvedValueOnce({ ok: false, refusal: { status: 402, body: {} } });
    expect(await openRecap(refOf(), WEN, ratings())).toMatchObject({ state: 'paused', paused: 'budget' });
    expect(model.write).not.toHaveBeenCalled();
    expect(await store.getRecap(IV)).toBeNull();
    expect((await openRecap(refOf(), HUGO, ratings())).state).toBe('ready');
  });
});

describe('attempts', () => {
  it('a judging answer is dropped by code and the next attempt writes it; the code is kept, not the text', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const judging = JSON.stringify({ competencies: [{ id: firstQuestion().competencyId, evidence: [{ text: 'A strong answer.', seq: 2, quote: 'One engineer kept missing reviews' }] }], notCovered: [] });
    deps.model.mockReturnValue(answering(judging, '{"competencies":[],"notCovered":[]}'));
    expect((await openRecap(refOf(), WEN, ratings())).state).toBe('ready');
    expect(await store.getRecap(IV)).toMatchObject({ attempts: 2, droppedCodes: ['judges'] });
    expect(JSON.stringify(await store.getRecap(IV))).not.toContain('strong');
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ provider: 'bedrock', inputTokens: 5000, outputTokens: 500 }));
    warn.mockRestore();
  });

  it(`stops after ${RECAP_MAX_ATTEMPTS} attempts with a failed row, and readers see none`, async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = answering('not json', 'timeout', 'still not json');
    deps.model.mockReturnValue(model);
    expect((await openRecap(refOf(), WEN, ratings())).state).toBe('none');
    expect(model.write).toHaveBeenCalledTimes(3);
    expect(await store.getRecap(IV)).toMatchObject({ state: 'failed', attempts: 3, droppedCodes: ['malformed', 'timeout', 'malformed'] });
    expect((await openRecap(refOf(), HUGO, ratings())).state).toBe('none');
    expect(model.write).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe('reading', () => {
  it('never writes: none before an open, no-transcript when the transcript was declined, the recap once written', async () => {
    expect((await readRecap(refOf())).state).toBe('none');
    expect(deps.reserve).not.toHaveBeenCalled();
    consent = { transcription: false, milo: false };
    expect((await readRecap(refOf())).state).toBe('no-transcript');
    consent = { transcription: true, milo: true };
    await openRecap(refOf(), WEN, ratings());
    expect((await readRecap(refOf())).state).toBe('ready');
  });
});

describe('the ratings an open takes', () => {
  it('every competency of the kit once, 1 to 4, put in the kit\'s order', () => {
    const ref = refOf();
    expect(checkOpenRatings({ ratings: [...ratings(2)].reverse() }, ref.opening)).toEqual(ratings(2));
    expect(checkOpenRatings({ ratings: ratings(2).slice(1) }, ref.opening)).toBeNull();
    expect(checkOpenRatings({ ratings: [...ratings(2), ratings(2)[0]] }, ref.opening)).toBeNull();
    expect(checkOpenRatings({ ratings: ratings(2).map((r, n) => (n ? r : { ...r, rating: 5 })) }, ref.opening)).toBeNull();
    expect(checkOpenRatings({ ratings: [...ratings(2).slice(1), { competencyId: 'charisma', rating: 2 }] }, ref.opening)).toBeNull();
    expect(checkOpenRatings({}, ref.opening)).toBeNull();
  });
});

// Hardening H4 (O-146): the four cases the first pass left open.
describe('erase, then open', () => {
  it('after the record is erased the recap is gone for every reader, and an open with no words left writes nothing', async () => {
    await openRecap(refOf(), WEN, ratings());
    expect((await readRecap(refOf())).state).toBe('ready');
    expect(await eraseRecapRows([IV])).toBeGreaterThan(0);
    expect((await readRecap(refOf())).state).toBe('none');
    expect(await ratingsAtRecap(IV, 'u-wen')).toBeNull();
    transcript = null; // the transcript went with the record
    const reopened = await openRecap(refOf(), WEN, ratings(2));
    expect(reopened.state).toBe('no-transcript');
    expect(await store.getRecap(IV)).toBeNull();
    expect(await ratingsAtRecap(IV, 'u-wen')).toEqual(ratings(2)); // a new open is the first open again
  });

  it('erasing forgets the attempt count too, so an erased interview is not left half-spent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = answering('not json');
    deps.model.mockReturnValue(model);
    await openRecap(refOf(), WEN, ratings()); // three dropped attempts: a failed row
    expect(model.write).toHaveBeenCalledTimes(RECAP_MAX_ATTEMPTS);
    await eraseRecapRows([IV]);
    expect((await readRecap(refOf())).state).toBe('none');
    await openRecap(refOf(), WEN, ratings());
    expect(model.write).toHaveBeenCalledTimes(RECAP_MAX_ATTEMPTS * 2);
    warn.mockRestore();
  });
});

describe('the attempt counter across a restart', () => {
  it('a failed row survives a restart, so readers still see none and no new call is made', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = answering('not json');
    deps.model.mockReturnValue(model);
    await openRecap(refOf(), WEN, ratings());
    resetRecapAttempts(); // a restart: the in-memory counts are gone, the store's rows are not
    expect((await openRecap(refOf(), HUGO, ratings())).state).toBe('none');
    expect(model.write).toHaveBeenCalledTimes(RECAP_MAX_ATTEMPTS);
    warn.mockRestore();
  });

  it('at most 3 model calls per interview, ever: the count is the store\'s, so a restart after two failures allows one more', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = answering('not json');
    deps.model.mockReturnValue(model);
    // Two attempts fail, then the hold is refused on the third: no row is written, the count stands at two.
    deps.reserve.mockImplementationOnce(async (i) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `s-${i.key}`, amountUsd: i.estimateUsd }))
      .mockImplementationOnce(async (i) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `s-${i.key}`, amountUsd: i.estimateUsd }))
      .mockResolvedValueOnce({ ok: false, refusal: { status: 402, body: {} } });
    expect((await openRecap(refOf(), WEN, ratings())).state).toBe('paused');
    expect(model.write).toHaveBeenCalledTimes(2);
    expect((await store.listAttempts(IV)).map((a) => [a.attempt, a.code])).toEqual([[1, 'malformed'], [2, 'malformed']]);
    resetRecapAttempts(); // a restart: nothing this process held in memory is left
    expect((await openRecap(refOf(), HUGO, ratings())).state).toBe('none');
    expect(model.write).toHaveBeenCalledTimes(RECAP_MAX_ATTEMPTS);
    const row = await store.getRecap(IV);
    expect([row?.state, row?.attempts, row?.droppedCodes]).toEqual(['failed', 3, ['malformed', 'malformed', 'malformed']]);
    expect(await store.listAttempts(IV)).toEqual([]); // the row holds them now
    warn.mockRestore();
  });

  it('an attempt cut off by a restart (claimed, never given a code) still counts', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.putAttempt({ interviewId: IV, attempt: 1, code: null, madeAt: new Date(0).toISOString() });
    const model = answering('not json');
    deps.model.mockReturnValue(model);
    await openRecap(refOf(), WEN, ratings());
    expect(model.write).toHaveBeenCalledTimes(RECAP_MAX_ATTEMPTS - 1);
    warn.mockRestore();
  });

  it('an attempt another open claimed first is not made again: its hold is released and no call is sent for it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const claim = jest.spyOn(store, 'putAttempt').mockResolvedValueOnce(false);
    const model = answering('not json');
    deps.model.mockReturnValue(model);
    await openRecap(refOf(), WEN, ratings());
    expect(model.write).toHaveBeenCalledTimes(RECAP_MAX_ATTEMPTS - 1);
    expect(deps.release).toHaveBeenCalledWith(['h-recap-1-abcd']);
    claim.mockRestore();
    warn.mockRestore();
  });
});

describe('more than 400 lines', () => {
  const longTranscript = (n: number): CoachTranscript => ({ callId: 'call-1', lastSeq: n, lines: Array.from({ length: n }, (_, i) => ({
    seq: i + 1, side: i % 2 === 0 ? 'panel' as const : 'candidate' as const, text: i % 2 === 0 ? `Question ${i + 1}?` : `Answer ${i + 1}, I set up a weekly one-to-one.`,
  })) });

  it('the model is given the newest 400 lines, in order, and none of the older ones', async () => {
    transcript = longTranscript(450);
    const model = answering('{"competencies":[],"notCovered":[]}');
    deps.model.mockReturnValue(model);
    await openRecap(refOf(), WEN, ratings());
    const given = (model.write as jest.Mock).mock.calls[0]![0] as RecapInput;
    expect(given.lines).toHaveLength(RECAP_MAX_LINES);
    expect(given.lines[0]!.seq).toBe(51);
    expect(given.lines.at(-1)!.seq).toBe(450);
  });

  it('a statement that cites a line cut from the request is dropped, not trusted', async () => {
    transcript = longTranscript(450);
    const cid = firstQuestion().competencyId;
    const cites = (seq: number) => JSON.stringify({ competencies: [{ id: cid, evidence: [{ text: 'The candidate described a weekly one-to-one.', seq, quote: `Answer ${seq}, I set up a weekly one-to-one.` }] }], notCovered: [] });
    deps.model.mockReturnValue(answering(cites(10)));
    await openRecap(refOf(), WEN, ratings());
    expect(await store.getRecap(IV)).toMatchObject({ state: 'ready', droppedClaims: 1, content: { competencies: [] } });
    await store.eraseRecaps([IV]);
    resetRecapAttempts();
    deps.model.mockReturnValue(answering(cites(450)));
    await openRecap(refOf(), WEN, ratings());
    expect(await store.getRecap(IV)).toMatchObject({ droppedClaims: 0, content: { competencies: [{ id: cid }] } });
  });

  it('blank lines are not counted toward the 400, and a short transcript is read whole', () => {
    const lines = [...longTranscript(300).lines, { seq: 301, side: 'candidate' as const, text: '   ' }];
    expect(recapInput(refOf(), lines, []).lines).toHaveLength(300);
    expect(recapInput(refOf(), longTranscript(450).lines, []).lines).toHaveLength(RECAP_MAX_LINES);
  });
});

describe('the kit gained a competency after the recap was written', () => {
  const plusOne = (ref: RecapRef): RecapRef => ({
    ...ref, opening: { ...ref.opening, kit: { ...ref.opening.kit, competencies: [...ref.opening.kit.competencies, { ...ref.opening.kit.competencies[0]!, id: 'added-later', name: 'Added later' }] } },
  });

  it('the stored recap reads as before; the new competency is not the round\'s, so it is not listed as not covered', async () => {
    await openRecap(refOf(), WEN, ratings());
    const before = await readRecap(refOf());
    const after = await readRecap(plusOne(refOf()));
    expect(after.state).toBe('ready');
    expect(after.competencies).toEqual(before.competencies);
    expect(after.notCovered).toEqual(before.notCovered);
    expect(after.notCovered.some((c) => c.id === 'added-later')).toBe(false);
  });

  it('a later open must rate the new competency too; the first person\'s stored ratings stand as they were', async () => {
    await openRecap(refOf(), WEN, ratings(3));
    expect(checkOpenRatings({ ratings: ratings(3) }, plusOne(refOf()).opening)).toBeNull();
    expect(checkOpenRatings({ ratings: [...ratings(3), { competencyId: 'added-later', rating: 3 }] }, plusOne(refOf()).opening)).toHaveLength(ratings(3).length + 1);
    expect(await ratingsAtRecap(IV, 'u-wen')).toEqual(ratings(3));
  });
});
