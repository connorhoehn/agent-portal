// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactAge, explorerGroups, explorerRows, explainPrompt, filterLoaded, itemTypeLabel, loadedLabel,
  recencyGroup, recordCrumbs, recordHistory, recordStatus, searchScopeNote, shortRepo, technicalDetails,
  withoutStepsSection, approachHint, approachSteps, basedOnRows, guidePrompt, DEFAULT_GUIDE_CONTEXT,
  EXPLAIN_GUIDE_INSTRUCTION, GUIDE_CONTEXT_LABEL, GUIDE_CONTEXT_OPTIONS, PLAN_PREFILL,
} from '../knowledgeModel.ts';
import type { GuideView, Item } from '../types.ts';

const NOW = Date.parse('2026-09-24T12:00:00Z');

const GUIDE: Item = {
  level: 'L2', id: 'art-001', type: 'runbook', title: 'Troubleshoot a flaky CI test', summary: 's',
  body_markdown: '# x', cluster_ids: ['cl-019'], facts: ['f1'], library_item_id: 'skill-x', owner: 'Vera',
  classification: 'internal', status: 'published', reviewed_by: 'Mia', reviewed_at: '2026-09-24T09:00:00Z',
  last_used_at: null, confidence: 0.86, created_by_compaction_id: 'comp-1',
  created_at: '2026-09-24T08:00:00Z', updated_at: '2026-09-24T10:00:00Z',
};
const PATTERN: Item = {
  level: 'L1', id: 'cl-019', title: 'CI failures share a port', summary: 'Two tests bound one port.', kind: 'gotcha',
  repo: 'org/obs', initiative_id: 'p-obs', tags: [], member_observation_ids: ['obs-1', 'obs-2'], confidence: 0.87,
  created_by_compaction_id: 'comp-2', created_at: '2026-09-20T08:00:00Z', updated_at: '2026-09-20T08:00:00Z',
};
const NOTE: Item = {
  level: 'L0', id: 'obs-1', session_id: 'sess-1', box_id: 'box-1', repo: 'org/obs', initiative_id: 'p-obs',
  kind: 'failed', title: 'Tests collide in parallel', body: 'b', tags: ['ci'], created_at: '2026-09-01T08:00:00Z',
};

test('labels: type, crumbs, status pill per tier', () => {
  assert.equal(itemTypeLabel(GUIDE), 'Runbook');
  assert.equal(itemTypeLabel(PATTERN), 'Pattern');
  assert.equal(itemTypeLabel(NOTE), 'Run note');
  assert.deepEqual(recordCrumbs(GUIDE), ['Guides & findings', 'Runbook']);
  assert.deepEqual(recordCrumbs(NOTE), ['Run notes', 'Run note']);
  assert.deepEqual(recordStatus(GUIDE), { label: 'Published', tone: 'success' });
  assert.deepEqual(recordStatus(NOTE), { label: 'Failed', tone: 'error' });
  assert.equal(shortRepo('org/obs'), 'obs');
});

test('compact ages and recency groups', () => {
  assert.equal(compactAge('2026-09-24T10:00:00Z', NOW), '2h');
  assert.equal(compactAge('2026-09-24T11:59:40Z', NOW), 'now');
  assert.equal(compactAge('2026-09-20T12:00:00Z', NOW), '4d');
  assert.equal(compactAge(null, NOW), '');
  assert.equal(recencyGroup('2026-09-24T10:00:00Z', NOW), 'recent');
  assert.equal(recencyGroup('2026-09-20T08:00:00Z', NOW), 'week');
  assert.equal(recencyGroup('2026-09-01T08:00:00Z', NOW), 'older');
  assert.equal(recencyGroup('garbage', NOW), 'older');
});

test('explorer rows: newest first, quiet type · lifecycle · age line, grouped', () => {
  const rows = explorerRows([NOTE, GUIDE, PATTERN], {}, NOW);
  assert.deepEqual(rows.map((r) => r.id), ['art-001', 'cl-019', 'obs-1']);
  assert.equal(rows[0].subline, 'Runbook · Published · 2h');
  assert.equal(rows[0].fileKind, 'page');
  assert.equal(rows[1].subline, 'Pattern · Gotcha · 4d');
  assert.deepEqual(explorerGroups(rows).map((g) => [g.id, g.count]), [['recent', 1], ['week', 1], ['older', 1]]);
});

test('client-side filters apply to loaded rows only', () => {
  assert.deepEqual(filterLoaded([GUIDE, PATTERN], { kind: 'runbook' }).map((i) => i.id), ['art-001']);
  assert.deepEqual(filterLoaded([GUIDE], { lifecycle: 'draft' }), []);
  assert.deepEqual(filterLoaded([PATTERN, NOTE], { kind: 'failed' }).map((i) => i.id), ['obs-1']);
});

test('footer: "N of M loaded" only with a server total; a client filter says what it covers', () => {
  assert.equal(loadedLabel('guides', 11, 11, 11, false, false), '11 guides & findings');
  assert.equal(loadedLabel('notes', 1, 1, 1, false, false), '1 run note');
  assert.equal(loadedLabel('notes', 50, 50, 304, true, false), '50 of 304 loaded');
  assert.equal(loadedLabel('notes', 50, 50, null, true, false), '50 loaded', 'unknown total is never invented');
  assert.equal(loadedLabel('notes', 50, 3, 304, true, true), '3 shown · filter applies to 50 loaded');
  assert.equal(searchScopeNote('patterns', 'org/obs'), 'Searches patterns in obs only');
});

test('a procedure renders its steps once: the markdown Steps section is removed, Why stays', () => {
  const md = '## Steps\n1. Flag it.\n2. Flip it.\n\n## Why\n- Because.';
  assert.equal(withoutStepsSection(md), '## Why\n- Because.');
  assert.equal(withoutStepsSection('## Why\nonly'), '## Why\nonly');
  assert.equal(withoutStepsSection('Intro\n\n### Steps\n1. a\n## Next\nb'), 'Intro\n\n## Next\nb');
});

test('history and technical details come from the record fields only', () => {
  const h = recordHistory(GUIDE);
  assert.deepEqual(h.map((e) => e.id), ['updated', 'reviewed', 'created']);
  assert.equal(h.find((e) => e.id === 'reviewed')?.actor, 'Mia');
  assert.deepEqual(recordHistory(NOTE).map((e) => e.id), ['written']);
  const td = technicalDetails(GUIDE);
  assert.equal(td[0].value, 'art-001');
  assert.ok(td.some((r) => r.label === 'Classification' && r.value === 'internal'));
  assert.ok(technicalDetails(NOTE).some((r) => r.label === 'Session' && r.value === 'sess-1'));
});

test('the composer prompt names its subject and asks for an explanation only', () => {
  const p = explainPrompt('', { kind: 'runbook', id: 'art-001', title: 'T' });
  assert.match(p, /Explain this record/);
  assert.match(p, /\(art-001\)/);
  assert.match(p, /do not change anything/);
});

// ── Guide record ─────────────────────────────────────────────────────────

const GUIDE_VIEW: GuideView = {
  approach: [
    { step_id: 'fact-020', ordinal: 3, text: 'Switch one customer and verify sign-in.' },
    { step_id: 'fact-018', ordinal: 1, text: 'Keep the existing sign-in available as a fallback.' },
    { step_id: 'fact-019', ordinal: 2, text: 'Check that active sessions stay signed in.' },
    { step_id: 'fact-021', ordinal: 4, text: 'Restore the previous sign-in if the checks fail.' },
  ],
  based_on: [
    { id: 'cl-010', kind: 'cluster', title: 'Retire the SAML shim tenant by tenant', repo: 'connorhoehnslalom/orgiq-auth-service', repo_label: 'auth-service' },
    { id: 'cl-099', kind: 'cluster', title: 'No repo pattern', repo: null, repo_label: null },
  ],
  run_warning: {
    run_id: 'papp-006', outcome: 'failed', at: '2026-09-23T10:00:00Z', failed_at_ordinal: 3,
    title: 'Check the redirect before you use this',
    body: 'The last attempt stopped at step 3 because sign-in still pointed to the old service.',
  },
};
const SUBJECT = {
  id: 'art-010', title: 'Cut one tenant over from SAML to Cognito',
  when_this_helps: 'Planning to move a sign-in?\nIt brings together steps.',
};

test('guide context options: three, labelled, guide by default', () => {
  assert.equal(DEFAULT_GUIDE_CONTEXT, 'guide');
  assert.deepEqual(GUIDE_CONTEXT_OPTIONS.map((o) => o.label), ['This guide', 'This guide + sources', 'No context']);
  assert.deepEqual(GUIDE_CONTEXT_OPTIONS.map((o) => o.value), ['guide', 'guide+sources', 'none']);
  assert.equal(GUIDE_CONTEXT_LABEL['guide+sources'], 'This guide + sources');
});

test('plan prefill ends ready for the reader to type their project', () => {
  assert.equal(PLAN_PREFILL, 'Draft a plan for my project using this guide. My project: ');
});

test('approachSteps orders by ordinal, carries no status; hint counts them', () => {
  const steps = approachSteps(GUIDE_VIEW);
  assert.deepEqual(steps.map((s) => s.id), ['fact-018', 'fact-019', 'fact-020', 'fact-021']);
  assert.equal(steps[0].title, 'Keep the existing sign-in available as a fallback.');
  assert.equal(steps.some((s) => 'status' in s), false);
  assert.deepEqual(approachSteps(undefined), []);
  assert.equal(approachHint(steps.length), '4 steps');
  assert.equal(approachHint(1), '1 step');
});

test('basedOnRows: "Source pattern · <repo_label>", opening the pattern', () => {
  const rows = basedOnRows(GUIDE_VIEW);
  assert.equal(rows[0].title, 'Retire the SAML shim tenant by tenant');
  assert.equal(rows[0].kindLabel, 'Source pattern');
  assert.equal(rows[0].meta, 'Source pattern · auth-service');
  assert.equal(rows[0].href, '/iq/distillation/knowledge?view=patterns&item=cl-010');
  assert.equal(rows[1].meta, 'Source pattern', 'no repo, no dangling separator');
  assert.deepEqual(basedOnRows(null), []);
});

test('guidePrompt "guide": title, id, when-this-helps, numbered approach, the guard', () => {
  const p = guidePrompt('Explain it', SUBJECT, GUIDE_VIEW, 'guide');
  assert.ok(p.startsWith('Explain it\n\nAbout the distillation guide "Cut one tenant over from SAML to Cognito" (art-010).'));
  assert.match(p, /When this helps: Planning to move a sign-in\? It brings together steps\./);
  assert.match(p, /Approach:\n1\. Keep the existing sign-in available as a fallback\.\n2\. Check/);
  assert.match(p, /4\. Restore the previous sign-in if the checks fail\./);
  assert.ok(!p.includes('Based on'), 'sources only with guide+sources');
  assert.ok(!p.includes('Last run'));
  assert.ok(p.endsWith('Explain only; do not change anything.'));
  assert.equal(guidePrompt('Explain it', SUBJECT, GUIDE_VIEW), p, 'guide is the default');
});

test('guidePrompt "guide+sources" adds the patterns and the run warning', () => {
  const p = guidePrompt('x', SUBJECT, GUIDE_VIEW, 'guide+sources');
  assert.match(p, /Based on: "Retire the SAML shim tenant by tenant" \(auth-service\), "No repo pattern"/);
  assert.match(p, /Last run: Check the redirect before you use this — The last attempt stopped at step 3/);
  assert.ok(p.endsWith('Explain only; do not change anything.'));
});

test('guidePrompt "none" carries no record, keeps the guard; blank falls back to explain', () => {
  assert.equal(guidePrompt(' plan my thing ', SUBJECT, GUIDE_VIEW, 'none'), 'plan my thing\n\nExplain only; do not change anything.');
  assert.ok(guidePrompt('  ', SUBJECT, GUIDE_VIEW).startsWith(EXPLAIN_GUIDE_INSTRUCTION));
});

test('guidePrompt without a guide view (older middleware, non-procedure) still names the record', () => {
  const p = guidePrompt('q', { id: 'art-001', title: 'T', kind: 'runbook' }, undefined, 'guide+sources');
  assert.equal(p, 'q\n\nAbout the distillation runbook "T" (art-001).\nExplain only; do not change anything.');
});
