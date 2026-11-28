// The composer's Edit router: structure, layout, style, decoration, emphasis and charts are typed operations;
// rewording stays the saved-version revise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckEditIntent } from '../deckEditIntent.ts';

const OPERATIONS = [
  'make slide 3 a KPI slide',
  "emphasise 'six weeks' in the title",
  'switch to the editorial style',
  'add a process slide after the agenda',
  'put the spend pie on slide 4',
  'remove slide 5',
  'move slide 2 to the end',
  'turn this into a timeline',
  'use the plain theme',
  'take the decoration off this slide',
];
const REVISE = [
  'make the bullets on this slide shorter',
  'rewrite the summary in plainer language',
  'tighten the speaker notes',
  'make the tone more confident',
];

test('requests that change structure, layout, style, decoration, emphasis or charts are proposed as operations', () => {
  for (const text of OPERATIONS) assert.equal(deckEditIntent(text), 'operations', text);
});

test('rewording stays the revise', () => {
  for (const text of REVISE) assert.equal(deckEditIntent(text), 'revise', text);
});
