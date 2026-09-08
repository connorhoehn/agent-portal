// Run with:  cd portal && node --test 'src/components/scores/__tests__/*.test.ts'
//
// Plain node:test — pure module, no JSX, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialSkillComboboxState,
  skillComboboxReducer,
  type SkillComboboxState,
} from '../skillComboboxState.ts';

function reduce(state: SkillComboboxState, ...actions: Parameters<typeof skillComboboxReducer>[1][]) {
  return actions.reduce(skillComboboxReducer, state);
}

test('initial state is closed with no highlight and no query', () => {
  assert.deepEqual(initialSkillComboboxState, { query: '', open: false, activeIndex: -1 });
});

test('typing a non-empty query opens the panel (DEFECTS.md org-leader #10)', () => {
  const s = reduce(initialSkillComboboxState, { type: 'type', value: 'ru' });
  assert.equal(s.open, true);
  assert.equal(s.query, 'ru');
});

test('typing back to an empty query closes the panel — never "No skills match \\"\\""', () => {
  const opened = reduce(initialSkillComboboxState, { type: 'type', value: 'r' });
  const cleared = skillComboboxReducer(opened, { type: 'type', value: '' });
  assert.equal(cleared.open, false);
  assert.equal(cleared.query, '');
});

test('ArrowDown from closed opens and highlights the first suggestion when any exist', () => {
  const s = skillComboboxReducer(initialSkillComboboxState, { type: 'arrow-down', count: 3 });
  assert.equal(s.open, true);
  assert.equal(s.activeIndex, 0);
});

test('ArrowDown from closed with zero suggestions opens but highlights nothing', () => {
  const s = skillComboboxReducer(initialSkillComboboxState, { type: 'arrow-down', count: 0 });
  assert.equal(s.open, true);
  assert.equal(s.activeIndex, -1);
});

test('ArrowDown while open moves the highlight forward, clamped to the last suggestion', () => {
  let s = skillComboboxReducer(initialSkillComboboxState, { type: 'arrow-down', count: 2 });
  s = skillComboboxReducer(s, { type: 'arrow-down', count: 2 });
  assert.equal(s.activeIndex, 1);
  s = skillComboboxReducer(s, { type: 'arrow-down', count: 2 }); // already at the end
  assert.equal(s.activeIndex, 1);
});

test('ArrowUp while closed is a no-op', () => {
  const s = skillComboboxReducer(initialSkillComboboxState, { type: 'arrow-up', count: 3 });
  assert.deepEqual(s, initialSkillComboboxState);
});

test('ArrowUp clamps at the first suggestion, never goes negative', () => {
  let s = skillComboboxReducer(initialSkillComboboxState, { type: 'arrow-down', count: 3 });
  s = skillComboboxReducer(s, { type: 'arrow-up', count: 3 });
  assert.equal(s.activeIndex, 0);
});

test('select resets to the closed, empty-query state (picking a suggestion clears the search)', () => {
  const s = reduce(
    initialSkillComboboxState,
    { type: 'type', value: 'kub' },
    { type: 'arrow-down', count: 1 },
    { type: 'select' },
  );
  assert.deepEqual(s, { query: '', open: false, activeIndex: -1 });
});

test('close (Escape / outside click) closes without touching the typed query', () => {
  const s = reduce(
    initialSkillComboboxState,
    { type: 'type', value: 'kub' },
    { type: 'close' },
  );
  assert.equal(s.open, false);
  assert.equal(s.query, 'kub');
  assert.equal(s.activeIndex, -1);
});

test('close on an already-closed state is a no-op (referentially stable)', () => {
  const s = skillComboboxReducer(initialSkillComboboxState, { type: 'close' });
  assert.equal(s, initialSkillComboboxState);
});

test('clear blanks the query and closes', () => {
  const s = reduce(
    initialSkillComboboxState,
    { type: 'type', value: 'kub' },
    { type: 'clear' },
  );
  assert.deepEqual(s, { query: '', open: false, activeIndex: -1 });
});
