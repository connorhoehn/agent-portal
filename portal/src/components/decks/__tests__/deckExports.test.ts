import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECK_EXPORTS, deckExportFallbackName, deckExportName, deckExportUrl, deckFileName, isDeckExportFormat } from '../decksModel.ts';

test('the download menu offers PowerPoint, PDF and images, in that order', () => {
  assert.deepEqual(DECK_EXPORTS.map(e => e.label), ['PowerPoint (.pptx)', 'PDF (.pdf)', 'Images (.zip)']);
  assert.ok(isDeckExportFormat('pdf'));
  assert.ok(!isDeckExportFormat('docx'));
  assert.ok(!isDeckExportFormat({ type: 'click' }));
});

test('each format has the server\'s file name and the PowerPoint URL is unchanged', () => {
  assert.equal(deckFileName('Q3 Review!', 2), 'q3-review-v2.pptx');
  assert.equal(deckExportName('Q3 Review!', 2, 'pdf'), 'q3-review-v2.pdf');
  assert.equal(deckExportName('Q3 Review!', 2, 'png'), 'q3-review-v2-slides.zip');
  assert.equal(deckExportFallbackName('q3-review-v2.pptx', 'png'), 'q3-review-v2-slides.zip');
  assert.equal(deckExportUrl('/api/x/decks/d/revisions/r/file', 'pptx'), '/api/x/decks/d/revisions/r/file');
  assert.equal(deckExportUrl('/api/x/decks/d/revisions/r/file', 'pdf'), '/api/x/decks/d/revisions/r/file?format=pdf');
  assert.equal(deckExportUrl('/f?a=1', 'png'), '/f?a=1&format=png');
});
