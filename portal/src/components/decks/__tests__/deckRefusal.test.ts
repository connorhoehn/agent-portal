// A deck the format refuses is said plainly ("Slide 2 needs a title."), never as the validator's path, and a slide
// added in the editor starts with its layout's placeholder title so the deck stays saveable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckCall, DeckApiError, type DeckSpec } from '../deckApi.ts';
import { draftRefusal, plainDeckError, plainDeckRefusal, withPlaceholderTitles } from '../deckRefusal.ts';

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('a validator line becomes a sentence naming the slide and the field', () => {
  assert.equal(plainDeckError('slides[1].title: required'), 'Slide 2 needs a title.');
  assert.equal(plainDeckError('slides[0].sources: every slide must cite at least one source document'), 'Slide 1 needs a source.');
  assert.equal(plainDeckError('slides[3].title: longer than 120 characters'), 'Slide 4: the title is longer than 120 characters.');
  assert.equal(plainDeckError('slides[2].timeline[0].label: required'), 'Slide 3 needs a timeline step 1 label.');
  assert.equal(plainDeckError('title: required'), null);
});

test('the raw "invalid DeckSpec: …" message never reaches the page', () => {
  assert.equal(plainDeckRefusal('invalid DeckSpec: slides[1].title: required'), 'Slide 2 needs a title.');
  assert.equal(plainDeckRefusal('invalid DeckSpec', ['slides[1].title: required', 'slides[1].title: required', 'slides[4].sources: no usable source survived validation']),
    'Slide 2 needs a title. Slide 5 needs a source.');
  assert.equal(plainDeckRefusal('operation 2 (set_fields): invalid DeckSpec: slides[0].eyebrow: longer than 60 characters'), 'Slide 1: the eyebrow is longer than 60 characters.');
  // Not a validator line: the server's own sentence stays.
  assert.equal(plainDeckRefusal('operation 5 (set_title): no slide nope in this deck'), 'operation 5 (set_title): no slide nope in this deck');
});

test('a refused save carries the plain sentence', async () => {
  await assert.rejects(deckCall('/api/initiative-decks/d/revisions', { method: 'POST', body: '{}' }, answer(400, { error: 'invalid DeckSpec', errors: ['slides[1].title: required'] })),
    (err: unknown) => err instanceof DeckApiError && err.status === 400 && err.message === 'Slide 2 needs a title.');
  // A refusal without validator lines keeps its own words and lists the rest.
  await assert.rejects(deckCall('/x', {}, answer(400, { error: 'bad body', errors: ['baseRevisionId is required'] })),
    (err: unknown) => err instanceof Error && err.message === 'bad body: baseRevisionId is required');
});

test('the draft refusal names at most three problems', () => {
  assert.equal(draftRefusal([]), null);
  assert.equal(draftRefusal(['slides[1].title: required']), 'Slide 2 needs a title.');
  const many = ['slides[0].title: required', 'slides[1].title: required', 'slides[2].title: required', 'slides[3].title: required', 'slides[4].title: required'];
  assert.equal(draftRefusal(many), 'Slide 1 needs a title. Slide 2 needs a title. Slide 3 needs a title. And 2 more.');
});

test('a new slide with no title takes its layout placeholder; an existing slide keeps what its author left', () => {
  const prev = { title: 'D', slides: [{ id: 'a', layout: 'bullets', title: '', sources: [] }] } as unknown as DeckSpec;
  const next = { title: 'D', slides: [...prev.slides, { id: 's2', layout: 'timeline', title: '', sources: [] }, { id: 's3', layout: 'key-figures', title: 'Mine', sources: [] }] } as unknown as DeckSpec;
  const out = withPlaceholderTitles(prev, next);
  assert.deepEqual(out.slides.map(s => s.title), ['', 'Timeline', 'Mine']);
  assert.equal(withPlaceholderTitles(next, next), next);
});
