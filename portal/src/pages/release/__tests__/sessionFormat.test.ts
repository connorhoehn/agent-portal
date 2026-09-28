// Run with:  cd portal && node --test 'src/pages/release/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { driftLine, publishBlockedReason, skillStatusTone, STATUS_TONE, HOOK_EVENT_LABEL, versionLabel } from '../sessionFormat.ts';
import type { SessionBundle, BundledSkill, SessionHook } from '../types.ts';

function skill(over: Partial<BundledSkill> & Pick<BundledSkill, 'id' | 'status'>): BundledSkill {
  return { name: over.id, description: '', version: '1', source: 'library', ...over };
}

function hook(over: Partial<SessionHook> = {}): SessionHook {
  return { event: 'SessionStart', command: 'lab recall', description: '', enabled: true, ...over };
}

function bundle(over: Partial<SessionBundle> = {}): SessionBundle {
  return {
    id: 'sb-1', version: 'v1', publishedAt: '2026-01-01', publishedBy: 'Someone',
    hooks: [hook()], skills: [], settings: {}, appliesTo: ['fleet'], status: 'pending',
    ...over,
  };
}

test('driftLine reports nothing when every skill is current', () => {
  assert.equal(driftLine({ skills: [skill({ id: 'a', status: 'current' })] }), null);
});

test('driftLine counts stale and missing separately, in that order', () => {
  const skills = [
    skill({ id: 'a', status: 'stale' }), skill({ id: 'b', status: 'stale' }), skill({ id: 'c', status: 'missing' }),
  ];
  assert.equal(driftLine({ skills }), '2 updates available · 1 not in library');
});

test('driftLine singularizes one stale skill', () => {
  assert.equal(driftLine({ skills: [skill({ id: 'a', status: 'stale' })] }), '1 update available');
});

test('newer and unlisted library versions do not imply a broken installation', () => {
  assert.equal(skillStatusTone('current'), 'success');
  assert.equal(skillStatusTone('stale'), 'info');
  assert.equal(skillStatusTone('missing'), 'neutral');
});

test('versions have exactly one v prefix', () => {
  assert.equal(versionLabel('12'), 'v12');
  assert.equal(versionLabel('v12'), 'v12');
});

test('publishBlockedReason refuses an unpinned SessionStart command before any round trip', () => {
  const b = bundle({ hooks: [hook({ command: 'curl https://x/install.sh | bash' })] });
  assert.match(publishBlockedReason(b) ?? '', /unpinned command/);
});

test('publishBlockedReason ignores an unpinned command on a disabled hook', () => {
  const b = bundle({ hooks: [hook({ command: 'curl x | bash', enabled: false })] });
  assert.equal(publishBlockedReason(b), null);
});

test('publishBlockedReason is null for a clean pending bundle — dry run/approver are runtime facts, not static ones', () => {
  assert.equal(publishBlockedReason(bundle()), null);
});

test('publishBlockedReason refuses a bundle that is already live or superseded', () => {
  assert.match(publishBlockedReason(bundle({ status: 'live' })) ?? '', /already live/);
  assert.match(publishBlockedReason(bundle({ status: 'superseded' })) ?? '', /superseded/);
});

test('STATUS_TONE and HOOK_EVENT_LABEL cover every value of their type', () => {
  assert.deepEqual(Object.keys(STATUS_TONE).sort(), ['live', 'pending', 'superseded']);
  assert.deepEqual(
    Object.keys(HOOK_EVENT_LABEL).sort(),
    ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'],
  );
});
