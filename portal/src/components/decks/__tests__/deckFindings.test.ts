import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckSlideFindings, findingsSummary, groupDeckWarnings, slideRange, withPlaceholderSources, UNSOURCED_SOURCE } from '../deckFindings.ts';
import type { DeckSpec } from '../deckApi.ts';

// The fresh status-update template's fourteen sentences, as the server answers them.
const TEMPLATE = [
  ...[2, 3, 4, 5, 6, 7].map(n => `Slide ${n} (s${n}) has no speaker notes.`),
  'Every slide cites the same source (Example content from the Status update template).',
  ...[1, 2, 3, 4, 5, 6, 7].map(n => `Slide ${n} (s${n}) cites only the template's example source; replace it with the document it draws from.`),
];

test('a fresh template is one line: seven example sources count, speaker notes are advice', () => {
  const f = groupDeckWarnings(TEMPLATE);
  assert.equal(f.count, 7);
  assert.deepEqual(f.groups.map(g => [g.label, g.slides, g.counts]), [
    ['Example sources', [1, 2, 3, 4, 5, 6, 7], true],
    ['No speaker notes', [2, 3, 4, 5, 6, 7], false],
  ]);
  assert.deepEqual(findingsSummary(f, 7), { title: '7 things to check before sharing', hint: 'Example sources (every slide)', tone: 'warning' });
  assert.equal(slideRange(f.groups[1]!.slides, 7), 'slides 2 to 7');
});

test('overflow and unfinished slides come first and are marked on their slides', () => {
  const f = groupDeckWarnings([
    'Slide 4 (s-1) is unfinished: it needs a title.',
    'Slide 5 (s-2) body: 9 lines need 7.2in, the region has 4.8in',
    'Slide 5 (s-2) has a bullet of 160 characters — it will read as a paragraph.',
    'Slide 5 (s-2) has no speaker notes.',
  ]);
  assert.deepEqual(f.groups.map(g => g.kind), ['overflow', 'unfinished', 'notes', 'advice']);
  assert.equal(f.count, 2);
  assert.deepEqual(new Set(f.bySlide.get(5)), new Set(['overflow', 'advice', 'notes']));
  assert.equal(findingsSummary(f, 8)!.hint, 'Overflow (slide 5) · Unfinished (slide 4)');
});

test('only advice is a neutral line with nothing counted', () => {
  const s = findingsSummary(groupDeckWarnings(['Slide 2 (a) has no speaker notes.', 'Slide 3 (b) has no speaker notes.']), 3)!;
  assert.equal(s.tone, 'neutral');
  assert.equal(s.hint, 'No speaker notes (slides 2 and 3)');
  assert.equal(findingsSummary(groupDeckWarnings([])), null);
});

test('a slide added in the editor cites the placeholder; slides already there keep what they had', () => {
  const src = [{ documentId: 'doc-1', title: 'Doc' }];
  const prev = { title: 'T', slides: [{ id: 'a', layout: 'title', title: 'A', sources: src }, { id: 'b', layout: 'bullets', title: 'B', bullets: ['x'], sources: [] }] } as unknown as DeckSpec;
  const next = { ...prev, slides: [...prev.slides, { id: 's3', layout: 'table', title: '', sources: [] }] } as unknown as DeckSpec;
  const out = withPlaceholderSources(prev, next);
  assert.deepEqual(out.slides[2]!.sources, [UNSOURCED_SOURCE]);
  assert.deepEqual(out.slides[1]!.sources, []);
  assert.equal(withPlaceholderSources(prev, prev), prev);
  assert.equal(UNSOURCED_SOURCE.documentId, 'example:unsourced');
});

test('each slide is marked by id: overflow and unfinished as warnings, example sources as info, notes and advice left out', () => {
  const spec = { slides: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } as unknown as DeckSpec;
  const marks = deckSlideFindings([
    'Slide 1 (a) cites only the template\'s example source; replace it with the document it draws from.',
    'Slide 2 (b) body: 9 lines need 7.2in, the region has 4.8in',
    'Slide 2 (b) is unfinished: it needs a title.',
    'Slide 3 (c) has no speaker notes.',
    'Slide 9 (z) body: 9 lines need 7.2in, the region has 4.8in',
  ], spec);
  assert.deepEqual(marks, {
    a: [{ tone: 'info', label: 'Example sources' }],
    b: [{ tone: 'warning', label: 'Overflow' }, { tone: 'warning', label: 'Unfinished' }],
  });
});
