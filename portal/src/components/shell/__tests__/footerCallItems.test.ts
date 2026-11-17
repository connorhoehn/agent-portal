import assert from 'node:assert/strict';
import { test } from 'node:test';
import { footerCallItems } from '../callShellModel.ts';

test('an interview\'s call bar leaves out the work-huddle-only items and is named as it is', () => {
  const items = footerCallItems('interviews:interview:iv-1');
  assert.deepEqual(
    { share: items.share, meeting: items.meeting, reactions: items.reactions, mediaToggle: items.mediaToggle, socialEntry: items.socialEntry, startLabel: items.startLabel, idleMessage: items.idleMessage },
    { share: false, meeting: false, reactions: false, mediaToggle: false, socialEntry: false, startLabel: 'Join the call', idleMessage: false },
  );
  assert.equal(items.name('Leadership with Nadia'), 'Leadership with Nadia');
});

test('every other lobby keeps the work huddle\'s footer unchanged', () => {
  for (const lobby of ['orgiq:initiative:p-1', 'social:room:abc', 'assessment:team:TEAM-1', 'pipelines:run:r-1', null, undefined, 'interviews:interview:iv-1~breakout~r1']) {
    const items = footerCallItems(lobby);
    assert.deepEqual(
      { share: items.share, meeting: items.meeting, reactions: items.reactions, mediaToggle: items.mediaToggle, socialEntry: items.socialEntry, startLabel: items.startLabel, idleMessage: items.idleMessage },
      { share: true, meeting: true, reactions: true, mediaToggle: true, socialEntry: true, startLabel: 'Huddle', idleMessage: true }, String(lobby));
    assert.equal(items.name('Payments'), 'Payments huddle');
    assert.equal(items.name('Payments huddle'), 'Payments huddle');
  }
});

test('an interview call drops the Today strip beside the bar; every other call keeps it', () => {
  assert.equal(footerCallItems('interviews:interview:iv-k1p5w8ra').todayStrip, false);
  assert.equal(footerCallItems('huddle:p-observability').todayStrip, true);
  assert.equal(footerCallItems(null).todayStrip, true);
});
