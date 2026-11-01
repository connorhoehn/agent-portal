import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineComposerPolicy, tenantComposerPolicy } from './ui-dom-audit.policies.ts';

test('all inspected collections require input even when empty', () => {
  for (const path of ['', '/runs', '/runs/abc', '/definitions', '/queues', '/runbooks', '/artifacts', '/approvals', '/agents', '/bots', '/commands']) {
    assert.deepEqual(pipelineComposerPolicy(`/pipelines${path}`), { mode: 'required' });
  }
});
test('contextual exceptions require positive evidence and cannot exempt another route', () => {
  const views = [
    ['/activity', { graph: true }], ['/communication', { communicationOverview: true }],
    ['/communication', { socialAccessRequired: true }], ['/configuration', { configurationForm: true }],
    ['/settings', { settingsPlaceholder: true }],
  ] as const;
  for (const [path, evidence] of views) {
    assert.equal(pipelineComposerPolicy(`/pipelines${path}`), undefined);
    assert.equal(pipelineComposerPolicy(`/pipelines${path}`, evidence)?.mode, 'exempt');
    assert.equal(pipelineComposerPolicy('/pipelines/unknown', evidence), undefined);
    assert.equal(pipelineComposerPolicy('/pipelines/runs', evidence)?.mode, 'required');
  }
});
test('loaded reports require composers; verified unavailable records are distinct', () => {
  assert.equal(pipelineComposerPolicy('/pipelines/decks/report')?.mode, 'required');
  assert.equal(pipelineComposerPolicy('/pipelines/decks/report', { missingDeck: true })?.mode, 'exempt');
});
test('only a verified missing run can omit its discussion composer', () => {
  assert.equal(pipelineComposerPolicy('/pipelines/runs/does-not-exist')?.mode, 'required');
  assert.equal(pipelineComposerPolicy('/pipelines/runs/does-not-exist', { missingRun: true })?.mode, 'exempt');
  assert.equal(pipelineComposerPolicy('/pipelines/runs/loaded', { missingRun: false })?.mode, 'required');
  assert.equal(pipelineComposerPolicy('/pipelines/runs', { missingRun: true })?.mode, 'required');
  assert.equal(pipelineComposerPolicy('/pipelines/approvals', { missingRun: true })?.mode, 'required');
});
test('the submission wizard needs its route, query and visible form; collection states remain required', () => {
  const spec = { tenant: 'assessment', path: '/assessment/submissions?view=add', kind: 'page', judges: ['table'] };
  assert.equal(tenantComposerPolicy(spec, { submissionWizard: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy(spec, {})?.mode, 'required');
  for (const evidence of [{ collection: true }, { table: true }, { composer: true }]) {
    assert.equal(tenantComposerPolicy(spec, { submissionWizard: true, ...evidence })?.mode, 'required');
  }
  for (const path of ['/assessment/submissions', '/assessment/submissions?view=list', '/assessment/runs?view=add']) {
    assert.equal(tenantComposerPolicy({ ...spec, path }, { submissionWizard: true })?.mode, 'required');
  }
});
test('unknown tenant routes never inherit a blanket exemption', () => {
  assert.equal(pipelineComposerPolicy('/iq/settings', { settingsPlaceholder: true }), undefined);
  assert.equal(pipelineComposerPolicy('/pipelines/new-page'), undefined);
});

test('tenant policy: list pages and visible composers are required before any exemption applies', () => {
  const list = { tenant: 'orgiq', path: '/admin/observability/invocations', kind: 'page', judges: ['cascade', 'type-scale', 'table'] };
  assert.deepEqual(tenantComposerPolicy(list, { charts: true, form: true }), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'assessment', path: '/assessment/workspace', kind: 'page' }, { composer: true, charts: true }), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/bots', kind: 'page' }, { collection: true, charts: true }), { mode: 'required' });
  // A table page is a collection even with no collection toolbar yet; a record's supporting tables are not.
  assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/ingest/sources', kind: 'page' }, { table: true }), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/ingest/sources', kind: 'page' }, { table: true, charts: true, tableSearch: true }), { mode: 'required' });
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/bots/b-1', kind: 'record' }, { table: true })?.mode, undefined);
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/bots/b-1', kind: 'record' }, { table: true, recordDetail: true })?.mode, 'exempt');
});
test('tenant policy: exemptions need positive evidence and never come from the composer being absent', () => {
  const page = { tenant: 'orgiq', path: '/admin/observability/cost', kind: 'page' };
  assert.equal(tenantComposerPolicy(page, {}), undefined);
  assert.equal(tenantComposerPolicy(page, { charts: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'social', path: '/social/rooms', kind: 'chat' }, { chatDirectory: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/activity', kind: 'page' }, { graph: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/settings', kind: 'page' }, { form: true })?.mode, 'exempt');
  // A record is exempt only on evidence of a detail pane or an observed 404; a bare record kind is not enough.
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/agents/orgiq-supervisor', kind: 'record' }, {}), undefined);
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/work/job-missing', kind: 'record' }, { missingRecord: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/work/job-missing', kind: 'page' }, { missingRecord: true }), undefined);
});
test('tenant policy: decks and communication follow the pipelines rules; pipelines routes are not its business', () => {
  assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/decks/deck-1', kind: 'editor' }, {}), { mode: 'required' });
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/decks/deck-missing', kind: 'editor' }, { missingDeck: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'assessment', path: '/assessment/communication', kind: 'chat' }, { communicationOverview: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'assessment', path: '/assessment/communication', kind: 'chat' }, {}), undefined);
  assert.equal(tenantComposerPolicy({ tenant: 'pipelines', path: '/pipelines/runs', kind: 'list', judges: ['table'] }, {}), undefined);
  // A pipelines record opened by a row probe (the list rail and its composer visible) is classified by evidence.
  assert.equal(tenantComposerPolicy({ tenant: 'pipelines', path: '/pipelines/definitions/bot:x', kind: 'record' }, { listRail: true, composer: true })?.mode, 'required');
  for (const policy of [tenantComposerPolicy({ tenant: 'social', path: '/social/calls', kind: 'chat' }, { chatDirectory: true })]) {
    assert.ok(policy && policy.mode === 'exempt' && policy.reason.trim().length > 40);
  }
});

test('tenant policy: dashboards stay exempt unless their table is searchable; list rails and reviewed empty collections are required', () => {
  const dash = { tenant: 'orgiq', path: '/admin/observability/cost', kind: 'page' };
  assert.equal(tenantComposerPolicy(dash, { charts: true, table: true })?.mode, 'exempt');
  assert.deepEqual(tenantComposerPolicy(dash, { charts: true, table: true, tableSearch: true }), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/runbooks', kind: 'page' }, { listRail: true, charts: true }), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/observability/sessions', kind: 'page' }, { charts: true }), { mode: 'required' });
  assert.equal(tenantComposerPolicy({ tenant: 'social', path: '/social/profile', kind: 'page' }, { placeholder: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'social', path: '/social/configuration', kind: 'page' }, { settingsSurface: true, table: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/admin/devbox', kind: 'page' }, { lab: true })?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/prompt-ops', kind: 'page' }, {})?.mode, 'exempt');
  assert.equal(tenantComposerPolicy({ tenant: 'orgiq', path: '/iq/prompt-ops', kind: 'page' }, { table: true })?.mode, 'required');
});

test('runbooks policy: the library, proposals, briefs and their records require the composer, whatever the evidence', () => {
  for (const path of ['/iq/runbooks', '/iq/runbooks/proposals', '/iq/runbooks/briefs', '/iq/runbooks/rb-tenant-cutover', '/iq/runbooks/proposals/prop-0002', '/iq/runbooks/briefs/job-0002']) {
    assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path, kind: 'record' }, {}), { mode: 'required' }, path);
    assert.deepEqual(tenantComposerPolicy({ tenant: 'orgiq', path, kind: 'record' }, { missingRecord: true, form: true, placeholder: true }), { mode: 'required' }, path);
  }
});

test('access policy: every list route and the request record require the composer, even with no evidence', () => {
  for (const path of ['/access/catalog', '/access/requests', '/access/approvals', '/access/policies', '/access/reviews', '/access/audit']) {
    assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path, kind: 'list' }, {}), { mode: 'required' }, path);
    // A list page cannot be exempted by form or placeholder evidence.
    assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path, kind: 'list' }, { form: true, placeholder: true, settingsSurface: true }), { mode: 'required' }, path);
  }
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/requests/req-0001', kind: 'record', pattern: '/access/requests/:id' }, {}), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/requests/req-0001', kind: 'record' }, { recordDetail: true }), { mode: 'required' });
  assert.equal(tenantComposerPolicy({ tenant: 'access', path: '/access/requests/req-missing', kind: 'record' }, { missingRecord: true })?.mode, 'exempt');
});
test('access policy: a review campaign record requires the composer; only its 404 state is exempt (lane A2)', () => {
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/reviews/rev-0001', kind: 'record', pattern: '/access/reviews/:id' }, {}), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/reviews/rev-0001', kind: 'record' }, { recordDetail: true, table: true }), { mode: 'required' });
  // Exemption evidence of another kind never excuses it.
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/reviews/rev-0001', kind: 'record' }, { form: true, placeholder: true, settingsSurface: true }), { mode: 'required' });
  const missing = tenantComposerPolicy({ tenant: 'access', path: '/access/reviews/rev-9999', kind: 'record' }, { missingRecord: true });
  assert.equal(missing?.mode, 'exempt');
  assert.match(missing && missing.mode === 'exempt' ? missing.reason : '', /404/);
});

test('access policy: a policy record requires the composer (its list rail docks one); only its not-found state is exempt', () => {
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/policies/sod-001', kind: 'record', pattern: '/access/policies/:id' }, {}), { mode: 'required' });
  assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path: '/access/policies/sod-001', kind: 'record' }, { form: true, placeholder: true, settingsSurface: true }), { mode: 'required' });
  assert.equal(tenantComposerPolicy({ tenant: 'access', path: '/access/policies/sod-999', kind: 'record' }, { missingRecord: true })?.mode, 'exempt');
});

test('access policy: the wizard, configuration and settings are exempt only on their own evidence', () => {
  const views = [
    ['/access/requests/new', { form: true }],
    ['/access/configuration', { settingsSurface: true }],
    ['/access/settings', { settingsSurface: true }],
  ] as const;
  for (const [path, evidence] of views) {
    assert.equal(tenantComposerPolicy({ tenant: 'access', path, kind: 'page' }, {}), undefined, path);
    const policy = tenantComposerPolicy({ tenant: 'access', path, kind: 'page' }, evidence);
    assert.ok(policy && policy.mode === 'exempt' && policy.reason.trim().length > 40, path);
    // A visible composer or collection outranks the exemption.
    assert.deepEqual(tenantComposerPolicy({ tenant: 'access', path, kind: 'page' }, { ...evidence, composer: true }), { mode: 'required' }, path);
  }
  // Evidence never travels to another route.
  assert.equal(tenantComposerPolicy({ tenant: 'access', path: '/access/settings', kind: 'page' }, { form: true }), undefined);
  assert.equal(tenantComposerPolicy({ tenant: 'access', path: '/access/requests/new', kind: 'page' }, { placeholder: true }), undefined);
  assert.equal(tenantComposerPolicy({ tenant: 'access', path: '/access/unknown', kind: 'page' }, { form: true, placeholder: true, settingsSurface: true }), undefined);
});

test('configuration without editing controls needs positive read-only setting evidence', () => {
  assert.equal(pipelineComposerPolicy('/pipelines/configuration'), undefined);
  assert.equal(pipelineComposerPolicy('/pipelines/configuration', { configurationReadOnly: true })?.mode, 'exempt');
  assert.deepEqual(pipelineComposerPolicy('/pipelines/runs', { configurationReadOnly: true }), { mode: 'required' });
});
