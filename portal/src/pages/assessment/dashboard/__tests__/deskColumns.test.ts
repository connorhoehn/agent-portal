// The assessor's desk keeps its information and gives way by column priority (UX leftovers, 10 November;
// DataTable `responsiveColumns` since ui-components 2.516.0).
// Run with:  cd portal && node --test src/pages/assessment/dashboard/__tests__/deskColumns.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DESK_COLUMN_PRIORITY, deskColumnPriority, deskHideOrder, type DeskColumn } from '../deskColumns.ts';

test('the priority order is Step, Motion, Lead, then Contributors, Updated, Assessed', () => {
  assert.deepEqual(deskHideOrder(), ['workflow_step', 'cohort', 'lead', 'contributors', 'updated_at', 'dimensions_assessed']);
  for (const c of Object.keys(DESK_COLUMN_PRIORITY) as DeskColumn[]) assert.ok(deskColumnPriority(c) > 1, `${c} can give way`);
});

const src = readFileSync(new URL('../AssessorDesk.tsx', import.meta.url), 'utf8');

test('the desk table uses the library\'s column priorities, not container-query classes', () => {
  assert.match(src, /<DataTable<TeamSummary>\s+narrow\s+responsiveColumns/);
  assert.doesNotMatch(src, /@max-\[\d+rem\]:hidden|deskColumnHide/);
  for (const c of Object.keys(DESK_COLUMN_PRIORITY)) {
    assert.match(src, new RegExp(`key: '${c}'[^}]*priority: deskColumnPriority\\('${c}'\\)`), `${c} carries its priority`);
  }
});

test('the desk restores the open-claims count, the Contributors header and the full date, and never hides the essentials', () => {
  assert.match(src, /\{claims\} open/);
  assert.match(src, /key: 'contributors',\s+header: 'Contributors',/);
  assert.match(src, /<Tooltip content=\{fmtDate\(t\.updated_at\)\}>/);
  for (const key of ['name', 'certification', 'followups_open', 'next']) {
    assert.doesNotMatch(src, new RegExp(`key: '${key}'[^}]*priority`), `${key} always shows`);
  }
});
