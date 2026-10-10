import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRevisionId, revisionSeq, toEditorRevisions } from '../decksModel.ts';
const revisions = [
  { id: 'head7', label: 'Edited', createdAt: '2026-10-09T17:24:32.009Z', producedBy: 'person:u-nora' },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `old${6-i}`, label: 'Edited', createdAt: '2026-10-09T17:00:00.000Z', producedBy: 'person:preserved', specAvailable: false as const, unavailabilityReason: 'Saved metadata only' })),
];
test('the authentic head opens while unavailable historical metadata keeps honest version numbering', () => {
  assert.equal(openRevisionId({ revisions, activeRevisionId: 'head7' }), 'head7');
  assert.equal(openRevisionId({ revisions, activeRevisionId: 'old6' }), 'head7');
  assert.equal(openRevisionId({ revisions: revisions.slice(1), activeRevisionId: 'old6' }), null);
  assert.equal(revisionSeq(revisions, 'head7'), 7); assert.equal(revisionSeq(revisions, 'old1'), 1);
  const options = toEditorRevisions(revisions, iso => iso);
  assert.equal(options.length, 7); assert.equal(options[1]!.specAvailable, false); assert.equal(options[1]!.unavailabilityReason, 'Saved metadata only');
  assert.equal(options[0]!.producedBy, 'person:u-nora');
});
