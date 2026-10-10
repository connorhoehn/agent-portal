import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayPreferencesKey, TODAY_CATEGORIES, TODAY_SAMPLES } from '../footerTodayModel.ts';

test('personal preference keys isolate exact actor and workspace without ambiguous separators', () => {
  assert.notEqual(todayPreferencesKey('a:b', 'c'), todayPreferencesKey('a', 'b:c'));
  assert.notEqual(todayPreferencesKey('reader', 'orgiq'), todayPreferencesKey('reader', 'assessment'));
  assert.notEqual(todayPreferencesKey('reader', 'orgiq'), todayPreferencesKey('other-reader', 'orgiq'));
  for (const actor of [null, undefined, '', ' ']) assert.equal(todayPreferencesKey(actor, 'orgiq'), null);
  assert.equal(todayPreferencesKey('reader', ''), null);
});
test('demo priority is review, agenda, goals, automation, budget and every detail identifies sample content', () => {
  assert.deepEqual(TODAY_SAMPLES.map(sample => sample.category), [...TODAY_CATEGORIES]);
  assert.ok(TODAY_SAMPLES.every(sample => sample.detail.startsWith('Sample:')));
  assert.ok(TODAY_SAMPLES.every(sample => sample.summary && sample.detail));
});
