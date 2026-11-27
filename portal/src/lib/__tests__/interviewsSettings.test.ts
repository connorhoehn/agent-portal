// The tenant's read-only Settings (lib/interviewsSettings.ts): how a value reads, and the order of the rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedSettings, settingChanged, settingValueLabel, type SettingRow } from '../interviewsSettings.ts';

test('each kind of value reads plainly', () => {
  assert.deepEqual([true, false].map(settingValueLabel), ['On', 'Off']);
  assert.equal(settingValueLabel(['recording', 'transcription']), 'recording, transcription');
  assert.equal(settingValueLabel([]), 'None');
  assert.equal(settingValueLabel(30), '30');
  assert.equal(settingValueLabel(''), 'Not set');
  assert.equal(settingValueLabel('mock'), 'mock');
});

test('a value differing from its default is marked changed; the rows read retention, consent, runner, then the rest', () => {
  assert.equal(settingChanged({ value: 45, default: 30 }), true);
  assert.equal(settingChanged({ value: [], default: [] }), false);
  const row = (name: string, group: SettingRow['group']): SettingRow => ({ name, group, about: 'A', value: 1, default: 1 });
  assert.deepEqual(orderedSettings([row('a', 'other'), row('b', 'runner'), row('c', 'retention'), row('d', 'consent'), row('e', 'retention')]).map((r) => r.name),
    ['c', 'e', 'd', 'b', 'a']);
});
