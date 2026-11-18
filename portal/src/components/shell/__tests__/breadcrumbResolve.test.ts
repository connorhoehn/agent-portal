import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBreadcrumbs } from '../breadcrumbResolve.ts';

// Every shell-rail path (Layout.tsx NAV_ITEMS) plus the routes the rails open.
// A route that resolves to fewer than two crumbs renders NO trail, and the
// header rhythm (title 16px under the trail) breaks on that page alone.
const RAIL_PATHS = [
  '/iq/projects', '/iq/projects/p-observability', '/iq/sprints', '/iq/work', '/iq/work/findings', '/iq/work/queue',
  '/iq/runbooks', '/iq/runbooks/proposals', '/iq/runbooks/rb-tenant-cutover', '/iq/computers', '/iq/invoke', '/iq/explore', '/iq/scores', '/iq/scores/cohorts',
  '/iq/library', '/iq/library/lib-stakeholder-email', '/iq/designs', '/iq/designs/dr-1',
  '/iq/agents', '/iq/prompts', '/iq/history', '/iq/diff', '/iq/evaluations', '/iq/canary', '/iq/prompt-ops',
  '/admin/budgets', '/admin/projects', '/admin/observability', '/admin/observability/invocations',
  '/admin/knowledge', '/admin/capabilities', '/admin/identity', '/admin/identity/users', '/admin/bots', '/admin/changes',
  '/assessment/teams', '/assessment/teams/t-1', '/assessment/submissions', '/assessment/reports', '/assessment/feedback',
  '/assessment/enterprise', '/assessment/workspace', '/assessment/prompts', '/assessment/rules', '/assessment/runs',
  '/assessment/configuration',
  '/social/channels', '/social/dms', '/social/calls', '/social/rooms', '/social/contacts', '/social/teams',
  '/social/recordings', '/social/configuration',
  '/pipelines/definitions', '/pipelines/workflows', '/pipelines/runs', '/pipelines/approvals', '/pipelines/artifacts',
  '/pipelines/agents', '/pipelines/bots', '/pipelines/commands', '/pipelines/configuration',
  '/settings',
];

test('every rail path resolves to a named location', () => {
  for (const path of RAIL_PATHS) {
    const crumbs = resolveBreadcrumbs(path);
    assert.ok(crumbs.length >= 1 && crumbs.every(crumb => crumb.label.trim()), `${path} → ${JSON.stringify(crumbs)}`);
  }
});

test('Assessment Workspace sits under Informatics; legacy presentation links use the files location', () => {
  assert.deepEqual(resolveBreadcrumbs('/assessment/workspace'), [{ label: 'Informatics' }, { label: 'Workspace' }]);
  assert.deepEqual(resolveBreadcrumbs('/assessment/decks/deck-existing').map(crumb => crumb.label), ['Workspace', 'Presentations', 'Presentation']);
  const deck = resolveBreadcrumbs('/assessment/decks/deck-existing');
  assert.equal(deck[0]?.path, '/assessment/workspace?view=library');
  assert.equal(deck[1]?.path, '/assessment/workspace?view=presentations');
  assert.equal(deck[2]?.id, 'deck-existing');
});

test('every Assessment page trail names its rail group, so a list page draws a breadcrumb (UX walk D)', () => {
  assert.deepEqual(resolveBreadcrumbs('/assessment/teams/TEAM-005'), [
    { label: 'Assess' }, { label: 'Dashboard', path: '/assessment/teams' }, { label: 'TEAM-005', id: 'TEAM-005' },
  ]);
  for (const [path, labels] of [
    ['/assessment/teams', ['Assess', 'Dashboard']],
    ['/assessment/submissions', ['Assess', 'Submissions']],
    ['/assessment/communication', ['Assess', 'Communication']],
    ['/assessment/workspace', ['Informatics', 'Workspace']],
  ] as const) {
    // The shell's Breadcrumbs draw a trail of two or more (minItems 2).
    assert.deepEqual(resolveBreadcrumbs(path).map(crumb => crumb.label), labels, path);
  }
  assert.deepEqual(resolveBreadcrumbs('/assessment/submissions/sub-1').map(crumb => crumb.label), ['Assess', 'Submissions', 'sub-1']);
});

test('a Work presentation trail names its files location and resolved entity without Plan', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/decks/deck-existing'), [
    { label: 'Initiatives', path: '/iq/projects' },
    { label: 'Deck', id: 'deck-existing' },
  ]);
});

test('the Design rail pages sit under Design, and a library asset gets a third crumb', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/library').map((c) => c.label), ['Build', 'Agent library']);
  assert.equal(resolveBreadcrumbs('/iq/library/lib-stakeholder-email')[1]!.path, '/iq/library');
});

test('entity crumbs carry the id so a mounted page can supply the title', () => {
  const cases: Array<[string, string]> = [
    ['/iq/designs/des-auth-rotation', 'des-auth-rotation'],
    ['/iq/library/lib-stakeholder-email', 'lib-stakeholder-email'],
    ['/iq/work/job-0123456789abcdef', 'job-0123456789abcdef'],
    ['/admin/bots/bot-nightly-lint', 'bot-nightly-lint'],
  ];
  for (const [path, id] of cases) {
    const last = resolveBreadcrumbs(path).at(-1);
    assert.equal(last?.id, id, `${path} → ${JSON.stringify(last)}`);
  }
});

test('the four work-graph routes read "Work graph", never the raw slug', () => {
  const cases: Array<[string, string[]]> = [
    ['/iq/activity', ['Operate', 'Work graph']],
    ['/pipelines/activity', ['Runs', 'Work graph']],
    ['/assessment/activity', ['Analyze', 'Work graph']],
    ['/social/work-graph', ['Library', 'Work graph']],
  ];
  for (const [path, labels] of cases) assert.deepEqual(resolveBreadcrumbs(path).map((c) => c.label), labels, path);
});

test('access records name their record after the list crumb (policies and review campaigns)', () => {
  const review = resolveBreadcrumbs('/access/reviews/rev-0001');
  assert.deepEqual(review.map((c) => c.label).slice(0, 2), ['Govern', 'Reviews']);
  assert.equal(review[1]?.path, '/access/reviews');
  assert.equal(review[2]?.id, 'rev-0001');
  const policy = resolveBreadcrumbs('/access/policies/sod-001');
  assert.equal(policy[1]?.path, '/access/policies');
  assert.equal(policy[2]?.id, 'sod-001');
  assert.equal(resolveBreadcrumbs('/access/reviews').length, 2);
});

test('Runbooks trails: Library, a runbook, Proposals and a proposal, Briefs and a brief', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/runbooks').map((c) => c.label), ['Build', 'Runbooks', 'Library']);
  const record = resolveBreadcrumbs('/iq/runbooks/rb-tenant-cutover');
  assert.deepEqual(record.map((c) => c.label), ['Build', 'Runbooks', 'Library', 'rb-tenan…']);
  assert.equal(record[3]?.id, 'rb-tenant-cutover');
  assert.deepEqual(resolveBreadcrumbs('/iq/runbooks/proposals').map((c) => c.label), ['Build', 'Runbooks', 'Proposals']);
  assert.equal(resolveBreadcrumbs('/iq/runbooks/proposals/prop-1')[2]?.path, '/iq/runbooks/proposals');
});


test('design breadcrumbs name the collection once', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/designs/des-obs-dashboards').map(c => c.label).slice(0, -1), ['Designs']);
});

test('Logging (G37): System › Logging › the record, whatever the source and kind', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/logging'), [{ label: 'System' }, { label: 'Logging' }]);
  assert.deepEqual(resolveBreadcrumbs('/iq/logging/agents'), [{ label: 'System' }, { label: 'Logging' }]);
  assert.deepEqual(resolveBreadcrumbs('/iq/logging/voice/vs_1'), [{ label: 'System' }, { label: 'Logging', path: '/iq/logging' }, { label: 'vs_1', id: 'vs_1' }]);
  assert.deepEqual(resolveBreadcrumbs('/iq/logging/jobs/sweep-runs/sr-1').map((c) => c.label), ['System', 'Logging', 'sr-1']);
});

test('Logging in the pipelines tenant (G37b): System › Logging › the record', () => {
  assert.deepEqual(resolveBreadcrumbs('/pipelines/logging'), [{ label: 'System' }, { label: 'Logging' }]);
  assert.deepEqual(resolveBreadcrumbs('/pipelines/logging/voice/vs_1'), [{ label: 'System' }, { label: 'Logging', path: '/pipelines/logging' }, { label: 'vs_1', id: 'vs_1' }]);
});

test('a run crumb names the record by its decoded id and never shows the raw id (walk, 9 November)', () => {
  // The run page registers its title under the router's decoded id; the crumb must carry the same id.
  assert.deepEqual(resolveBreadcrumbs('/iq/runs/agent-run%3A79eed77e-7aee'), [{ label: 'Operate' }, { label: 'Runs', path: '/iq/runs' }, { label: 'Run', id: 'agent-run:79eed77e-7aee' }]);
  // A malformed escape stays as written rather than throwing.
  assert.equal(resolveBreadcrumbs('/iq/decisions/50%25%zz').at(-1)?.id, '50%25%zz');
});

test('a round page reads <group> › <home> › <the round> › <page> by the viewer’s role (U6)', () => {
  const id = 'iv-k1p5w8ra';
  const round = { label: 'Round', path: `/interviews/rounds/${id}`, id };
  assert.deepEqual(resolveBreadcrumbs(`/interviews/rounds/${id}/room`, 'interviewer'),
    [{ label: 'Interview' }, { label: 'My interviews', path: '/interviews/my-interviews' }, round, { label: 'Room' }]);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/rounds/${id}/room`, 'recruiter'),
    [{ label: 'Hire' }, { label: 'Upcoming', path: '/interviews/upcoming' }, round, { label: 'Room' }]);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/rounds/${id}/scorecard`, 'hiring-manager'),
    [{ label: 'Hire' }, { label: 'My openings', path: '/interviews/my-openings' }, round, { label: 'Scorecard' }]);
  for (const [page, label] of [['prepare', 'Prepare'], ['record', 'Record'], ['debrief', 'Debrief']] as const) {
    assert.equal(resolveBreadcrumbs(`/interviews/rounds/${id}/${page}`, 'admin').at(-1)!.label, label);
  }
  // A finished round's record and scorecard hang under Candidates for the recruiter, not under Upcoming.
  assert.deepEqual(resolveBreadcrumbs(`/interviews/rounds/${id}/record`, 'recruiter'),
    [{ label: 'Hire' }, { label: 'Candidates', path: '/interviews/candidates' }, round, { label: 'Record' }]);
  // An unknown round page keeps the old trail rather than inventing a crumb.
  assert.deepEqual(resolveBreadcrumbs(`/interviews/rounds/${id}/elsewhere`, 'interviewer').map((c) => c.label), ['Hire', 'Round']);
});

test('an opening beside the Openings rail has Hire, Openings and its own crumb, and Edit after it on the editor', () => {
  const open = { label: 'Openings', path: '/interviews/openings' };
  assert.deepEqual(resolveBreadcrumbs('/interviews/openings/op-backend', 'recruiter'),
    [{ label: 'Hire' }, open, { label: 'op-backend', id: 'op-backend' }]);
  assert.deepEqual(resolveBreadcrumbs('/interviews/openings/op-backend/edit', 'recruiter'),
    [{ label: 'Hire' }, open, { label: 'op-backend', path: '/interviews/openings/op-backend', id: 'op-backend' }, { label: 'Edit' }]);
});

test('a candidate page reads its home by the viewer’s role, and assign / debrief end the trail', () => {
  const id = 'cand-qz63q3a3';
  // An id-shaped segment shows shortened until the page names it (as the random interview ids do).
  const name = { label: 'cand-qz6…', id };
  const linked = { ...name, path: `/interviews/candidates/${id}` };
  assert.deepEqual(resolveBreadcrumbs(`/interviews/candidates/${id}`, 'recruiter'),
    [{ label: 'Hire' }, { label: 'Candidates', path: '/interviews/candidates' }, name]);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/candidates/${id}`, 'admin').map((c) => c.label), ['Hire', 'Candidates', 'cand-qz6…']);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/candidates/${id}`, 'hiring-manager'),
    [{ label: 'Hire' }, { label: 'My openings', path: '/interviews/my-openings' }, name]);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/candidates/${id}`, 'interviewer'),
    [{ label: 'Interview' }, { label: 'My interviews', path: '/interviews/my-interviews' }, name]);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/candidates/${id}/assign`, 'recruiter'),
    [{ label: 'Hire' }, { label: 'Candidates', path: '/interviews/candidates' }, linked, { label: 'Assign a round' }]);
  assert.deepEqual(resolveBreadcrumbs(`/interviews/candidates/${id}/debrief`, 'hiring-manager'),
    [{ label: 'Hire' }, { label: 'My openings', path: '/interviews/my-openings' }, linked, { label: 'Debrief' }]);
  // No role keeps the recruiter's home; the add-a-candidate form is not a candidate.
  assert.equal(resolveBreadcrumbs(`/interviews/candidates/${id}`).at(-2)!.label, 'Candidates');
});
