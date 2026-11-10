// Run with:  cd portal && node --test 'src/pages/release/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { driftLine, skillStatusTone, STATUS_TONE, HOOK_EVENT_LABEL, versionLabel } from '../sessionFormat.ts';
import type { BundledSkill } from '../types.ts';

function skill(over: Partial<BundledSkill> & Pick<BundledSkill, 'id' | 'status'>): BundledSkill {
  return { name: over.id, description: '', version: '1', source: 'library', ...over };
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

test('STATUS_TONE and HOOK_EVENT_LABEL cover every value of their type', () => {
  assert.deepEqual(Object.keys(STATUS_TONE).sort(), ['live', 'pending', 'superseded']);
  assert.deepEqual(
    Object.keys(HOOK_EVENT_LABEL).sort(),
    ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'],
  );
});
