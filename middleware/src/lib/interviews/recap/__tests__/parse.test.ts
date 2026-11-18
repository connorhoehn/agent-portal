// The recap's bar (lib/interviews/recap/parse.ts; row I5.2): every claim has a source, and a rating or a recommendation in
// the output is rejected.
import { guardRecapText, parseRecapAnswer, SAME_ANSWER_TEXT, withoutQuote } from '../parse.js';
import { FIXED_INPUT } from './fixed-input.js';

const ctx = { competencyIds: ['communication', 'collaboration'], lines: FIXED_INPUT.lines };
const claim = (text: string, seq: number, quote: string) => ({ text, seq, quote });
const answer = (competencies: unknown[], notCovered: string[] = []) => JSON.stringify({ competencies, notCovered });
const GOOD = claim('The candidate described paging the on-call lead.', 2, 'I paged the on-call lead');

describe('every claim has a source', () => {
  it('keeps a claim whose quote is in the candidate line it names', () => {
    const out = parseRecapAnswer(answer([{ id: 'communication', evidence: [GOOD] }], ['collaboration']), ctx);
    expect(out).toEqual({ ok: true, droppedClaims: 0, recap: { competencies: [{ id: 'communication', evidence: [GOOD] }], notCovered: ['collaboration'] } });
  });

  it.each([
    ['a seq that is not a given line', claim('The candidate described paging.', 9, 'I paged the on-call lead')],
    ['a quote that is not in its line', claim('The candidate described paging.', 4, 'I paged the on-call lead')],
    ['a quote said nowhere', claim('The candidate described a rollback.', 2, 'we rolled the release back')],
    ['a panel line as the source', claim('The candidate was asked what happened first.', 1, 'What happened first')],
    ['an empty quote', claim('The candidate described paging.', 2, '')],
    ['a quote about a personal trait', claim('The candidate described the evening.', 2, 'I paged the on-call lead')],
  ])('drops a claim with %s, and an emptied competency moves to not covered', (name, bad) => {
    const lines = name === 'a quote about a personal trait'
      ? [...FIXED_INPUT.lines.slice(0, 1), { seq: 2, side: 'candidate' as const, text: 'I paged the on-call lead while my wife was in hospital.' }]
      : FIXED_INPUT.lines;
    const quoted = name === 'a quote about a personal trait' ? { ...bad, quote: 'while my wife was in hospital' } : bad;
    const out = parseRecapAnswer(answer([{ id: 'communication', evidence: [quoted] }]), { ...ctx, lines });
    expect(out).toEqual({ ok: true, droppedClaims: 1, recap: { competencies: [], notCovered: ['communication', 'collaboration'] } });
  });

  it('drops a competency that is not in the kit, with its claims', () => {
    const out = parseRecapAnswer(answer([{ id: 'charisma', evidence: [GOOD] }, { id: 'communication', evidence: [GOOD] }]), ctx);
    expect(out.ok && out.recap.competencies.map((c) => c.id)).toEqual(['communication']);
    expect(out.ok && out.droppedClaims).toBe(1);
  });

  it('keeps at most four claims per competency and puts the kit\'s order back', () => {
    // Six different statements, each resting on line 2 (a repeat would be collapsed, not capped).
    const many = ['The candidate described paging the on-call lead.', 'The candidate said the payments queue backed up.', 'The candidate described the queue backing up.',
      'The candidate said they split the work.', 'The candidate named the on-call lead.', 'The candidate described splitting the work with the lead.']
      .map((t) => claim(t, 2, 'I paged the on-call lead'));
    const out = parseRecapAnswer(answer([
      { id: 'collaboration', evidence: [claim('The candidate named the database owner.', 4, 'The database owner')] },
      { id: 'communication', evidence: many },
    ]), ctx);
    expect(out.ok && out.recap.competencies.map((c) => [c.id, c.evidence.length])).toEqual([['communication', 4], ['collaboration', 1]]);
    expect(out.ok && out.droppedClaims).toBe(2);
  });
});

describe('a rating or a recommendation in the output is rejected', () => {
  it.each([
    'The candidate gave a strong answer about paging.',
    'The candidate would rate a 3 on communication.',
    'Communication: 3 out of 4.',
    'The candidate meets the bar for paging.',
    'Recommend hire.',
    'The candidate is a strong hire.',
    'A good description of paging.',
    'He paged the on-call lead.',
    'The candidate seemed unsure about paging.',
    'The candidate answered better than most.',
    'The candidate sounded nervous when paging.',
  ])('rejects the WHOLE recap when one claim says: %s', (text) => {
    const out = parseRecapAnswer(answer([
      { id: 'communication', evidence: [GOOD, claim(text, 2, 'I paged the on-call lead')] },
      { id: 'collaboration', evidence: [claim('The candidate named the database owner.', 4, 'The database owner')] },
    ]), ctx);
    expect(out.ok).toBe(false);
    expect(out.ok ? null : ['judges', 'personal']).toContainEqual(out.ok ? null : out.code);
  });

  it('rejects even when the judging claim would have been dropped for its source', () => {
    expect(parseRecapAnswer(answer([{ id: 'communication', evidence: [claim('An excellent answer.', 99, 'nothing')] }]), ctx)).toEqual({ ok: false, code: 'judges' });
  });

  it('guards Milo\'s words, not the candidate\'s own quoted words', () => {
    const lines = [{ seq: 1, side: 'candidate' as const, text: 'I recommended we roll back, which was the best call.' }];
    const text = 'The candidate said: “I recommended we roll back, which was the best call”';
    expect(withoutQuote(text, 'I recommended we roll back, which was the best call')).not.toMatch(/recommend/);
    const out = parseRecapAnswer(answer([{ id: 'communication', evidence: [claim(text, 1, 'I recommended we roll back, which was the best call')] }]), { ...ctx, lines });
    expect(out.ok).toBe(true);
  });

  it('lets the work through: a rate limiter, an error rate, strong consistency, a bad request', () => {
    for (const t of ['The candidate described a rate limiter with a refill rate.', 'The candidate chose strong consistency for the ledger.',
      'The candidate returned a bad request for a missing key.', 'The candidate described the error rate after the deploy.']) {
      expect([t, guardRecapText(t)]).toEqual([t, null]);
    }
  });
});

describe('strict JSON', () => {
  it.each([
    ['not JSON', 'The candidate did well.'],
    ['an extra key', JSON.stringify({ competencies: [], notCovered: [], score: 3 })],
    ['a missing key', JSON.stringify({ competencies: [] })],
    ['a claim with an extra key', answer([{ id: 'communication', evidence: [{ ...GOOD, rating: 3 }] }])],
    ['a seq that is not a number', answer([{ id: 'communication', evidence: [{ ...GOOD, seq: '2' }] }])],
    ['nothing', null],
  ])('drops %s whole', (_n, raw) => {
    expect(parseRecapAnswer(raw, ctx)).toEqual({ ok: false, code: 'malformed' });
  });
});

// Hardening H4 (O-147): the five limits the guard once could not catch, each now closed (parse.ts's header says how). Each
// was a pair, a plain test pinning what got through and an `it.failing` stating what decision 6 wants; the fix replaced
// each pair with the one plain test below.
describe('the guard\'s limits, closed', () => {
  const LINES = [
    { seq: 1, side: 'panel' as const, text: 'Tell me about an incident you led.' },
    { seq: 2, side: 'candidate' as const, text: 'I paged the on-call lead and we split the work.' },
    { seq: 3, side: 'candidate' as const, text: 'I did not write a test for the fix before we shipped it.' },
    { seq: 4, side: 'candidate' as const, text: 'Yo hablé con el equipo de pagos.' },
  ];
  const lctx = { competencyIds: ['communication', 'collaboration'], lines: LINES };
  const PAGING = claim('The candidate described paging the on-call lead.', 2, 'I paged the on-call lead');
  const run = (competencies: unknown[]) => parseRecapAnswer(answer(competencies), lctx);

  it('a judgement in other words is rejected: "covered every case the kit lists" is a completeness verdict', () => {
    const PARAPHRASE = claim('The candidate covered every case the kit lists for incidents.', 2, 'I paged the on-call lead');
    expect(guardRecapText(PARAPHRASE.text)).toBe('judges');
    expect(run([{ id: 'communication', evidence: [PARAPHRASE] }])).toEqual({ ok: false, code: 'judges' });
  });

  it('a slant carried by which statements were chosen is caught: the rest of a cited answer is shown beside it, in the candidate\'s own words', () => {
    const out = run([{ id: 'communication', evidence: [PAGING] }]);
    expect(out.ok && out.recap.competencies[0]!.evidence.some((e) => e.seq === 3)).toBe(true);
    expect(out).toEqual({ ok: true, droppedClaims: 0, recap: { competencies: [{ id: 'communication', evidence: [
      PAGING,
      { text: SAME_ANSWER_TEXT, seq: 3, quote: 'I did not write a test for the fix before we shipped it.' },
      { text: SAME_ANSWER_TEXT, seq: 4, quote: 'Yo hablé con el equipo de pagos.' },
    ] }], notCovered: ['collaboration'] } });
  });

  it('emphasis by repetition is collapsed: one line cited with one statement shows once, and the repeats are counted as dropped', () => {
    const out = run([{ id: 'communication', evidence: [PAGING, PAGING, PAGING] }]);
    expect(out.ok && out.recap.competencies[0]!.evidence.filter((e) => e.seq === 2)).toHaveLength(1);
    expect(out.ok && out.droppedClaims).toBe(2);
  });

  it('a paraphrase that drifts from its quote is dropped: the statement claims more than the line it cites says', () => {
    const DRIFT = claim('The candidate took ownership of the whole incident and led the response.', 2, 'I paged the on-call lead');
    const out = run([{ id: 'communication', evidence: [DRIFT] }]);
    expect(out.ok && out.droppedClaims).toBe(1);
    expect(out.ok && out.recap.competencies).toEqual([]);
  });

  it('a verdict in another language is rejected: "excelente y muy convincente"; the candidate\'s own quote may still be in any language', () => {
    const SPANISH = claim('El candidato dio una respuesta excelente y muy convincente.', 4, 'Yo hablé con el equipo de pagos');
    expect(run([{ id: 'collaboration', evidence: [SPANISH] }])).toEqual({ ok: false, code: 'judges' });
    const quoted = claim('The candidate said: “Yo hablé con el equipo de pagos”', 4, 'Yo hablé con el equipo de pagos');
    expect(run([{ id: 'collaboration', evidence: [quoted] }])).toMatchObject({ ok: true, droppedClaims: 0 });
  });

  it('what the guard DOES still stop on the same transcript: a listed verdict word, a pronoun, and a panel line as a source', () => {
    expect(run([{ id: 'communication', evidence: [claim('An excellent answer about paging.', 2, 'I paged the on-call lead')] }])).toEqual({ ok: false, code: 'judges' });
    expect(run([{ id: 'communication', evidence: [claim('She paged the on-call lead.', 2, 'I paged the on-call lead')] }])).toEqual({ ok: false, code: 'judges' });
    expect(run([{ id: 'communication', evidence: [claim('The candidate was asked about an incident.', 1, 'an incident you led')] }]))
      .toEqual({ ok: true, droppedClaims: 1, recap: { competencies: [], notCovered: ['communication', 'collaboration'] } });
  });
});

describe('a question Milo said aloud ends an answer, and a request to Milo is no evidence', () => {
  // The timeline service.ts `withMiloQuestions` builds: Milo's question is a panel line with a negative number.
  const lines = [
    { seq: 1, side: 'panel' as const, text: 'Tell me about the outage.' },
    { seq: 2, side: 'candidate' as const, text: 'I paged the on-call lead and we rolled back.' },
    { seq: -1, side: 'panel' as const, text: 'How did you tell the customers?' },
    { seq: 3, side: 'candidate' as const, text: 'Milo, can you repeat the question?' },
    { seq: 4, side: 'candidate' as const, text: 'We posted on the status page within ten minutes.' },
  ];
  const lctx = { competencyIds: ['communication', 'collaboration'], lines };
  it('the rest of a cited answer stops at Milo\'s question: the line after it is not added to the earlier answer', () => {
    const out = parseRecapAnswer(answer([{ id: 'collaboration', evidence: [claim('The candidate described paging the on-call lead.', 2, 'I paged the on-call lead')] }]), lctx);
    expect(out.ok && out.recap.competencies).toEqual([{ id: 'collaboration', evidence: [expect.objectContaining({ seq: 2 })] }]);
  });
  it('a claim citing the candidate\'s request to Milo is dropped, and the request is never added as the same answer', () => {
    const out = parseRecapAnswer(answer([{ id: 'communication', evidence: [
      claim('The candidate asked for the question again.', 3, 'can you repeat the question'),
      claim('The candidate described posting on the status page.', 4, 'We posted on the status page'),
    ] }]), lctx);
    expect(out.ok && out.recap.competencies).toEqual([{ id: 'communication', evidence: [expect.objectContaining({ seq: 4 })] }]);
    expect(out.ok && out.droppedClaims).toBe(1);
  });
});
