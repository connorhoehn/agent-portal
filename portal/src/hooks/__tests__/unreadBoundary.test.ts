// Run with:  cd portal && node --test 'src/hooks/__tests__/unreadBoundary.test.ts'
import test from 'node:test';
import assert from 'node:assert/strict';
import { unreadBoundary } from '../unreadBoundary.ts';

const m = (ts: string, userId = 'them') => ({ timestamp: `2026-10-07T10:00:${ts}Z`, userId });

test('the line goes above the first message after the cursor', () => {
  assert.equal(unreadBoundary([m('01'), m('02'), m('03'), m('04')], '2026-10-07T10:00:02Z', 'me'), m('03').timestamp);
});
test('my own later messages are not unread', () => {
  assert.equal(unreadBoundary([m('01'), m('02'), m('03', 'me'), m('04')], '2026-10-07T10:00:02Z', 'me'), m('04').timestamp);
});
test('no line when nothing is newer, no cursor, or all loaded messages are unread', () => {
  assert.equal(unreadBoundary([m('01'), m('02')], '2026-10-07T10:00:02Z', 'me'), undefined);
  assert.equal(unreadBoundary([m('01'), m('02')], null, 'me'), undefined);
  assert.equal(unreadBoundary([m('05'), m('06')], '2026-10-07T10:00:02Z', 'me'), undefined);
  assert.equal(unreadBoundary([m('01')], 'garbage', 'me'), undefined);
});
