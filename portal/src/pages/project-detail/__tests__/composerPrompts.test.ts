// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The composer's words: the mockup prefills, workflows built from rows, the
// slash commands matching the Workflow menu, and the /iq/invoke link.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  askHref, commandIn, composerCommands, composerSetup, itemPrefill, workflowMenu, workflowMenuRows, workflowPrompt,
  type ComposerSubject,
} from '../composerPrompts.ts';
import { briefFacts } from '../briefModel.ts';
import { workRows } from '../workListModel.ts';
import type { ProjectSummary } from '../../projects/types.ts';
import { OBS_PROJECT, OBS_TREE } from './obsFixture.ts';

const rows = workRows(OBS_TREE, 'priority', '');
const b4 = rows.find((r) => r.id === 'wi-obs-e2-b4')!;
const itemSubject: ComposerSubject = { kind: 'item', project: OBS_PROJECT, item: b4, facts: briefFacts(b4, { data: [] }) };
const initiativeSubject: ComposerSubject = { kind: 'initiative', project: OBS_PROJECT, rows };
const listSubject: ComposerSubject = { kind: 'initiatives', rows: [{ id: 'p-observability', name: 'Observability Platform', status: 'in_progress', contributorCount: 3, createdAt: null, ownerName: 'Nora DaSilva', activeAgentRuns: 2 } as ProjectSummary] };

test('the three variants open as in the mockups', () => {
  const o = composerSetup(initiativeSubject);
  assert.deepEqual([o.chip.label, o.chip.marker, o.draft], ['Observability Platform', 'dot', 'Help me prioritize the next changes and explain the tradeoffs.']);
  const w = composerSetup(itemSubject);
  assert.deepEqual([w.chip.label, w.draft, w.draftKey], [
    'This work item',
    'Help me define acceptance criteria and identify what Eli needs before this work can start.',
    'item:wi-obs-e2-b4',
  ]);
  const m = composerSetup(listSubject);
  assert.deepEqual([m.chip.label, m.draft, m.placeholder], ['Initiatives', '', "Ask about the team's initiatives or how to get involved…"]);
});

test('the item prefill follows what the brief is missing, and claims nothing unknown', () => {
  const base = { criteriaCount: 0, blocked: false, assigneeFirstName: 'Eli' };
  assert.equal(itemPrefill(base), 'Help me define acceptance criteria for this work.');
  assert.equal(itemPrefill({ ...base, criteriaCount: 2, blocked: true }), 'Help me identify what Eli needs before this work can start.');
  assert.equal(itemPrefill({ ...base, criteriaCount: null, blocked: true, assigneeFirstName: null }), 'Help me identify what the team needs before this work can start.');
  assert.equal(itemPrefill({ ...base, criteriaCount: 3 }), 'Help me plan the next step for this work and explain the tradeoffs.');
});

test('workflows: disabled with a reason where they do not apply; commands mirror the menu', () => {
  assert.deepEqual(workflowMenu(initiativeSubject).map((w) => [w.label, w.disabledReason]), [
    ['Prioritize next work', null],
    ['Define acceptance criteria', 'Open a work item first'],
    ['Unblock this item', 'Open a work item first'],
  ]);
  assert.deepEqual(workflowMenu(itemSubject).map((w) => w.disabledReason), ['Open the initiative to prioritize its work', null, null]);
  const cmds = composerCommands(itemSubject);
  assert.deepEqual(cmds.map((c) => [c.trigger, c.disabled]), [['/prioritize', true], ['/criteria', false], ['/unblock', false]]);
  assert.equal(workflowPrompt('unblock', { ...itemSubject, facts: { ...itemSubject.facts, blocked: false } }), null);
});

test('the Workflow menu rows are DropdownMenuItem-shaped: inapplicable ones disabled, reason instead of description', () => {
  assert.deepEqual(workflowMenuRows(initiativeSubject), [
    { id: 'prioritize', label: 'Prioritize next work', description: 'Rank the open work and explain the tradeoffs', disabled: false },
    { id: 'criteria', label: 'Define acceptance criteria', disabled: true, disabledReason: 'Open a work item first' },
    { id: 'unblock', label: 'Unblock this item', disabled: true, disabledReason: 'Open a work item first' },
  ]);
  const onItem = workflowMenuRows({ ...itemSubject, facts: { ...itemSubject.facts, blocked: false } });
  assert.deepEqual(onItem.map((r) => [r.id, r.disabled, r.disabledReason ?? null]), [
    ['prioritize', true, 'Open the initiative to prioritize its work'],
    ['criteria', false, null],
    ['unblock', true, 'This item is not blocked'],
  ]);
  // A disabled row carries no description: the reason IS its second line.
  assert.ok(onItem.filter((r) => r.disabled).every((r) => r.description === undefined));
});

test('workflow prompts are built from the rows', () => {
  const p = workflowPrompt('prioritize', initiativeSubject)!;
  assert.match(p, /^Help me prioritize the next changes and explain the tradeoffs\.\n\nOpen work on Observability Platform:/);
  assert.match(p, /- Stop duplicate alerts during a dependency outage \(Eli Garcia, high, 2 points, blocked\)/);
  assert.doesNotMatch(p, /SLO definitions/); // done work is not up for prioritizing
  const u = workflowPrompt('unblock', itemSubject)!;
  assert.match(u, /What does Eli need before "Stop duplicate alerts during a dependency outage" can start\?/);
  assert.match(u, /Blocked because: Waiting on the dependency map\./);
  assert.match(u, /Planned next step: Confirm the dependency map with Eli Garcia\./);
  assert.match(workflowPrompt('criteria', itemSubject)!, /What it changes: One failing dependency can trigger forty pages\./);
  assert.match(workflowPrompt('prioritize', listSubject)!, /- Observability Platform \(in_progress, owner Nora DaSilva, 2 running\)/);
});

test('the Ask link carries the question and its context; empty text asks nothing', () => {
  const href = askHref('Why is this blocked?', itemSubject)!;
  assert.ok(href.startsWith('/iq/invoke?prompt='));
  const prompt = new URLSearchParams(href.split('?')[1]).get('prompt')!;
  assert.equal(prompt, 'Why is this blocked?\n\nAbout the work item "Stop duplicate alerts during a dependency outage" (wi-obs-e2-b4) on the initiative "Observability Platform" (p-observability). Advise only; do not change anything.');
  assert.equal(askHref('   ', itemSubject), null);
  assert.equal(new URLSearchParams(askHref('hi', listSubject, false)!.split('?')[1]).get('prompt'), 'hi');
});

test('a slash command expands to its workflow, and an inapplicable one asks nothing', () => {
  assert.equal(commandIn('/unblock please'), 'unblock');
  assert.equal(commandIn('/nope'), null);
  const prompt = new URLSearchParams(askHref('/unblock by Friday?', itemSubject)!.split('?')[1]).get('prompt')!;
  assert.match(prompt, /^What does Eli need[\s\S]*\n\nby Friday\?\n\nAbout the work item/);
  assert.equal(askHref('/criteria', initiativeSubject), null);
});
