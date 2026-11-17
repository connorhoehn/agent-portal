// Reading Milo's private answer (lib/interviews/milo-notes/parse.ts; decisions 6 and 8, row I3.6).
import { parseAskAnswer, sentenceCount } from '../parse.js';
import { NOT_SAID } from '../prompt.js';
import { FIXED_ASK } from './fixed-input.js';

const lines = FIXED_ASK.lines;
const j = (o: unknown) => JSON.stringify(o);
const ok = { answer: 'They paged the on-call lead (line 2).', sources: [{ seq: 2, quote: 'I paged the on-call lead' }] };

describe('parseAskAnswer', () => {
  it('reads a sourced answer, and the one not-said answer with no sources', () => {
    expect(parseAskAnswer(j(ok), lines)).toEqual({ ok: true, value: ok });
    expect(parseAskAnswer('Here you go: ' + j(ok), lines)).toEqual({ ok: true, value: ok });
    expect(parseAskAnswer(j({ answer: 'the transcript does not say.', sources: [] }), lines)).toEqual({ ok: true, value: { answer: NOT_SAID, sources: [] } });
  });

  it.each([
    ['not JSON', 'They paged the lead.'],
    ['null', null],
    ['an extra key', j({ ...ok, confidence: 0.9 })],
    ['a missing key', j({ answer: ok.answer })],
    ['sources not a list', j({ answer: ok.answer, sources: 'line 2' })],
    ['a source with a third key', j({ answer: ok.answer, sources: [{ seq: 2, quote: 'I paged', speaker: 'x' }] })],
    ['a source seq that is not a whole number', j({ answer: ok.answer, sources: [{ seq: '2', quote: 'I paged' }] })],
    ['an empty answer', j({ answer: '  ', sources: [] })],
  ])('drops %s as malformed', (_l, raw) => {
    expect(parseAskAnswer(raw as string | null, lines)).toEqual({ ok: false, code: 'malformed' });
  });

  it.each([
    ['four sentences', j({ ...ok, answer: 'One. Two. Three. Four.' })],
    ['more than three sources', j({ ...ok, sources: [1, 2, 3, 2].map((seq) => ({ seq, quote: 'the' })) })],
    ['an answer over the cap', j({ ...ok, answer: 'x'.repeat(601) })],
    ['a quote over the cap', j({ ...ok, sources: [{ seq: 2, quote: 'q'.repeat(301) }] })],
  ])('drops %s as too long', (_l, raw) => {
    expect(parseAskAnswer(raw, lines)).toEqual({ ok: false, code: 'too-long' });
  });

  it.each([
    ['a quote not in its line', j({ ...ok, sources: [{ seq: 3, quote: 'I paged the on-call lead' }] })],
    ['a line that was not given', j({ ...ok, sources: [{ seq: 9, quote: 'I paged the on-call lead' }] })],
    ['an invented quote', j({ ...ok, sources: [{ seq: 2, quote: 'I called the CEO' }] })],
    ['an answer with no source', j({ ...ok, sources: [] })],
    ['not-said with a source', j({ answer: NOT_SAID, sources: ok.sources })],
  ])('drops %s as unsourced', (_l, raw) => {
    expect(parseAskAnswer(raw, lines)).toEqual({ ok: false, code: 'unsourced' });
  });

  it.each([
    ['judges', 'That was a strong answer: they paged the on-call lead.'],
    ['judges', 'I would recommend her; she paged the on-call lead.'],
    ['personal', 'She sounded nervous when she paged the on-call lead.'],
    ['personal', 'Her accent made it hard to follow, but she paged the lead.'],
  ])('drops an answer that %s', (code, answer) => {
    expect(parseAskAnswer(j({ ...ok, answer }), lines)).toEqual({ ok: false, code });
  });

  it('counts sentences by their ending marks', () => {
    expect(sentenceCount('One. Two? Three!')).toBe(3);
    expect(sentenceCount('No mark at all')).toBe(1);
    expect(sentenceCount('')).toBe(0);
  });
});
