// Regression walk, 9 November 2026 (night), E4: the Social status line was empty
// after a reload, because presence is per connection. It is kept per user on the
// device and announced again when the shell's presence entry joins.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SOCIAL_STATUS_STORAGE_KEY, clearSocialStatus, loadSocialStatus, saveSocialStatus } from '../socialStatusStore.ts';
import { initialStatus } from '../../pages/social/profileModel.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
};

test('a status line set by one user reads back for that user only', () => {
  const s = memory();
  saveSocialStatus('u-ana', { statusMessage: 'Heads down on the migration' }, s);
  saveSocialStatus('u-ana', { status: 'busy' }, s);
  assert.deepEqual(loadSocialStatus('u-ana', s), { status: 'busy', statusMessage: 'Heads down on the migration' });
  assert.equal(loadSocialStatus('u-ben', s), null);
});

test('clearing the line keeps the status, and clearing both forgets the entry', () => {
  const s = memory();
  saveSocialStatus('u-ana', { status: 'away', statusMessage: 'Out today' }, s);
  saveSocialStatus('u-ana', { statusMessage: null }, s);
  assert.deepEqual(loadSocialStatus('u-ana', s), { status: 'away' });
  clearSocialStatus(s);
  assert.equal(s.m.has(SOCIAL_STATUS_STORAGE_KEY), false);
});

test('a corrupt or foreign entry reads as nothing', () => {
  const s = memory();
  s.setItem(SOCIAL_STATUS_STORAGE_KEY, '{not json');
  assert.equal(loadSocialStatus('u-ana', s), null);
  s.setItem(SOCIAL_STATUS_STORAGE_KEY, JSON.stringify({ userId: 'u-ana', status: 'sleeping' }));
  assert.equal(loadSocialStatus('u-ana', s), null);
});

test('the profile reads a not-online entry kept as busy as Do not disturb', () => {
  assert.equal(initialStatus({ idle: true }, 'busy'), 'busy');
  assert.equal(initialStatus({ idle: true }, null), 'away');
  assert.equal(initialStatus({}, 'busy'), 'online');
});

test('the shell announcement keeps every status write and announces the kept one on join', () => {
  const shell = readFileSync(new URL('../../components/shell/EmbeddedSocial.tsx', import.meta.url), 'utf8');
  assert.match(shell, /const saved = loadSocialStatus\(userId\);/);
  assert.match(shell, /saveSocialStatus\(userId, \{ status \}\); setStatus\(status\);/);
  assert.match(shell, /saveSocialStatus\(userId, \{ statusMessage:/);
  const auth = readFileSync(new URL('../auth.tsx', import.meta.url), 'utf8');
  assert.equal((auth.match(/clearSocialStatus\(\);/g) ?? []).length, 2, 'login and logout forget it');
});
