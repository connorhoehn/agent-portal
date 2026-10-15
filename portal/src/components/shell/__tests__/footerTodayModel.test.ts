import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayCategories, todayItemsFromWire, todayPreferencesKey } from '../footerTodayModel.ts';

test('personal preference keys isolate exact actor and workspace without ambiguous separators', () => {
  assert.notEqual(todayPreferencesKey('a:b', 'c'), todayPreferencesKey('a', 'b:c'));
  assert.notEqual(todayPreferencesKey('reader', 'orgiq'), todayPreferencesKey('reader', 'assessment'));
  assert.notEqual(todayPreferencesKey('reader', 'orgiq'), todayPreferencesKey('other-reader', 'orgiq'));
  for (const actor of [null, undefined, '', ' ']) assert.equal(todayPreferencesKey(actor, 'orgiq'), null);
  assert.equal(todayPreferencesKey('reader', ''), null);
});

test('wire items come back in priority order, malformed ones dropped, and nothing is invented', () => {
  const items = todayItemsFromWire({ items: [
    { category: 'budget', label: 'Budget', summary: '$10.22 of $431.00 spent this month (2%)', detail: 'd' },
    { category: 'review', label: 'Needs review', summary: '1 agent question waiting for an answer', detail: 'd' },
    { category: 'review', label: 'Needs review' },
    { category: 'automation', label: 'Automation' },
  ] });
  assert.deepEqual(items.map((i) => i.category), ['review', 'budget']);
  assert.deepEqual(todayCategories(items), [{ id: 'review', label: 'Needs review' }, { id: 'budget', label: 'Budget' }]);
  for (const body of [null, {}, { items: 'x' }, { items: [] }]) assert.deepEqual(todayItemsFromWire(body), []);
});
