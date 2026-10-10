import assert from 'node:assert/strict';
import test from 'node:test';
import { allMarks, joinSuggestionBlocks, planResolution, splitSuggestionBlocks } from '../knowledge/documentSuggestionsModel.ts';
import { insertContentFor } from '../knowledge/documentAgentEditModel.ts';

const RECIPE = '## Recipe Format\n\n- Ingredients\n- Instructions\n\nA closing paragraph.';

test('a block is exactly one node Apply would insert', () => {
  const blocks = splitSuggestionBlocks(RECIPE);
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'list', 'paragraph']);
  assert.deepEqual(blocks.map(block => block.text), ['Recipe Format', 'Ingredients\nInstructions', 'A closing paragraph.']);
  assert.equal((insertContentFor(RECIPE) as unknown[]).length, blocks.length);
  assert.equal(joinSuggestionBlocks(blocks), RECIPE);
});

test('nothing is committed until every block has a verdict', () => {
  const plan = planResolution(RECIPE, { 0: 'accept', 2: 'reject' });
  assert.deepEqual(plan, { action: 'wait', undecided: [1] });
});

test('rejecting every block discards, and accepting every block applies the stored text unchanged', () => {
  assert.deepEqual(planResolution(RECIPE, allMarks(RECIPE, 'reject')), { action: 'discard' });
  assert.deepEqual(planResolution(RECIPE, allMarks(RECIPE, 'accept')), { action: 'apply', narrowed: false });
});

test('a partial accept narrows to exactly the accepted blocks, whole, in order', () => {
  const plan = planResolution(RECIPE, { 0: 'accept', 1: 'reject', 2: 'accept' });
  assert.deepEqual(plan, { action: 'apply', narrowed: true, content: '## Recipe Format\n\nA closing paragraph.', accepted: [0, 2] });
  // The rejected list is gone entirely: no stray bullet text survives in what lands.
  assert.ok(!(plan as { content: string }).content.includes('Ingredients'));
});

test('a single block is one suggestion, and blank or whitespace-only text has none', () => {
  assert.equal(splitSuggestionBlocks('Only one paragraph.').length, 1);
  assert.deepEqual(splitSuggestionBlocks('  \n\n \n'), []);
  assert.deepEqual(planResolution('Only one paragraph.', { 0: 'reject' }), { action: 'discard' });
});

test('CRLF text splits the same way', () => {
  assert.equal(splitSuggestionBlocks('One.\r\n\r\nTwo.').length, 2);
});
