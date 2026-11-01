// Shared pieces of the assessment family's maps (docs/assessment-journeys/PROTOCOL.md, judged by
// scripts/validate-assessment-tenant.sh). Not a map: files starting with `_` are fragments. Each surface's steps
// are written once here as a function of the role, so the four roles' maps differ only where their Cedar grants
// do (middleware/seeds/roles/assessment/*.cedar): the table CAPS below.
//
// Walked as CLONES of the seed personas (never the seed user), headless, read-only on the shared mock: every
// non-GET the page sends is blocked, except the two document-session calls READ_ONLY_POSTS names. Nothing here
// launches a run, records an answer, decides an exception, publishes or saves: those buttons are shown to exist
// (or not) for the role, and the dialogs they open are dismissed with Escape.
import type { JourneyMap, Persona, Step, Target } from '../../../../scripts/journeys/journey-map.ts';

export type Role = 'assessor' | 'lead-assessor' | 'program-lead' | 'admin';
export const ROLES: Role[] = ['assessor', 'lead-assessor', 'program-lead', 'admin'];

/** PROTOCOL "Sign in": assessor u-asha, lead-assessor u-jonas, program-lead u-farah, admin u-operator. u-jonas and u-farah land on their lower role, u-operator in orgiq. */
export const PERSONA: Record<Role, Persona> = {
  assessor: { user: 'u-asha', name: 'Asha Nair', tenant: 'assessment', role: 'assessor' },
  'lead-assessor': { user: 'u-jonas', name: 'Jonas Lindqvist', tenant: 'assessment', role: 'lead-assessor', switchRole: true },
  'program-lead': { user: 'u-farah', name: 'Farah Osei', tenant: 'assessment', role: 'program-lead', switchRole: true },
  admin: { user: 'u-operator', name: 'Platform Operator', tenant: 'assessment', role: 'admin', switchTenant: true },
};

/** The Cedar actions that change what a role sees (every role holds ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback). */
interface Caps { approve: boolean; publish: boolean; knowledge: boolean; config: boolean }
export const CAPS: Record<Role, Caps> = {
  assessor: { approve: false, publish: false, knowledge: false, config: false },
  'lead-assessor': { approve: true, publish: true, knowledge: true, config: false },
  'program-lead': { approve: true, publish: true, knowledge: true, config: true },
  admin: { approve: true, publish: true, knowledge: true, config: true },
};

/**
 * Opening a document posts twice, and neither writes a record a person authored:
 * the canvas grant (the document pane is the surface; blocked, it reads "Failed to fetch") and the viewer's presence.
 */
export const READ_ONLY_POSTS = [
  { path: '/api/assessment/knowledge/canvas', reason: 'mints the 120 s document-session grant the canvas connects with (routes/assessment-canvas.ts → providers/document-canvas.ts connectDocumentCanvas); for a document already imported it records nothing, and the documents walked here were imported by earlier walks' },
  { path: '/api/assessment/knowledge/presence', reason: 'announces this tab in the broker’s in-memory per-document roster, 45 s TTL (routes/assessment.ts POST /knowledge/presence → assessmentBroker.touch); no record is written' },
];

const NOT_FOUND = /404|Not Found/i;
const rail = (name: string): Target => ({ role: 'link', name, exact: true, within: { css: '[data-shell-nav]' } });
// Empty-state rows have one spanning cell. They are not evidence that records returned after a debounced search.
const rows = (testId: string): Target => ({ css: 'tbody tr:has(td:not([colspan]))', within: { testId } });
const search = (name: string): Target => ({ role: 'textbox', name, exact: true });
const resting = { audit: false as const, auditReason: 'the resting state the first step measured' };

export const tabWalk = (min: number): Step => ({ do: 'tab-walk', name: 'Tab from the top of the page through every control', proves: 'keyboard', expect: { minVisited: min } });
const searchEmpty = (box: string, sentence: string | RegExp): Step => ({
  do: 'fill', target: search(box), value: 'zzznoexist', name: `Search for zzznoexist: the page says "${sentence instanceof RegExp ? sentence.source : sentence}"`, state: 'filtered-empty', proves: 'empty-state', expect: { text: [sentence] },
});
const searchClear = (box: string, table: Target): Step => ({ do: 'fill', target: search(box), value: '', name: 'Clear the search: the rows come back', ...resting, expect: { visible: [{ ...table, nth: 0 }], count: [{ target: table, min: 1 }] } });
const enterRow = (table: string, opens: RegExp, what = 'its record opens'): Step => ({
  do: 'press', key: 'Enter', target: { css: 'tbody tr a', within: { testId: table }, nth: 0 }, name: `Press Enter on the first row’s link: ${what}`, state: 'row-open', proves: 'keyboard', expect: { url: opens },
});
const back = (to: string): Step => ({ do: 'back', name: 'Browser Back returns to the list', expect: { url: to } });

/** The rail every assessment role sees: the tenant's own pages, Configuration included (read-only below program-lead). */
const railSteps = (url: string): Step => ({
  do: 'navigate', url, ...resting, name: 'The rail holds the tenant’s own pages, Configuration among them, and nothing of another tenant', proves: 'role-gating',
  expect: { visible: ['Dashboard', 'Submissions', 'Reports', 'Feedback', 'Workspace', 'Configuration'].map(rail), absent: [{ css: '[data-shell-nav] a[href^="/iq"]' }, { css: '[data-shell-nav] a[href^="/admin"]' }] },
});

// ── Explorer pages (workspace, enterprise, rules, prompts): PROTOCOL "same frame" ───────────────────────────
interface Explorer { path: string; doc: string; title: string; missing: string; newPage: boolean }
const EXPLORERS: Record<'workspace' | 'enterprise' | 'rules' | 'prompts', Explorer> = {
  workspace: { path: '/assessment/workspace', doc: 'workspace_drafts/story-dim1-ci-evidence.md', title: 'Northstar Payments: close the CI claim (dimension 1)', missing: 'page:99999999', newPage: true },
  enterprise: { path: '/assessment/enterprise', doc: 'ec:standards/ci-cd-standards.md', title: 'CI/CD Standards', missing: 'ec:nope/missing.md', newPage: true },
  rules: { path: '/assessment/rules', doc: 'rule:scoring-guardrails.md', title: 'Scoring Guardrails', missing: 'rule:missing.md', newPage: true },
  // Prompts edit through a draft and are never created from the library (KnowledgeExplorer mayCreate excludes prompts).
  prompts: { path: '/assessment/prompts', doc: 'prompt:classify-transcript.md', title: 'Classify Transcript', missing: 'prompt:missing.md', newPage: false },
};

function explorer(kind: keyof typeof EXPLORERS, role: Role): Step[] {
  const e = EXPLORERS[kind];
  const url = `${e.path}?doc=${encodeURIComponent(e.doc)}`;
  const edits = CAPS[role].knowledge;
  const more: Target = { role: 'button', name: 'More for the documents list' };
  const newPage: Target = { role: 'menuitem', name: 'New page' };
  const offersNew = edits && e.newPage;
  return [
    { do: 'navigate', url, name: `Open “${e.title}”: the searchable library rail beside the document pane`, expect: { visible: [{ testId: 'knowledge-explorer-rail' }, { testId: 'document-shell' }, { role: 'heading', name: e.title, level: 1 }, { role: 'tab', name: 'Editor' }] } },
    { do: 'wait', target: { testId: 'canvas-document-body' }, name: `The canvas connects and is ${edits ? 'editable for a role holding ManageKnowledge' : 'read-only for a role without ManageKnowledge'}`, proves: 'role-gating', expect: { attr: [{ target: { css: '[data-testid="canvas-document-body"][contenteditable], [data-testid="canvas-document-body"] [contenteditable]' }, name: 'contenteditable', value: edits ? 'true' : 'false' }] } },
    { do: 'click', target: more, name: offersNew ? 'Open the library menu: New page is offered beside All documents' : `Open the library menu: All documents and Refresh, no New page${e.newPage ? ' (ManageKnowledge is not held)' : ' (prompts are never created here)'}`, state: 'menu-open', proves: 'role-gating', expect: offersNew ? { visible: [newPage, { role: 'menuitem', name: /^All documents/ }] } : { visible: [{ role: 'menuitem', name: /^All documents/ }], absent: [newPage] } },
    { do: 'press', key: 'Escape', name: 'Escape closes the library menu', proves: 'keyboard', expect: { hidden: [{ role: 'menuitem', name: /^All documents/ }] } },
    { do: 'click', target: { role: 'tab', name: /^Comments/ }, name: 'Open the Comments tab', state: 'tab-comments', expect: { attr: [{ target: { role: 'tab', name: /^Comments/ }, name: 'aria-selected', value: 'true' }] } },
    { do: 'click', target: { role: 'tab', name: 'Editor' }, name: edits ? 'Back to the Editor tab: the editing toolbar is there for a role that edits' : 'Back to the read-only canvas: the status bar offers Zoom and Fit width', expect: edits ? { visible: [{ testId: 'document-toolbar-italic' }] } : { visible: [{ role: 'combobox', name: 'Zoom' }], absent: [{ testId: 'document-toolbar-italic' }] } },
    // The canvas replaced the old Markdown reader. Exercise the current outline
    // and page-width controls instead of requiring its retired button labels.
    ...(!edits ? [
      { do: 'click', target: { role: 'button', name: 'More actions', exact: true }, name: 'Open the document menu: Show outline is offered to readers', state: 'reader-menu', expect: { visible: [{ role: 'menuitem', name: 'Show outline', exact: true }] } },
      { do: 'click', target: { role: 'menuitem', name: 'Show outline', exact: true }, name: 'Show outline opens the document heading list', state: 'reader-outline', expect: { visible: [{ role: 'navigation', name: 'Document outline' }], count: [{ target: { testId: 'document-outline-entry' }, min: 1 }] } },
      { do: 'press', key: 'Enter', target: { testId: 'document-outline-entry', nth: 0 }, name: 'Enter on the first heading: the outline marks its document location', proves: 'keyboard', expect: { attr: [{ target: { testId: 'document-outline-entry', nth: 0 }, name: 'aria-current', value: 'location' }] } },
      { do: 'click', target: { role: 'button', name: 'Collapse document context', exact: true }, name: 'Collapse the outline to give the document its pane back', expect: { hidden: [{ role: 'navigation', name: 'Document outline' }] } },
      { do: 'select', target: { role: 'combobox', name: 'Zoom' }, value: '0.5', name: 'Choose 50%: the actual document sheet scales down', state: 'reader-zoom', expect: { attr: [{ target: { testId: 'canvas-document-paper' }, name: 'style', value: /zoom: 0\.5/ }] } },
      { do: 'select', target: { role: 'combobox', name: 'Zoom' }, value: 'fit', name: 'Choose Fit width: the sheet follows the available reading width', state: 'reader-fit', expect: { attr: [{ target: { css: '[data-testid="canvas-document-status-bar-zoom"] option:checked' }, name: 'value', value: 'fit' }] } },
    ] satisfies Step[] : []),
    tabWalk(15),
    { do: 'navigate', url: `${e.path}?doc=${encodeURIComponent(e.missing)}`, name: 'A document id that does not exist: the rail stays and the pane asks for a document', state: 'not-found', proves: 'empty-state', expect: { visible: [{ testId: 'knowledge-explorer-rail' }], text: ['Select a document from the library to view it.'] } },
  ];
}

/** The steps of each surface, per role. */
export const SURFACES: Record<string, (role: Role) => Step[]> = {
  dashboard: (role) => [
    { do: 'navigate', url: '/assessment/teams', name: 'Open the assessor’s desk: the program strip and every team with its certification and next action', expect: { visible: [{ role: 'heading', name: "Assessor's desk", level: 1 }], text: ['claims open', 'Next action'], count: [{ target: rows('assessment-teams'), min: 5 }] } },
    railSteps('/assessment/teams'),
    { do: 'navigate', url: '/assessment/teams', ...resting, name: '+ New team is offered (ScoreAssessment, held by every assessment role)', proves: 'role-gating', expect: { visible: [{ role: 'button', name: '+ New team' }] } },
    tabWalk(15),
    searchEmpty('Search teams', 'No teams match the current filters.'),
    searchClear('Search teams', rows('assessment-teams')),
    { do: 'navigate', url: '/assessment/teams', ...resting, name: 'The unassessed teams (Fraud Detection ML, Internal Tools) read Not yet assessed with Start intake as their next action', proves: 'empty-state', expect: { text: ['Fraud Detection ML', 'Not yet assessed', 'Start intake'] } },
    enterRow('assessment-teams', /^\/assessment\/teams\/TEAM-\d+/, 'the team’s scorecard opens'),
    back('/assessment/teams'),
  ],

  'team-scorecard': (role) => [
    { do: 'navigate', url: '/assessment/teams/TEAM-001', name: 'Open Northstar Payments: the header, its tabs and the dimension master-detail', expect: { visible: [{ role: 'heading', name: 'Northstar Payments', level: 1 }, { testId: 'assessment-dimension-master-detail' }, { role: 'tab', name: 'Certification' }], count: [{ target: { css: '[data-verified][data-claimed]', within: { testId: 'dimension-rail' } }, min: 15 }] } },
    { do: 'click', target: { testId: 'dimension-rail-row-open-1' }, name: 'Select dimension 01: the pane names the enterprise standard it is measured against', state: 'row-open', expect: { visible: [{ testId: 'dimension-standard' }], text: ['Measured against'] } },
    { do: 'click', target: { role: 'button', name: 'About Northstar Payments', exact: true }, name: 'Open the team’s About card: it carries the evidence coverage strip', state: 'dialog-open', expect: { visible: [{ testId: 'evidence-coverage' }] } },
    { do: 'press', key: 'Escape', name: 'Escape closes the About card', proves: 'keyboard', ...resting, expect: { hidden: [{ testId: 'evidence-coverage' }] } },
    ...([['Improvement Plan', 'plan'], ['Stories', 'stories'], ['Evidence & Intake', 'evidence'], ['Documents', 'documents'], ['Activity', 'activity']] as const).map(([tab, key]): Step => ({ do: 'click', target: { role: 'tab', name: tab, exact: true }, name: `Open the ${tab} tab`, state: `tab-${key}`, expect: { url: new RegExp(`[?&]tab=${key}`) } })),
    { do: 'click', target: { role: 'tab', name: 'Certification', exact: true }, name: 'Back to the Certification tab', ...resting },
    { do: 'click', target: { role: 'button', name: 'Team details' }, name: 'Open Team details: the drawer names the team’s repos as links', state: 'dialog-open', expect: { visible: [{ role: 'dialog', name: 'Team details' }, { testId: 'team-repos' }] } },
    { do: 'press', key: 'Escape', name: 'Escape closes the Team details drawer', proves: 'keyboard', expect: { hidden: [{ role: 'dialog', name: 'Team details' }] } },
    { do: 'click', target: { role: 'button', name: 'Assessment review actions' }, name: 'Open the Review menu', state: 'menu-open', expect: { visible: [{ role: 'menuitem', name: 'Exceptions' }] } },
    { do: 'click', target: { role: 'menuitem', name: 'Exceptions' }, name: CAPS[role].approve ? 'Open N/A exceptions: Approve and Deny are offered (ApproveException)' : 'Open N/A exceptions: the requests are listed with no Approve or Deny (ApproveException is not held)', state: 'dialog-open', proves: 'role-gating',
      expect: CAPS[role].approve ? { visible: [{ role: 'dialog', name: 'N/A exceptions' }, { role: 'button', name: /^Approve exception for / }, { role: 'button', name: /^Deny exception for / }] } : { visible: [{ role: 'dialog', name: 'N/A exceptions' }], absent: [{ role: 'button', name: /^Approve exception for / }, { role: 'button', name: /^Deny exception for / }] } },
    { do: 'press', key: 'Escape', name: 'Escape closes the exceptions dialog', proves: 'keyboard', expect: { hidden: [{ role: 'dialog', name: 'N/A exceptions' }] } },
    tabWalk(20),
    { do: 'navigate', url: '/assessment/teams/TEAM-999', name: 'Open TEAM-999: the page says there is no such team and links back to the dashboard', state: 'not-found', proves: 'empty-state', expectConsole: NOT_FOUND, expect: { text: ['No team TEAM-999'], visible: [{ role: 'button', name: 'Back to the dashboard' }] } },
  ],

  submissions: (role) => [
    { do: 'navigate', url: '/assessment/submissions', name: 'Open Submissions: the intake strip and every submission with its revision and status', expect: { visible: [{ role: 'heading', name: 'Submissions', level: 1 }], count: [{ target: rows('assessment-submissions'), min: 1 }] } },
    railSteps('/assessment/submissions'),
    { do: 'navigate', url: '/assessment/submissions', ...resting, name: 'Add submissions is offered (ManageSubmissions, held by every assessment role)', proves: 'role-gating', expect: { visible: [{ role: 'button', name: 'Add submissions →' }] } },
    tabWalk(15),
    searchEmpty('Search submissions', /No submission matches/),
    searchClear('Search submissions', rows('assessment-submissions')),
    enterRow('assessment-submissions', /^\/assessment\/submissions\/sub-/, 'the submission record opens'),
    { do: 'wait', target: { testId: 'assessment-submission-record' }, name: 'The record shows the submission beside the list', ...resting },
    back('/assessment/submissions'),
  ],

  'submissions-wizard': (role) => [
    { do: 'navigate', url: '/assessment/submissions', name: 'Open Submissions', audit: false, auditReason: 'the list is the submissions map’s surface; this map measures the wizard' },
    { do: 'click', target: { role: 'button', name: 'Add submissions →' }, name: 'Add submissions opens the four-step wizard at Drop file', screenshot: 'log', expect: { url: '/assessment/submissions?view=add', visible: [{ role: 'heading', name: 'Add submissions', level: 1 }, { testId: 'wizard-step-drop' }, { testId: 'wizard-step-preview' }, { testId: 'wizard-step-fetch' }, { testId: 'wizard-step-run' }] } },
    { do: 'wait', target: { testId: 'wizard' }, name: 'The whole wizard is offered to a role holding ManageSubmissions: the drop zone takes a Forms export', proves: 'role-gating', ...resting, expect: { visible: [{ role: 'button', name: /^Drop file, or click to browse/ }] } },
    { do: 'wait', target: { testId: 'wizard' }, name: 'Before a file is chosen, Parse file, Back and Next are disabled', state: 'incomplete', proves: 'empty-state', ...resting, expect: { disabled: [{ role: 'button', name: 'Parse file' }, { testId: 'wizard-back' }, { testId: 'wizard-next' }] } },
    tabWalk(5),
    { do: 'click', target: { role: 'link', name: '← All submissions' }, name: 'Cancel at step 1 with ← All submissions: the list is back, unchanged', proves: 'empty-state', expect: { url: '/assessment/submissions', count: [{ target: rows('assessment-submissions'), min: 1 }] } },
  ],

  feedback: (role) => [
    { do: 'navigate', url: '/assessment/feedback', name: 'Open the question queue: every open question with its team and dimension by name', expect: { visible: [{ role: 'heading', name: 'Question queue', level: 1 }], count: [{ target: rows('assessment-feedback'), min: 1 }] } },
    railSteps('/assessment/feedback'),
    tabWalk(15),
    searchEmpty('Search questions', 'No questions match the current filters.'),
    searchClear('Search questions', rows('assessment-feedback')),
    { do: 'click', target: { css: 'tbody tr', within: { testId: 'assessment-feedback' }, nth: 0 }, name: 'Open the first question: its record shows the two tracks and the answer form', state: 'row-open', expect: { url: /^\/assessment\/feedback\/[\w-]+/, visible: [{ testId: 'assessment-question-record' }] } },
    { do: 'wait', target: { testId: 'assessment-question-record' }, name: 'Record answer and Dismiss are offered (LabelFeedback, held by every assessment role)', proves: 'role-gating', ...resting, expect: { visible: [{ role: 'button', name: 'Record answer' }, { role: 'button', name: 'Dismiss' }] } },
    back('/assessment/feedback'),
  ],

  reports: (role) => [
    { do: 'navigate', url: '/assessment/reports', name: 'Open the portfolio: the rollup strip and the maturity heatmap, teams × seventeen dimensions', expect: { visible: [{ role: 'heading', name: 'Portfolio', level: 1 }, { testId: 'maturity-heatmap' }, { role: 'heading', name: 'Where to start' }, { role: 'heading', name: 'By cohort' }], count: [{ target: { css: '[data-verified][data-claimed]', within: { testId: 'maturity-heatmap' } }, min: 100 }] } },
    CAPS[role].publish
      ? { do: 'navigate', url: '/assessment/reports', ...resting, name: 'Publish report is offered (PublishReport)', proves: 'role-gating', expect: { visible: [{ role: 'button', name: 'Publish report' }] } }
      : { do: 'navigate', url: '/assessment/reports', ...resting, name: 'No Publish report for a role without PublishReport (absent from the DOM)', proves: 'role-gating', expect: { absent: [{ role: 'button', name: /Publish/ }] } },
    tabWalk(10),
    searchEmpty('Search heatmap teams', 'No team matches the search or motion'),
    searchClear('Search heatmap teams', rows('maturity-heatmap')),
    { do: 'click', target: { css: 'tbody tr', within: { testId: 'maturity-heatmap' }, nth: 0 }, name: 'Open the heatmap’s first team: its scorecard opens', state: 'row-open', expect: { url: /^\/assessment\/teams\/TEAM-\d+/ } },
    back('/assessment/reports'),
  ],

  runs: (role) => [
    { do: 'navigate', url: '/assessment/runs', name: 'Open Activity: the command launcher and the run ledger', expect: { visible: [{ role: 'heading', name: 'Activity', level: 1 }, { role: 'heading', name: 'Run a command' }, { testId: 'assessment-pipeline-runs' }], count: [{ target: rows('assessment-pipeline-runs'), min: 1 }] } },
    { do: 'navigate', url: '/assessment/runs', ...resting, name: 'The launcher offers Prepare for each command (RunAssessmentAgent, held by every assessment role); nothing is launched', proves: 'role-gating', expect: { visible: [{ role: 'button', name: 'Prepare classify-transcript' }, { role: 'button', name: 'Prepare score-dimensions' }] } },
    tabWalk(20),
    { do: 'fill', target: search('Search loaded run titles'), value: 'zzznoexist', name: 'Search the ledger for zzznoexist: no row is left', state: 'filtered-empty', proves: 'empty-state', expect: { count: [{ target: { css: 'tbody tr:not(:has([colspan]))', within: { testId: 'assessment-pipeline-runs' } }, eq: 0 }] } },
    searchClear('Search loaded run titles', rows('assessment-pipeline-runs')),
    // The facade ledger below the launcher is read-only (detailBase=null). Assessment's own run links live in the first table.
    { do: 'press', key: 'Enter', target: { css: 'main tbody tr a[href^="/assessment/runs/"]', nth: 0 }, name: 'Press Enter on the first Assessment run link: the run record opens', state: 'row-open', proves: 'keyboard', expect: { url: /^\/assessment\/runs\/run-/, visible: [{ testId: 'assessment-run-record' }] } },
    back('/assessment/runs'),
  ],

  configuration: (role) => [
    { do: 'navigate', url: '/assessment/configuration', name: 'Open Configuration: the certification target and the cohort motions', expect: { visible: [{ role: 'heading', name: 'Configuration', level: 1 }, { role: 'heading', name: 'Certification target' }, { role: 'heading', name: 'Cohort motions' }] } },
    CAPS[role].config
      ? { do: 'navigate', url: '/assessment/configuration', ...resting, name: 'Save is offered and the motion fields are editable (ManageAssessmentConfig)', proves: 'role-gating', expect: { visible: [{ role: 'button', name: 'Save' }], enabled: [{ css: 'main input[type="text"]', nth: 0 }], noText: ['read-only for your role'] } }
      : { do: 'navigate', url: '/assessment/configuration', ...resting, name: 'Read-only for a role without ManageAssessmentConfig: the page says so, every field is disabled and Save is absent from the DOM', proves: 'role-gating', expect: { text: ['everything below is read-only for your role'], disabled: [{ css: 'main input[type="text"]', nth: 0 }], absent: [{ role: 'button', name: 'Save' }] } },
    tabWalk(CAPS[role].config ? 15 : 8),
    { do: 'navigate', url: '/assessment/configuration', ...resting, name: 'Nothing here can be empty: the target level and the three cohort motions always have values', proves: 'empty-state', expect: { text: ['Target level', 'Level 3'], count: [{ target: { css: 'main input[type="text"]' }, min: 9 }] } },
  ],

  workspace: (role) => explorer('workspace', role),
  enterprise: (role) => explorer('enterprise', role),
  rules: (role) => explorer('rules', role),
  prompts: (role) => explorer('prompts', role),
};

export const PAGES: Record<string, string> = {
  dashboard: 'portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/AssessorDesk.tsx',
  'team-scorecard': 'portal/src/pages/assessment/dashboard/TeamScorecard.tsx,portal/src/pages/assessment/dashboard/DimensionMasterDetail.tsx,portal/src/pages/assessment/dashboard/ExceptionsModal.tsx',
  submissions: 'portal/src/pages/assessment/SubmissionsPage.tsx',
  'submissions-wizard': 'portal/src/pages/assessment/SubmissionsPage.tsx,portal/src/pages/assessment/submissions',
  feedback: 'portal/src/pages/assessment/FeedbackPage.tsx',
  reports: 'portal/src/pages/assessment/ReportsPage.tsx',
  runs: 'portal/src/pages/assessment/RunsPage.tsx',
  configuration: 'portal/src/pages/assessment/ConfigurationPage.tsx',
  workspace: 'portal/src/pages/assessment/WorkspacePage.tsx,portal/src/pages/assessment/knowledge',
  enterprise: 'portal/src/pages/assessment/EnterprisePage.tsx,portal/src/pages/assessment/knowledge',
  rules: 'portal/src/pages/assessment/RulesPage.tsx,portal/src/pages/assessment/knowledge',
  prompts: 'portal/src/pages/assessment/PromptsPage.tsx,portal/src/pages/assessment/knowledge',
};

const WHO: Record<Role, string> = { assessor: 'Asha (assessor)', 'lead-assessor': 'Jonas (lead assessor)', 'program-lead': 'Farah (program lead)', admin: 'The platform operator (admin in Assessment)' };
const GOALS: Record<string, (role: Role) => string> = {
  dashboard: (r) => `${WHO[r]} reads the desk, narrows it to nothing and back, and opens a team from it`,
  'team-scorecard': (r) => `${WHO[r]} works through Northstar Payments’ scorecard: a dimension, every tab, the team details and the N/A exceptions${CAPS[r].approve ? ', which this role may decide' : ', which this role may only read'}`,
  submissions: (r) => `${WHO[r]} reads the intake list, narrows it and opens a submission`,
  'submissions-wizard': (r) => `${WHO[r]} opens the add-submissions wizard, sees what it needs before it can parse, and cancels at step 1`,
  feedback: (r) => `${WHO[r]} works the question queue and opens a question with its answer form`,
  reports: (r) => `${WHO[r]} reads the portfolio heatmap and opens a team from it${CAPS[r].publish ? '; Publish is offered' : '; Publish is not this role’s'}`,
  runs: (r) => `${WHO[r]} reads the run ledger and the launcher, and opens a run record (nothing is launched)`,
  configuration: (r) => `${WHO[r]} reads the program configuration${CAPS[r].config ? ', which this role may change' : ', read-only for this role'}`,
  workspace: (r) => `${WHO[r]} opens a workspace draft in the document explorer${CAPS[r].knowledge ? ', editable for this role' : ', read-only for this role'}`,
  enterprise: (r) => `${WHO[r]} reads an enterprise standard in the document explorer${CAPS[r].knowledge ? ', editable for this role' : ', read-only for this role'}`,
  rules: (r) => `${WHO[r]} reads a scoring rule in the document explorer${CAPS[r].knowledge ? ', editable for this role' : ', read-only for this role'}`,
  prompts: (r) => `${WHO[r]} reads an agent prompt in the document explorer${CAPS[r].knowledge ? ', editable through a draft for this role' : ', read-only for this role'}`,
};
/** Surfaces whose fixture can never be empty claim empty-state n/a (the judge accepts pass or n/a). */
const EMPTY_NA = new Set(['configuration']);

export function surfaceMap(role: Role, surface: string): JourneyMap {
  const explorerPage = ['workspace', 'enterprise', 'rules', 'prompts'].includes(surface);
  return {
    family: 'assessment', log: `${role}/${surface}`, kind: 'surface', persona: PERSONA[role], scenario: 'shared', identity: 'clone',
    ...(explorerPage ? { readOnlyPosts: READ_ONLY_POSTS } : {}),
    goal: GOALS[surface](role),
    fields: { surface, pages: PAGES[surface] },
    ...(EMPTY_NA.has(surface) ? { claims: { 'empty-state': 'n/a' } } : {}),
    steps: SURFACES[surface](role),
  };
}

// ── Isolation (validate-assessment-tenant.sh "role isolation") ─────────────────────────────────────────────

const anchorsTo = (prefix: string): Target => ({ css: `a[href^="${prefix}"]` });
const FORBIDDEN = /403|Forbidden/i;
const away = (url: string, from: RegExp, field: string, noText: string[], extra: Partial<Step> = {}): Step => ({
  do: 'navigate', url, name: `Type ${url}: the route sends this identity away`, state: 'refused', proves: field, expectConsole: FORBIDDEN,
  expect: { urlNot: from, ...(noText.length ? { noText } : {}) }, ...extra,
} as Step);
const forbidden = (url: string, field: string): Step => ({ do: 'api', url, name: `GET ${url} answers 403`, proves: field, expect: { status: 403 } });
const ASSESSMENT_CONTENT = ["Assessor's desk", 'Question queue', 'Certification heatmap'];
const DOC = 'page%3A100002';

/** Inbound: an orgiq role (or the demo identity) meets the assessment tenant, holding no grant in it (or no assessment session). */
export function inbound(landing: string, opts: { tileByDesign?: boolean } = {}): Step[] {
  return [
    opts.tileByDesign
      ? { do: 'navigate', url: '/select', name: 'The chooser offers the Assessment workspace to the dev-only cookie-less identity, by design (SelectContextPage keeps every workspace for it)', proves: 'assessment-tile-visible', expect: { visible: [{ testId: 'select-roles-assessment' }] } }
      : { do: 'navigate', url: '/select', name: 'The workspace chooser offers no Assessment workspace', proves: 'assessment-tile-visible', expect: { absent: [{ testId: 'select-roles-assessment' }, anchorsTo('/assessment')], noText: ['Assessment'] } },
    { do: 'navigate', url: landing, name: `The rail on ${landing} holds no link toward /assessment`, proves: 'assessment-nav-visible', expect: { absent: [anchorsTo('/assessment')] } },
    away('/assessment/teams', /^\/assessment/, 'direct-route-result', ASSESSMENT_CONTENT),
    away(`/assessment/workspace?doc=${DOC}`, /^\/assessment/, 'direct-route-result', ASSESSMENT_CONTENT),
    away('/assessment/prompts', /^\/assessment/, 'direct-route-result', ASSESSMENT_CONTENT),
    { do: 'navigate', url: landing, name: 'Back on the home landing, still no link toward /assessment', proves: 'assessment-nav-visible', screenshot: 'log', expect: { absent: [anchorsTo('/assessment')] } },
    forbidden('/api/assessment/teams', 'api-status'),
    forbidden('/api/assessment/knowledge/tree', 'api-status'),
    forbidden(`/api/assessment/knowledge/doc/workflows/comments?id=${DOC}`, 'api-status'),
    { do: 'api', method: 'POST', url: '/api/assessment/knowledge/canvas', body: {}, refusal: 'the body names no document id, which the route rejects (400) even past the gate', name: 'POST /api/assessment/knowledge/canvas is refused: no document session for this identity', proves: 'api-status', expect: { status: 403 } },
    { do: 'api', method: 'POST', url: `/api/assessment/knowledge/doc/workflows/comments?id=${DOC}`, body: {}, refusal: 'the body carries no comment text, which the route rejects (400) even past the gate', name: 'POST a document comment is refused', proves: 'api-status', expect: { status: 403 } },
  ];
}
export const INBOUND_CLAIMS = { 'assessment-tile-visible': 'no', 'assessment-nav-visible': 'no', 'direct-route-result': 'redirect', 'api-status': '403' };

/** Outbound: an assessment role meets the orgiq tenant (and another tenant's run ledger). */
export function outbound(): Step[] {
  const foreign = ['/iq', '/admin'].map(anchorsTo);
  return [
    { do: 'navigate', url: '/assessment/teams', name: 'The assessment rail and desk hold no link toward /iq or /admin', proves: 'orgiq-nav-visible', expect: { absent: foreign } },
    { do: 'navigate', url: '/select', name: 'The workspace chooser offers no Work (orgiq) workspace', proves: 'orgiq-nav-visible', expect: { absent: [{ testId: 'select-roles-orgiq' }, ...foreign] } },
    away('/iq/projects', /^\/iq/, 'orgiq-route-result', [], { screenshot: 'log' }),
    away('/iq/scores', /^\/iq/, 'orgiq-route-result', []),
    away('/iq/search', /^\/iq/, 'orgiq-route-result', []),
    away('/iq/runs', /^\/iq/, 'orgiq-route-result', []),
    away('/admin/observability', /^\/admin/, 'orgiq-route-result', []),
    away('/pipelines/runs', /^\/pipelines/, 'orgiq-route-result', []),
    forbidden('/api/graph/people?limit=1', 'orgiq-api-status'),
    forbidden('/api/scores/leaderboard', 'orgiq-api-status'),
    forbidden('/api/work/queue', 'orgiq-api-status'),
    forbidden('/api/work/summary', 'orgiq-api-status'),
    forbidden('/api/bots', 'orgiq-api-status'),
    forbidden('/api/pipelines/runs', 'orgiq-api-status'),
  ];
}
export const OUTBOUND_CLAIMS = { 'orgiq-nav-visible': 'no', 'orgiq-route-result': 'redirect', 'orgiq-api-status': '403' };
export const ISOLATION_PAGES = 'portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx';

/** The orgiq personas of the inbound logs (docs/journeys/maps/work/_shared.ts PERSONA). */
export const ORGIQ: Record<'member' | 'sme' | 'program-owner' | 'org-leader' | 'hr-admin', Persona> = {
  member: { user: 'u-theo', name: 'Theo Chang', tenant: 'orgiq', role: 'member' },
  sme: { user: 'u-nora', name: 'Nora DaSilva', tenant: 'orgiq', role: 'sme' },
  'program-owner': { user: 'u-mia', name: 'Mia Singh', tenant: 'orgiq', role: 'program-owner', switchRole: true },
  'org-leader': { user: 'u-vera', name: 'Vera Green', tenant: 'orgiq', role: 'org-leader', switchRole: true },
  'hr-admin': { user: 'u-rachel', name: 'Rachel Kowalski', tenant: 'orgiq', role: 'hr-admin', switchRole: true },
};

export function inboundMap(role: keyof typeof ORGIQ): JourneyMap {
  const p = ORGIQ[role];
  return {
    family: 'assessment', log: `isolation/${role}`, kind: 'isolation-inbound', scenario: 'shared', identity: 'clone', persona: p,
    goal: `${p.name} (orgiq ${role}) holds no grant in Assessment: no tile, no link, no route and no API answers`,
    fields: { pages: ISOLATION_PAGES }, claims: INBOUND_CLAIMS, steps: inbound('/iq/projects'),
  };
}

export function outboundMap(role: 'assessor' | 'lead-assessor' | 'program-lead'): JourneyMap {
  const p = PERSONA[role];
  return {
    family: 'assessment', log: `isolation/${role}-outbound`, kind: 'isolation-outbound', scenario: 'shared', identity: 'clone', persona: p,
    goal: `${p.name} (${role}) holds no grant in Work: no orgiq link, route or API answers`,
    fields: { pages: ISOLATION_PAGES }, claims: OUTBOUND_CLAIMS, steps: outbound(),
  };
}
