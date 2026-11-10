// The assessor's desk keeps its information and gives way by column priority (UX leftovers, 10 November).
// Run with:  cd portal && node --test src/pages/assessment/dashboard/__tests__/deskColumns.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DESK_COLUMN_MIN_REM, deskColumnHide, deskColumnsShown, deskHideFloor, type DeskColumn } from '../deskColumns.ts';

test('1440 (a 74.5rem table) drops only Step; 1280 (64.5rem) also Motion and Lead', () => {
  assert.deepEqual(deskColumnsShown(74.5), ['cohort', 'lead', 'contributors', 'updated_at', 'dimensions_assessed']);
  assert.deepEqual(deskColumnsShown(64.5), ['contributors', 'updated_at', 'dimensions_assessed']);
  assert.deepEqual(deskColumnsShown(90), Object.keys(DESK_COLUMN_MIN_REM), 'a wide table shows everything');
});

test('the card form (under 40rem) shows every field', () => {
  assert.deepEqual(deskColumnsShown(24), Object.keys(DESK_COLUMN_MIN_REM));
});

test('the priority order is Step, Motion, Lead, then Contributors, Updated, Assessed', () => {
  const order = (Object.entries(DESK_COLUMN_MIN_REM) as Array<[DeskColumn, number]>).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  assert.deepEqual(order, ['workflow_step', 'cohort', 'lead', 'contributors', 'updated_at', 'dimensions_assessed']);
});

test('the classes hide only above the card form, at the same floor the model states', () => {
  for (const c of Object.keys(DESK_COLUMN_MIN_REM) as DeskColumn[]) {
    assert.match(deskColumnHide(c), /^@min-\[40rem\]:@max-\[\d+rem\]:hidden$/);
    assert.equal(deskHideFloor(c), DESK_COLUMN_MIN_REM[c]);
  }
});

test('the desk restores the open-claims count, the Contributors header and the full date, and never hides the essentials', () => {
  const src = readFileSync(new URL('../AssessorDesk.tsx', import.meta.url), 'utf8');
  assert.match(src, /\{claims\} open/);
  assert.match(src, /key: 'contributors',\s+header: 'Contributors',/);
  assert.match(src, /<Tooltip content=\{fmtDate\(t\.updated_at\)\}>/);
  assert.match(src, /<DataTable<TeamSummary>\s+narrow/);
  for (const key of ['name', 'certification', 'followups_open', 'next']) {
    const block = new RegExp(`key: '${key}'[^}]*deskColumnHide`);
    assert.doesNotMatch(src, block, `${key} always shows`);
  }
});
