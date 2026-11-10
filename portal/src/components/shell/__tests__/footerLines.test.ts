// The footer's wrapped lines carry no stray left rule (UX leftovers, 10 November).
// Run with:  cd portal && node --test src/components/shell/__tests__/footerLines.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineStarts } from '../footerLines.ts';

const slot = (top: number, height = 28, visible = true) => ({ visible, top, bottom: top + height });
const hidden = { visible: false, top: 0, bottom: 0 };

test('Work at 390: Social on line one, voice on line two, the huddle on line three', () => {
  // Social, the Today strip (hidden under 780px), voice, huddle.
  assert.deepEqual(lineStarts([slot(4), hidden, slot(40), slot(76, 36)]), [true, false, true, true]);
});

test('Pipelines: no Social entry and the Today strip hidden, so the voice slot leads the row and has no rule', () => {
  assert.deepEqual(lineStarts([hidden, slot(8)]), [false, true]);
});

test('one line at 1440: only the first visible slot starts it, even when centred slots differ in height', () => {
  assert.deepEqual(lineStarts([slot(8, 28), slot(4, 36), slot(10, 24), slot(4, 36)]), [true, false, false, false]);
});

test('a hidden slot between two slots on a line does not break the count', () => {
  assert.deepEqual(lineStarts([slot(4), hidden, slot(4), slot(40)]), [true, false, false, true]);
});
