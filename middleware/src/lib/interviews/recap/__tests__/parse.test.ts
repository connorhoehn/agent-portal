// The recap's bar (lib/interviews/recap/parse.ts; row I5.2): every claim has a source, and a rating or a recommendation in
// the output is rejected.
import { guardRecapText, parseRecapAnswer, withoutQuote } from '../parse.js';
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
    const many = Array.from({ length: 6 }, () => GOOD);
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

// Hardening H4 (O-147): what the guard cannot catch, pinned as the guard behaves TODAY on a fixed transcript, so a change
// to it shows in review. Each limit has two tests: a plain one that pins what gets through (the recap is kept whole), and
// an `it.failing` that states what decision 6 (Milo never scores, never slants) would want. When a limit is closed the
// failing test starts passing, jest reports it, and the pair is replaced by one plain test. The guard itself is not changed.
describe('the guard\'s limits (what it cannot catch, said plainly in parse.ts)', () => {
  const LINES = [
    { seq: 1, side: 'panel' as const, text: 'Tell me about an incident you led.' },
    { seq: 2, side: 'candidate' as const, text: 'I paged the on-call lead and we split the work.' },
    { seq: 3, side: 'candidate' as const, text: 'I did not write a test for the fix before we shipped it.' },
    { seq: 4, side: 'candidate' as const, text: 'Yo hablé con el equipo de pagos.' },
  ];
  const lctx = { competencyIds: ['communication', 'collaboration'], lines: LINES };
  const PAGING = claim('The candidate described paging the on-call lead.', 2, 'I paged the on-call lead');
  const run = (competencies: unknown[]) => parseRecapAnswer(answer(competencies), lctx);
  const kept = (out: ReturnType<typeof parseRecapAnswer>) => out.ok && out.droppedClaims === 0 && out.recap.competencies.length > 0;

  describe('a judgement in other words', () => {
    const PARAPHRASE = claim('The candidate covered every case the kit lists for incidents.', 2, 'I paged the on-call lead');
    it('gets through: a verdict that uses none of the listed words is kept, beside its quote', () => {
      expect(guardRecapText(PARAPHRASE.text)).toBeNull();
      expect(kept(run([{ id: 'communication', evidence: [PARAPHRASE] }]))).toBe(true);
    });
    it.failing('should be rejected: "covered every case the kit lists" is a completeness verdict', () => {
      expect(run([{ id: 'communication', evidence: [PARAPHRASE] }])).toEqual({ ok: false, code: 'judges' });
    });
  });

  describe('a slant carried by which statements were chosen', () => {
    it('gets through: only the line that sounds best is cited, and the line that sounds worst is simply not there', () => {
      const out = run([{ id: 'communication', evidence: [PAGING] }]);
      expect(out).toEqual({ ok: true, droppedClaims: 0, recap: { competencies: [{ id: 'communication', evidence: [PAGING] }], notCovered: ['collaboration'] } });
      // Line 3 is on the transcript and bears on the competency; nothing in the output says it was left out.
      expect(JSON.stringify(out)).not.toMatch(/did not write a test/);
    });
    it.failing('should be caught: a recap that skips a candidate line the kit asks about is not a fair reading', () => {
      const out = run([{ id: 'communication', evidence: [PAGING] }]);
      expect(out.ok && out.recap.competencies[0]!.evidence.some((e) => e.seq === 3)).toBe(true);
    });
  });

  describe('emphasis by repetition', () => {
    it('gets through: the same statement said four times is four statements (the cap of four per competency is the only limit)', () => {
      const out = run([{ id: 'communication', evidence: [PAGING, PAGING, PAGING, PAGING, PAGING] }]);
      expect(out.ok && out.recap.competencies[0]!.evidence).toHaveLength(4);
      expect(out.ok && out.droppedClaims).toBe(1);
    });
    it.failing('should be collapsed: one line cited with one statement shows once', () => {
      const out = run([{ id: 'communication', evidence: [PAGING, PAGING, PAGING] }]);
      expect(out.ok && out.recap.competencies[0]!.evidence).toHaveLength(1);
    });
  });

  describe('a paraphrase that drifts from its quote while still citing it', () => {
    const DRIFT = claim('The candidate took ownership of the whole incident and led the response.', 2, 'I paged the on-call lead');
    it('gets through: the quote is in the line it names, so the source check passes however far the statement goes', () => {
      expect(kept(run([{ id: 'communication', evidence: [DRIFT] }]))).toBe(true);
    });
    it.failing('should be dropped: the statement claims more than the line it cites says', () => {
      const out = run([{ id: 'communication', evidence: [DRIFT] }]);
      expect(out.ok && out.droppedClaims).toBe(1);
    });
  });

  describe('not English', () => {
    const SPANISH = claim('El candidato dio una respuesta excelente y muy convincente.', 4, 'Yo hablé con el equipo de pagos');
    it('gets through: the listed words are English, so a verdict in another language is kept; the candidate\'s own quote may be in any language', () => {
      expect(guardRecapText(SPANISH.text)).toBeNull();
      expect(kept(run([{ id: 'collaboration', evidence: [SPANISH] }]))).toBe(true);
    });
    it.failing('should be rejected: "excelente y muy convincente" is a verdict', () => {
      expect(run([{ id: 'collaboration', evidence: [SPANISH] }])).toEqual({ ok: false, code: 'judges' });
    });
  });

  it('what the guard DOES still stop on the same transcript: a listed verdict word, a pronoun, and a panel line as a source', () => {
    expect(run([{ id: 'communication', evidence: [claim('An excellent answer about paging.', 2, 'I paged the on-call lead')] }])).toEqual({ ok: false, code: 'judges' });
    expect(run([{ id: 'communication', evidence: [claim('She paged the on-call lead.', 2, 'I paged the on-call lead')] }])).toEqual({ ok: false, code: 'judges' });
    expect(run([{ id: 'communication', evidence: [claim('The candidate was asked about an incident.', 1, 'an incident you led')] }]))
      .toEqual({ ok: true, droppedClaims: 1, recap: { competencies: [], notCovered: ['communication', 'collaboration'] } });
  });
});
