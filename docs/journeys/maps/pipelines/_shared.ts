// Shared pieces of the pipelines family's maps (docs/pipelines-journeys/PROTOCOL.md).
// Not a map: files starting with `_` are fragments the maps import. Each
// surface's steps are written once here, parameterised by what the role may
// do (the goal doc's Cedar table, as /api/session/capabilities reports it):
//
//   author          ViewPipelines, AuthorDefinition, RunPipeline
//   operator        ViewPipelines, RunPipeline, ApproveStep, CancelRun
//   pipeline-admin  ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig
//   admin           every action (u-operator entering the Pipelines workspace)
//
// so the four roles' maps differ only where the separation of duties says they
// must. Every map walks as a CLONE of its persona on the shared mock and writes
// nothing: the write probes carry bodies (or ids) the routes reject even past
// the gate, and each states the status this role gets.
import type { Persona, Step, Target } from '../../../../scripts/journeys/journey-map.ts';

export type PipelinesRole = 'author' | 'operator' | 'pipeline-admin' | 'admin';

export const PERSONA: Record<PipelinesRole, Persona> = {
  author: { user: 'u-ines', name: 'Ines Moreau', tenant: 'pipelines', role: 'author' },
  operator: { user: 'u-kofi', name: 'Kofi Mensah', tenant: 'pipelines', role: 'operator' },
  'pipeline-admin': { user: 'u-dara', name: 'Dara Whitfield', tenant: 'pipelines', role: 'pipeline-admin' },
  // u-operator lands in Work; the protocol walks it after entering the Pipelines workspace (a clone's own epoch).
  admin: { user: 'u-operator', name: 'Platform Operator', tenant: 'pipelines', role: 'admin', switchTenant: true },
};

const approves = (r: PipelinesRole) => r !== 'author';
const cancels = (r: PipelinesRole) => r !== 'author';
const configures = (r: PipelinesRole) => r === 'pipeline-admin' || r === 'admin';
const authors = (r: PipelinesRole) => r === 'author' || r === 'admin';

/** The bot-sourced run every run-detail walk opens (an in-flight marketplace run with steps, an artifact and events). */
export const RUN = '/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3';

/** A link in the shell's navigation (the pipelines rail), by its exact name. */
export const rail = (name: string): Target => ({ role: 'link', name, exact: true, within: { css: '[data-shell-nav]' } });
const rows = (testId: string): Target => ({ css: 'tbody tr', within: { testId } });
const firstRow = (testId: string): Target => ({ css: 'tbody tr', within: { testId }, nth: 0 });
const search = (name: string): Target => ({ role: 'textbox', name, exact: true });
const NOT_FOUND = /404|Not Found/i;
const RUN_LOADED: Target = { testId: 'pipeline-steps' };
const DEF_LOADED: Target = { text: 'Approved by', exact: true, within: { testId: 'pipelines-definition-record' } };
const RESTING = { audit: false as const, auditReason: 'the same resting state the first step measured' };

const RAIL = ['Definitions', 'Runbooks', 'Runs', 'Approvals', 'Artifacts', 'Agents', 'Bots', 'Commands'];
/** Controls no list page offers any role: deciding and cancelling live on a record, and nobody creates a definition here. */
const LIST_ABSENT: Target[] = [{ testId: 'pipelines-approval-approve' }, { testId: 'pipelines-approval-reject' }, { testId: 'pipeline-run-cancel' }, { role: 'button', name: /New definition/ }];

/** The rail as this role sees it (Configuration for pipeline-admin and admin only), and no decide/cancel/new control on a list. */
export function railGating(role: PipelinesRole, url: string): Step {
  const present = [...RAIL, ...(configures(role) ? ['Configuration'] : [])];
  return {
    do: 'navigate', url, ...RESTING,
    name: `The rail shows ${present.join(', ')}${configures(role) ? '' : ' and no Configuration'}; no Approve, Reject, Cancel run or New definition on the list`,
    proves: 'role-gating',
    expect: { visible: present.map(rail), absent: [...(configures(role) ? [] : [rail('Configuration')]), ...LIST_ABSENT] },
  };
}

/** The four invalid-body write probes of the hand walks: 403 where Cedar refuses the role, a 4xx past the gate where it holds the action. */
export function writeProbes(role: PipelinesRole): Step[] {
  const st = {
    config: configures(role) ? 400 : 403,
    approvers: authors(role) ? 400 : 403,
    decide: approves(role) ? 400 : 403,
    cancel: cancels(role) ? 404 : 403,
  };
  const why = (s: number, action: string) => (s === 403 ? `refused: this role lacks ${action}` : `past the gate (${action} held), the request is rejected and nothing is written`);
  return [
    { do: 'api', method: 'PUT', url: '/api/pipelines/configuration', body: {}, refusal: 'an empty body names no default approver role, which the route rejects (400) even past the gate', name: `PUT /api/pipelines/configuration {} answers ${st.config}: ${why(st.config, 'ManagePipelineConfig')}`, proves: 'role-gating', expect: { status: st.config } },
    { do: 'api', method: 'PUT', url: '/api/pipelines/definitions/no-such-definition/approvers', body: {}, refusal: 'the definition does not exist and the body names no roles, which the route rejects even past the gate', name: `PUT …/definitions/no-such-definition/approvers {} answers ${st.approvers}: ${why(st.approvers, 'AuthorDefinition')}`, proves: 'role-gating', expect: { status: st.approvers } },
    { do: 'api', method: 'POST', url: '/api/pipelines/approvals/no-such-step/decide', body: {}, refusal: 'no waiting step has this id and the body carries no decision, which the route rejects even past the gate', name: `POST …/approvals/no-such-step/decide {} answers ${st.decide}: ${why(st.decide, 'ApproveStep')}`, proves: 'role-gating', expect: { status: st.decide } },
    { do: 'api', method: 'POST', url: '/api/pipelines/runs/no-such-run/cancel', body: {}, refusal: 'no run has this id, so past the gate the route answers 404 and cancels nothing', name: `POST …/runs/no-such-run/cancel {} answers ${st.cancel}: ${why(st.cancel, 'CancelRun')}`, proves: 'role-gating', expect: { status: st.cancel } },
  ];
}

const tabWalk = (min: number): Step => ({ do: 'tab-walk', name: 'Tab from the top of the page through every control', proves: 'keyboard', expect: { minVisited: min } });
// The preceding keyboard walk can open About. Filtering moves focus into the
// search box; the final filtered state must also finish closing that card.
const searchEmpty = (box: string, sentence: string): Step => ({
  do: 'fill', target: search(box), value: 'zzzzqq', name: `Search for zzzzqq: the table says "${sentence}"`, state: 'filtered-empty', proves: 'empty-state', expect: { text: [sentence], hidden: [{ testId: 'page-header-description-card' }] },
});
const searchClear = (box: string, table: string): Step => ({
  do: 'fill', target: search(box), value: '', name: 'Clear the search: the rows come back', ...RESTING, expect: { count: [{ target: rows(table), min: 1 }] },
});
/** Enter on the first row opens its record; the record is measured once it has loaded (the press step settles on the navigation, not the record's data). */
const enterRow = (table: string, opens: RegExp, what: string, loaded: Target): Step[] => [
  { do: 'press', key: 'Enter', target: firstRow(table), name: `Press Enter on the first row: ${what}`, state: 'row-open', proves: 'keyboard', audit: false, auditReason: 'measured on the next step, once the record has loaded', expect: { url: opens } },
  { do: 'wait', target: loaded, name: 'The opened record has loaded', state: 'row-open', expect: { url: opens, visible: [loaded] } },
];
const back = (to: string): Step => ({ do: 'back', name: 'Browser Back returns to the list', proves: 'keyboard', expect: { url: to } });
const reload = (url: string, what: string): Step => ({ do: 'navigate', url, name: `Reload ${what}`, ...RESTING });
/** A path under a list page that no route holds: the shell's own Page not found. */
const pageNotFound = (url: string): Step => ({ do: 'navigate', url, name: `Open ${url}: the shell says Page not found`, state: 'not-found', proves: 'empty-state', expect: { text: ['Page not found'] } });

/** A list page and the three source registries share one shape. */
function listSurface(role: PipelinesRole, o: { url: string; title: string; table: string; box: string; empty: string; tab: number; opens: RegExp; what: string; loaded: Target; notFound?: Step }): Step[] {
  return [
    { do: 'navigate', url: o.url, name: `Open ${o.title}`, expect: { url: o.url, visible: [{ role: 'heading', name: o.title, level: 1 }], count: [{ target: rows(o.table), min: 1 }] } },
    railGating(role, o.url),
    tabWalk(o.tab),
    searchEmpty(o.box, o.empty),
    searchClear(o.box, o.table),
    reload(o.url, o.title),
    ...enterRow(o.table, o.opens, o.what, o.loaded),
    back(o.url),
    ...(o.notFound ? [o.notFound] : []),
    ...writeProbes(role),
  ];
}

const source = (role: PipelinesRole, s: 'agents' | 'bots' | 'commands', title: string): Step[] => listSurface(role, {
  url: `/pipelines/${s}`, title, table: `pipelines-source-${s}-table`, box: `Search ${s}`, empty: `No ${s} match "zzzzqq".`, tab: 8,
  opens: /^\/pipelines\/definitions\/.+/, what: 'its definition opens', loaded: DEF_LOADED, notFound: pageNotFound(`/pipelines/${s}/does-not-exist`),
});

export const SURFACES = {
  runs: (role: PipelinesRole): Step[] => listSurface(role, {
    url: '/pipelines/runs', title: 'Runs', table: 'pipelines-runs-table', box: 'Search loaded run titles', empty: 'No run matches these filters.', tab: 15,
    opens: /^\/pipelines\/runs\/.+/, what: 'the run opens as a page', loaded: RUN_LOADED,
  }),

  'run-detail': (role: PipelinesRole): Step[] => [
    { do: 'navigate', url: RUN, name: 'Open the in-flight bot-sourced run: its header, steps, artifacts and events',
      expect: { visible: [{ testId: 'pipeline-run' }, { testId: 'pipeline-steps' }, { testId: 'pipeline-artifacts' }, { testId: 'pipeline-events' }], count: [{ target: rows('pipeline-steps'), min: 3 }, { target: rows('pipeline-artifacts'), min: 1 }] } },
    { do: 'wait', target: { testId: 'pipeline-events' }, name: 'The events section lists the run’s step events without a refresh', ...RESTING, expect: { text: [/step\.(started|completed)|pipeline:step/] } },
    cancels(role)
      ? { do: 'navigate', url: RUN, ...RESTING, name: 'Cancel run is offered on a running run (this role holds CancelRun); no Approve or Reject', proves: 'role-gating', expect: { visible: [{ testId: 'pipeline-run-cancel' }], absent: [{ testId: 'pipelines-approval-approve' }, { testId: 'pipelines-approval-reject' }] } }
      : { do: 'navigate', url: RUN, ...RESTING, name: 'No Cancel run, Approve or Reject in the DOM (an author holds no CancelRun or ApproveStep)', proves: 'role-gating', expect: { absent: [{ testId: 'pipeline-run-cancel' }, { testId: 'pipelines-approval-approve' }, { testId: 'pipelines-approval-reject' }] } },
    ...(cancels(role) ? [
      { do: 'click', target: { testId: 'pipeline-run-cancel' }, name: 'Cancel run asks for confirmation first (nothing is cancelled)', state: 'dialog-open', expect: { visible: [{ role: 'dialog', name: 'Cancel this run?' }] } } satisfies Step,
      { do: 'press', key: 'Escape', name: 'Escape closes the dialog and focus returns to Cancel run', proves: 'keyboard', expect: { hidden: [{ role: 'dialog', name: 'Cancel this run?' }], focused: { testId: 'pipeline-run-cancel' } } } satisfies Step,
    ] : []),
    tabWalk(8),
    { do: 'navigate', url: '/pipelines/runs/does-not-exist', name: 'Open /pipelines/runs/does-not-exist: the page says Run not found', state: 'not-found', proves: 'empty-state', expectConsole: NOT_FOUND, expect: { visible: [{ testId: 'pipeline-run-missing' }], text: ['Run not found'] } },
    ...writeProbes(role),
  ],

  artifacts: (role: PipelinesRole): Step[] => listSurface(role, {
    url: '/pipelines/artifacts', title: 'Artifacts', table: 'pipelines-artifacts-table', box: 'Search artifacts', empty: 'No artifacts match these filters.', tab: 12,
    opens: /^\/pipelines\/runs\/.+/, what: 'the run that produced it opens', loaded: RUN_LOADED,
  }),

  agents: (role: PipelinesRole): Step[] => source(role, 'agents', 'Agents'),
  bots: (role: PipelinesRole): Step[] => source(role, 'bots', 'Bots'),
  commands: (role: PipelinesRole): Step[] => source(role, 'commands', 'Commands'),

  configuration: (role: PipelinesRole): Step[] => configures(role) ? [
    { do: 'navigate', url: '/pipelines/configuration', name: 'Open Configuration: the default approver', expect: { url: '/pipelines/configuration', visible: [{ testId: 'pipelines-configuration' }, { role: 'heading', name: 'Configuration', level: 1 }] } },
    railGating(role, '/pipelines/configuration'),
    { do: 'navigate', url: '/pipelines/configuration', ...RESTING, name: 'The Default approver select is offered, and Save waits for a change', proves: 'role-gating', expect: { visible: [{ testId: 'pipelines-default-approver' }], disabled: [{ testId: 'pipelines-configuration-save' }] } },
    { do: 'navigate', url: '/pipelines/configuration', ...RESTING, name: 'The setting always has a value: the select holds a role, so there is no empty state to show', proves: 'empty-state', expect: { visible: [{ testId: 'pipelines-default-approver' }], noText: ['Configuration unavailable'] } },
    tabWalk(3),
    { do: 'api', url: '/api/pipelines/configuration', name: 'GET /api/pipelines/configuration answers 200', proves: 'role-gating', expect: { status: 200 } },
    ...writeProbes(role),
  ] : [
    { do: 'navigate', url: '/pipelines/configuration', name: 'Type /pipelines/configuration: the route sends this role to Runs', state: 'refused', proves: ['role-gating', 'empty-state'], expect: { urlNot: /^\/pipelines\/configuration/, url: '/pipelines/runs', absent: [{ testId: 'pipelines-configuration' }, { testId: 'pipelines-default-approver' }, { testId: 'pipelines-configuration-save' }] } },
    railGating(role, '/pipelines/runs'),
    tabWalk(10),
    { do: 'api', url: '/api/pipelines/configuration', name: 'GET /api/pipelines/configuration answers 200 (every role reads who approves by default)', proves: 'role-gating', expect: { status: 200 } },
    ...writeProbes(role),
  ],

  definitions: (role: PipelinesRole): Step[] => [
    { do: 'navigate', url: '/pipelines/definitions', name: 'Open Definitions', expect: { url: '/pipelines/definitions', visible: [{ role: 'heading', name: 'Definitions', level: 1 }], count: [{ target: rows('pipelines-definitions-table'), min: 1 }] } },
    railGating(role, '/pipelines/definitions'),
    tabWalk(12),
    searchEmpty('Search definitions', 'No definition matches this search and kind.'),
    searchClear('Search definitions', 'pipelines-definitions-table'),
    reload('/pipelines/definitions', 'Definitions'),
    ...enterRow('pipelines-definitions-table', /^\/pipelines\/definitions\/.+/, 'the definition opens beside the list', DEF_LOADED),
    authors(role)
      ? { do: 'wait', target: { testId: 'pipelines-definition-record' }, name: 'The definition offers the Approvers editor (this role holds AuthorDefinition)', proves: 'role-gating', expect: { visible: [{ testId: 'pipelines-approver-editor' }] } }
      : { do: 'wait', target: { testId: 'pipelines-definition-record' }, name: 'The definition is read-only for this role: no Approvers editor in the DOM', proves: 'role-gating', expect: { absent: [{ testId: 'pipelines-approver-editor' }] } },
    back('/pipelines/definitions'),
    { do: 'navigate', url: '/pipelines/definitions/does-not-exist', name: 'Open /pipelines/definitions/does-not-exist: the record says Definition not found', state: 'not-found', proves: 'empty-state', expectConsole: NOT_FOUND, expect: { text: ['Definition not found'] } },
    ...writeProbes(role),
  ],

  runbooks: (role: PipelinesRole): Step[] => [
    { do: 'navigate', url: '/pipelines/runbooks', name: 'Open Runbooks: each with its last dry-run', expect: { url: '/pipelines/runbooks', visible: [{ role: 'heading', name: 'Runbooks', level: 1 }], count: [{ target: rows('pipelines-runbooks-table'), min: 1 }] } },
    railGating(role, '/pipelines/runbooks'),
    // Every pipelines role holds RunPipeline, so every role is offered a dry-run on a runbook row.
    { do: 'navigate', url: '/pipelines/runbooks', ...RESTING, name: 'A Dry-run control is offered on the runbook rows (this role holds RunPipeline)', proves: 'role-gating', expect: { count: [{ target: { testId: 'pipelines-runbook-dry-run' }, min: 1 }] } },
    tabWalk(5),
    searchEmpty('Search runbooks', 'No runbooks match these filters.'),
    searchClear('Search runbooks', 'pipelines-runbooks-table'),
    reload('/pipelines/runbooks', 'Runbooks'),
    ...enterRow('pipelines-runbooks-table', /^\/pipelines\/definitions\/.+/, 'its definition opens', DEF_LOADED),
    back('/pipelines/runbooks'),
    pageNotFound('/pipelines/runbooks/does-not-exist'),
    ...writeProbes(role),
  ],

  approvals: (role: PipelinesRole): Step[] => [
    { do: 'navigate', url: '/pipelines/approvals', name: 'Open Approvals: the steps waiting on a person', expect: { url: '/pipelines/approvals', visible: [{ role: 'heading', name: 'Approvals', level: 1 }], count: [{ target: rows('pipelines-approvals-table'), min: 1 }] } },
    railGating(role, '/pipelines/approvals'),
    tabWalk(5),
    searchEmpty('Search approvals', 'No approvals match this search.'),
    searchClear('Search approvals', 'pipelines-approvals-table'),
    reload('/pipelines/approvals', 'Approvals'),
    ...enterRow('pipelines-approvals-table', /^\/pipelines\/approvals\/.+/, 'the waiting step opens', { testId: 'pipelines-approval-record' }),
    approves(role)
      ? { do: 'wait', target: { testId: 'pipelines-approval-record' }, name: 'The waiting step offers Approve and Reject (this role may decide it); pressing neither, nothing is decided', proves: 'role-gating', expect: { visible: [{ testId: 'pipelines-approval-approve' }, { testId: 'pipelines-approval-reject' }] } }
      : { do: 'wait', target: { testId: 'pipelines-approval-record' }, name: 'The waiting step is read-only: no Approve or Reject in the DOM, and the page says who decides', proves: 'role-gating', expect: { absent: [{ testId: 'pipelines-approval-approve' }, { testId: 'pipelines-approval-reject' }], text: ['Only an operator or a pipeline admin decides a step.'] } },
    back('/pipelines/approvals'),
    { do: 'navigate', url: '/pipelines/approvals/does-not-exist', name: 'Open /pipelines/approvals/does-not-exist: the page says Nothing is waiting here', state: 'not-found', proves: 'empty-state', expect: { text: ['Nothing is waiting here'] } },
    ...writeProbes(role),
  ],
} satisfies Record<string, (role: PipelinesRole) => Step[]>;

export type Surface = keyof typeof SURFACES;

export const PAGES: Record<Surface, string> = {
  runs: 'portal/src/pages/pipelines/RunsPage.tsx,portal/src/components/runs/RunsLedger.tsx,portal/src/lib/pipelineRuns.ts',
  'run-detail': 'portal/src/pages/pipelines/RunDetailPage.tsx,portal/src/pages/pipelines/PipelineRunLive.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts',
  artifacts: 'portal/src/pages/pipelines/ArtifactsPage.tsx',
  agents: 'portal/src/pages/pipelines/SourcesPage.tsx',
  bots: 'portal/src/pages/pipelines/SourcesPage.tsx',
  commands: 'portal/src/pages/pipelines/SourcesPage.tsx',
  configuration: 'portal/src/pages/pipelines/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx',
  definitions: 'portal/src/pages/pipelines/DefinitionsPage.tsx,portal/src/pages/pipelines/DefinitionRecord.tsx,portal/src/lib/pipelineDefinitions.ts',
  runbooks: 'portal/src/pages/pipelines/RunbooksPage.tsx,portal/src/lib/pipelineDefinitions.ts',
  approvals: 'portal/src/pages/pipelines/ApprovalsPage.tsx,portal/src/lib/pipelineDefinitions.ts',
};

const WHO: Record<PipelinesRole, string> = { author: 'Ines (author)', operator: 'Kofi (operator)', 'pipeline-admin': 'Dara (pipeline admin)', admin: 'The platform admin' };
const SURFACE_GOAL: Record<Surface, (r: PipelinesRole) => string> = {
  runs: () => 'reads every run, narrows the ledger to nothing and back, and opens one run from the keyboard',
  'run-detail': (r) => `reads one in-flight run end to end${cancels(r) ? ' and is offered Cancel run (and backs out)' : ', without a Cancel run control'}`,
  artifacts: () => 'reads what runs produced and opens the run behind one artifact',
  agents: () => 'reads the agent fleet registry, read-only, and opens one agent’s definition',
  bots: () => 'reads the bot registry, read-only, and opens one bot’s definition',
  commands: () => 'reads the assessment commands, read-only, and opens one command’s definition',
  configuration: (r) => (configures(r) ? 'reads the default approver, whose Save waits for a change' : 'has no Configuration: the rail and route refuse it, the read stays open'),
  definitions: (r) => `reads the definition catalog and opens one definition${authors(r) ? ', where the Approvers editor is offered' : ', read-only'}`,
  runbooks: () => 'reads the runbooks with their last dry-run, each offered a dry-run, and opens one',
  approvals: (r) => `reads what waits on a person and opens one step${approves(r) ? ', where Approve and Reject are offered (and neither is pressed)' : ', which is read-only for this role'}`,
};
export const goal = (role: PipelinesRole, s: Surface) => `${WHO[role]} ${SURFACE_GOAL[s](role)}`;

/** Claims a surface states other than `pass`: Configuration has no empty state (the setting always has a value, or the role never sees the page). */
export function claims(role: PipelinesRole, s: Surface): Record<string, string> | undefined {
  if (s === 'configuration') return { 'empty-state': configures(role) ? 'n/a — the setting always has a value' : 'n/a — this role is not shown the page at all' };
  return undefined;
}

// ── Isolation (PROTOCOL "Isolation logs") ─────────────────────────────────

const anchorsTo = (prefix: string): Target => ({ css: `a[href^="${prefix}"]` });
const FORBIDDEN = /403|Forbidden/i;
const PIPELINES_CONTENT = ['run-inflight-obs-e1-s3', 'Default approver'];
const away = (url: string, from: RegExp, field: string, noText: string[] = []): Step => ({
  do: 'navigate', url, name: `Type ${url}: the route sends this identity away`, state: 'refused', proves: field, expectConsole: FORBIDDEN,
  expect: { urlNot: from, ...(noText.length ? { noText } : {}) },
});
const forbidden = (url: string, field: string): Step => ({ do: 'api', url, name: `GET ${url} answers 403`, proves: field, expect: { status: 403 } });
const RID = 'bot-run%3Arun-inflight-obs-e1-s3';

/** Inbound: a role of another tenant meets the pipelines tenant (no grant in it). */
export function inbound(landing: string): Step[] {
  return [
    { do: 'navigate', url: '/select', name: 'The workspace chooser offers no Pipelines workspace', proves: 'pipelines-tile-visible', expect: { absent: [anchorsTo('/pipelines')], noText: [/Pipelines/] } },
    { do: 'navigate', url: landing, name: `The rail on ${landing} holds no link toward /pipelines`, proves: 'pipelines-nav-visible', expect: { absent: [anchorsTo('/pipelines')] } },
    away('/pipelines/runs', /^\/pipelines/, 'direct-route-result', PIPELINES_CONTENT),
    away(`/pipelines/runs/${RID}`, /^\/pipelines/, 'direct-route-result', PIPELINES_CONTENT),
    away('/pipelines/configuration', /^\/pipelines/, 'direct-route-result', PIPELINES_CONTENT),
    away('/pipelines/calls', /^\/pipelines/, 'direct-route-result', PIPELINES_CONTENT),
    { do: 'navigate', url: landing, name: 'Back on the home landing, still no link toward /pipelines', proves: 'pipelines-nav-visible', screenshot: 'log', expect: { absent: [anchorsTo('/pipelines')] } },
    forbidden('/api/pipelines/summary', 'api-status'),
    forbidden('/api/pipelines/runs', 'api-status'),
    forbidden(`/api/pipelines/runs/${RID}`, 'api-status'),
    forbidden(`/api/pipelines/runs/${RID}/steps`, 'api-status'),
    forbidden('/api/pipelines/artifacts', 'api-status'),
    { do: 'api', method: 'POST', url: '/api/session/tenant', body: { tenant: 'pipelines' }, refusal: 'a tenant switch only re-signs this clone’s own session cookie; it writes no business state, and it is refused (403) for an identity with no pipelines grant', name: 'POST /api/session/tenant {pipelines} is refused', proves: 'api-status', expect: { status: 403 } },
    forbidden(`/api/pipelines/runs/${RID}/events`, 'events-status'),
  ];
}
export const INBOUND_CLAIMS = { 'pipelines-tile-visible': 'no', 'pipelines-nav-visible': 'no', 'direct-route-result': 'redirect', 'api-status': '403', 'events-status': '403' };

/** Outbound: a pipelines role meets each other tenant. */
export function outbound(): Step[] {
  const foreign = ['/iq', '/admin', '/assessment', '/social', '/access'].map(anchorsTo);
  return [
    { do: 'navigate', url: '/pipelines/runs', name: 'The pipelines rail and page hold no link toward another tenant', proves: 'other-nav-visible', expect: { absent: foreign } },
    { do: 'navigate', url: '/select', name: 'The workspace chooser offers no other workspace', proves: 'other-nav-visible', expect: { absent: foreign } },
    away('/iq/projects', /^\/iq/, 'iq-route-result'),
    away('/iq/runs', /^\/iq/, 'iq-route-result'),
    away('/iq/search', /^\/iq/, 'iq-route-result'),
    forbidden('/api/bots', 'iq-api-status'),
    forbidden('/api/graph/people?limit=1', 'iq-api-status'),
    forbidden('/api/work/summary', 'iq-api-status'),
    forbidden('/api/runs', 'iq-api-status'),
    forbidden('/api/search?q=auth', 'iq-api-status'),
    away('/assessment/teams', /^\/assessment/, 'assessment-route-result'),
    away('/assessment/workspace?doc=page%3A100002', /^\/assessment/, 'assessment-route-result'),
    forbidden('/api/assessment/teams', 'assessment-api-status'),
    forbidden('/api/assessment/knowledge/tree', 'assessment-api-status'),
    forbidden('/api/assessment/pipeline-runs', 'assessment-api-status'),
    away('/social/channels', /^\/social/, 'social-route-result'),
    away('/social/dms', /^\/social/, 'social-route-result'),
    forbidden('/api/social/summary', 'social-api-status'),
    forbidden('/api/social/channels', 'social-api-status'),
    forbidden('/api/social/bindings?context=initiative%3Ap-auth-migration', 'social-api-status'),
    { do: 'navigate', url: '/pipelines/runs', name: 'Back on Runs, where every typed URL left this identity', screenshot: 'log', ...RESTING },
  ];
}
export const OUTBOUND_CLAIMS = Object.fromEntries(['iq', 'assessment', 'social'].flatMap((t) => [[`${t}-route-result`, 'redirect'], [`${t}-api-status`, '403']]).concat([['other-nav-visible', 'no']]));
export const ISOLATION_PAGES = 'portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx';
