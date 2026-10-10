// Run with:  cd portal && node --test 'src/pages/social/__tests__/socialRecordingPicker.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordingPicks, recordingToken, withRecordingPicker } from '../socialRecordingPicker.ts';
import { socialSummarizeCommand } from '../socialSummarize.ts';
import { socialDeckCommand } from '../decks/socialDecksApi.ts';

const recs = [
  { recordingId: 'rec-old', startedAt: '2026-10-01T10:00:00.000Z', durationMs: 540_000 },
  { recordingId: 'rec-new', startedAt: '2026-10-05T10:00:00.000Z', durationMs: 20_000 },
];

test('a DM offers its recordings newest first; a channel or a room offers none', () => {
  assert.deepEqual(recordingPicks('social:dm:u-a:u-b', recs).map(p => p.recordingId), ['rec-new', 'rec-old']);
  assert.equal(recordingPicks('social:dm:u-a:u-b', recs)[1]!.hint, '9 min');
  assert.equal(recordingPicks('social:dm:u-a:u-b', recs)[0]!.hint, '1 min');
  assert.deepEqual(recordingPicks('social:ch:general', recs), []);
  assert.deepEqual(recordingPicks('social:room:town-hall', recs), []);
});

test('the picker writes the machine token the BFF parses, keeps the command otherwise, and filters as you type', async () => {
  const picks = recordingPicks('social:dm:u-a:u-b', recs);
  for (const base of [socialSummarizeCommand, socialDeckCommand]) {
    const command = withRecordingPicker(base, () => picks);
    assert.equal(command.trigger, base.trigger);
    assert.equal(command.run, base.run);
    const items = await command.argument!.search('');
    assert.deepEqual(items.map(i => i.label), [recordingToken('rec-new'), recordingToken('rec-old')]);
    assert.equal(items[0]!.label, '--from recording:rec-new');
    assert.equal(command.argument!.onPick!(items[0]!), 'insert');
    assert.deepEqual((await command.argument!.search('rec-old')).map(i => i.id), ['rec-old']);
    assert.deepEqual(await command.argument!.search('zzz'), []);
  }
});

test('the loader is read on every search, so a refreshed list shows without rebuilding the command', async () => {
  let current = recordingPicks('social:dm:u-a:u-b', []);
  const command = withRecordingPicker(socialSummarizeCommand, () => current);
  assert.deepEqual(await command.argument!.search(''), []);
  current = recordingPicks('social:dm:u-a:u-b', recs);
  assert.equal((await command.argument!.search('')).length, 2);
});
