import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TODAY_PREFERENCES, readTodayPreferences, todayPreferencesKey, todayRotationAllowed, TODAY_CATEGORIES, TODAY_SAMPLES } from '../footerTodayModel.ts';

test('personal preference keys isolate exact actor and workspace without ambiguous separators', () => {
  assert.notEqual(todayPreferencesKey('a:b', 'c'), todayPreferencesKey('a', 'b:c'));
  assert.notEqual(todayPreferencesKey('reader', 'orgiq'), todayPreferencesKey('reader', 'assessment'));
  assert.notEqual(todayPreferencesKey('reader', 'orgiq'), todayPreferencesKey('other-reader', 'orgiq'));
  for (const actor of [null, undefined, '', ' ']) assert.equal(todayPreferencesKey(actor, 'orgiq'), null);
  assert.equal(todayPreferencesKey('reader', ''), null);
});
test('malformed or untrusted preferences cannot change the bounded speed or category vocabulary', () => {
  for (const raw of [null, '{broken', 'null', '[]', '7']) assert.deepEqual(readTodayPreferences(raw), DEFAULT_TODAY_PREFERENCES);
  assert.deepEqual(readTodayPreferences(JSON.stringify({ hidden: 'true', speed: 'unbounded', categories: ['budget', 'review', 'review', 'unknown'], dimmed: true })), {
    ...DEFAULT_TODAY_PREFERENCES, dimmed: true, categories: ['review', 'budget'],
  });
  assert.deepEqual(readTodayPreferences('{"categories":[]}').categories, []);
});
test('changing one parsed preference never mutates defaults used by another identity', () => {
  const parsed = readTodayPreferences(null); parsed.categories.pop();
  assert.deepEqual(readTodayPreferences(null).categories, [...TODAY_CATEGORIES]);
});
test('rotation is manual under quiet/reduced motion and pauses for engagement, hidden tabs and calls', () => {
  const active = { paused: false, quiet: false, engaged: false, reducedMotion: false, pageVisible: true, activeCall: false, count: 5 };
  assert.equal(todayRotationAllowed(active), true);
  for (const flag of ['paused', 'quiet', 'engaged', 'reducedMotion', 'activeCall'] as const) assert.equal(todayRotationAllowed({ ...active, [flag]: true }), false);
  assert.equal(todayRotationAllowed({ ...active, pageVisible: false }), false);
  assert.equal(todayRotationAllowed({ ...active, count: 1 }), false);
});
test('demo priority is review, agenda, goals, automation, budget and every detail identifies sample content', () => {
  assert.deepEqual(TODAY_SAMPLES.map(sample => sample.category), [...TODAY_CATEGORIES]);
  assert.ok(TODAY_SAMPLES.every(sample => sample.detail.startsWith('Sample:')));
  assert.ok(TODAY_SAMPLES.every(sample => !/\$\d|\d+ agents|\d+ running/.test(sample.summary)));
});
