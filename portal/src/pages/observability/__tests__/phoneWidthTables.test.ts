// Phone width on Scores, Bot detail and Calibration (UX leftovers, 10 November).
//
// At 390px these tables scrolled sideways inside their box. Each now uses the
// library DataTable's `narrow` form (under 40rem of its own width a row is a
// stacked card of label/value pairs), with a readable label for every column
// whose header is a symbol or blank. Read from the source, because these are
// React pages this node runner does not render. The run detail's steps and
// artifacts already took the form in lane D (components/runs/PipelineRunParts.tsx).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the Scores leaderboard stacks at phone width, with Rank and Compare labels', () => {
  const src = read('../../../components/scores/Leaderboard.tsx');
  assert.match(src, /<DataTable<ScoreEntry>\s+narrow/);
  assert.match(src, /header: '#',\s+label: 'Rank'/);
  assert.match(src, /header: '',\s+label: 'Compare'/);
});

test('a bot\'s firings are a narrow DataTable, not hand-built Table rows', () => {
  const src = read('../../bots/BotDetailPage.tsx');
  assert.match(src, /<DataTable<BotRun>\s+narrow/);
  assert.doesNotMatch(src, /<TableTh>Trigger<\/TableTh>/);
});

test('Calibration\'s two tables are narrow DataTables; |Δ| reads "Difference" on a card', () => {
  const src = read('../CalibrationPage.tsx');
  assert.match(src, /<DataTable<CalibrationResult>\s+narrow/);
  assert.match(src, /<DataTable<CalibrationCase>\s+narrow/);
  assert.match(src, /header: '\|Δ\|', label: 'Difference'/);
  assert.match(src, /key: 'actions', header: '', label: 'Actions'/);
  assert.doesNotMatch(src, /<Table>/);
});

test('the run detail\'s steps and artifacts keep the narrow form', () => {
  const src = read('../../../components/runs/PipelineRunParts.tsx');
  assert.equal((src.match(/<DataTable narrow/g) ?? []).length, 2);
});
