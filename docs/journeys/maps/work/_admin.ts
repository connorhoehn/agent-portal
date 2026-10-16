// The admin and gated surfaces of the Work tenant (docs/work-journeys-goal.md catalog rows runs, bots, devbox,
// budgets, changes-review, scores, observability, knowledge, capabilities, prompts, identity, ingest, codebases).
// Each surface is ONE function of the role, so sme, program-owner and org-leader reuse it later: what a role may
// do comes from CAPS (the Cedar actions of middleware/seeds/roles/orgiq/<role>.cedar) and from the route gates in
// portal/src/App.tsx. Helpers come from _shared.ts (owned by the member lane; never edited here).
import type { Expect, JourneyMap, Step, Target, Text } from '../../../../scripts/journeys/journey-map.ts';
import {
  CAPS, LEAKS, PERSONA, readOnlyPostsFor, STILL, back, click, dialog, fill, firstRow, open, press, reload, scoped, search, seen, tabClick,
  tabNamed, tabWalk, tableRows, api, type Role,
} from './_shared.ts';

const h1 = (name: Text): Target => ({ role: 'heading', name, level: 1 });
const selected = (t: Target): Expect => ({ attr: [{ target: t, name: 'aria-selected', value: 'true' }] });
const btn = (name: Text): Target => ({ role: 'button', name });
const link = (name: Text, within?: Target): Target => ({ role: 'link', name, ...(within ? { within } : {}) });
/** Console noise a scoped error world is expected to make (the API answers 500 on purpose). */
/** The library DiffViewer renders its rows without keys (React dev warning on /admin/changes/:id; queued upstream). */
const KEYWARN = /unique "key" prop/;
const E500 = /500 \(Internal Server Error\)|Failed to load resource/;

// ── runs: /iq/runs and /iq/runs/:id ─────────────────────────────────────────
export function runs(_role: Role): Step[] {
  const runTabs = (): Target[] => [STILL.header, STILL.tablist('Run views'), h1('Run')];
  const count: Target = seen(/^\d+ runs$/);
  return [
    open('/iq/runs', 'Open Runs: every run the workspace made, a header count that agrees with the table, people by name', {
      url: '/iq/runs', visible: [h1('Runs'), count, seen('Who knows Kubernetes best on the platform team?'), seen('Mia Singh')],
      count: [{ target: tableRows, min: 20 }],
      numbers: [{ of: count, re: /(\d+)/, eqNumberOf: { testId: 'datatable-page-summary' }, reOther: /· (\d+) total/ }],
    }, { facts: true }),
    api('/api/runs?limit=1', 200, 'This role may read the run ledger: GET /api/runs answers 200'),
    click(btn('Filters'), 'Open Filters: Status and Kind sit in one popover', { visible: [{ role: 'combobox', name: 'Status' }, { role: 'combobox', name: 'Kind' }] }, { state: 'dialog-open' }),
    click({ role: 'combobox', name: 'Status' }, 'Open the Status list', { visible: [{ role: 'option', name: 'failed' }, { role: 'option', name: 'running' }] }),
    click({ role: 'option', name: 'failed' }, 'Choose failed: only failed runs stay, each marked failed', { visible: [seen('failed'), seen(/^\d{1,2} runs$/)], count: [{ target: tableRows, min: 1 }] }, { state: 'filtered' }),
    press('Escape', 'Escape closes the Filters popover', { hidden: [{ role: 'combobox', name: 'Kind' }] }, { proves: 'keyboard' }),
    fill(search('Search loaded run titles'), 'zzzzqq', 'Search zzzzqq among the failed runs: the table says no run matches', { visible: [seen('No run matches these filters.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search loaded run titles'), '', 'Clear the search: the failed runs come back', { count: [{ target: tableRows, min: 1 }] }),
    click(btn('Filters'), 'Open Filters again to clear them', { visible: [btn('Clear filters')] }),
    click(btn('Clear filters'), 'Clear filters: every run is back and the header count is in the hundreds again', { visible: [seen(/^\d{3} runs$/)], count: [{ target: tableRows, min: 20 }] }),
    fill(search('Search loaded run titles'), 'auth-rotation', 'Search auth-rotation: the ADR summaries stay', { visible: [seen('Summarize the auth-rotation ADR for the exec review')], count: [{ target: tableRows, min: 1 }] }, { state: 'filtered', proves: 'empty-state' }),
    // Enter while the search holds the seeded ADR runs: a live relayed run at the top of the full ledger keeps ticking, so its record never measures still.
    press('Enter', 'Enter on the first auth-rotation run opens its record', { url: /^\/iq\/runs\/[^/]+$/, visible: [h1('Run'), seen(/auth-rotation/)] }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    back('Browser Back returns to the ledger', { url: /^\/iq\/runs(?:\?.*)?$/, visible: [h1('Runs')] }),
    open('/iq/runs/job:job-obs-maint-1', 'Open the nightly maintenance run: who ran it, what it cost and its steps, by name', {
      url: '/iq/runs/job:job-obs-maint-1', visible: [h1('Run'), seen('Obs nightly maintenance'), seen('completed'), tabNamed('Run'), tabNamed('Brief'), seen('Steps')],
      count: [{ target: tableRows, min: 5 }], ...selected(tabNamed('Run')),
    }, { facts: true, state: 'row-open' }),
    tabClick(tabNamed('Brief'), 'Click the Brief tab: it says no brief was frozen and the header and tab strip stay put', {
      url: /[?&]tab=brief\b/, ...selected(tabNamed('Brief')), visible: [seen('No brief was frozen for this run')],
    }, runTabs(), { proves: ['tab-stability', 'empty-state'], expectConsole: /404/ }),
    tabClick(tabNamed('Run'), 'Click the Run tab: the steps are back and nothing else moves', { ...selected(tabNamed('Run')), visible: [seen('Steps')], count: [{ target: tableRows, min: 5 }] }, runTabs()),
    tabWalk(6),
    open('/iq/runs/nope', 'Open a run that does not exist: the page says so and offers the ledger', {
      url: '/iq/runs/nope', visible: [seen('Run not found'), seen(/No run with id nope/), link('Runs')],
    }, { state: 'not-found', proves: 'empty-state', expectConsole: /404|Not Found/ }),
    scoped({ scenario: 'error', fixture: 'agent-jobs' }, '/iq/runs', 'When the job source cannot be read the ledger names it instead of quietly showing fewer runs', 'error', { visible: [h1('Runs'), seen(/Not every source could be read/)] }, { expectConsole: E500 }),
    scoped({ scenario: 'empty' }, '/iq/runs', 'In a world with no runs the table says none are recorded', 'empty', { visible: [h1('Runs'), seen('No runs recorded yet.'), seen('0 runs')] }),
  ];
}

// ── bots: /admin/bots and /admin/bots/:id ───────────────────────────────────
export function bots(role: Role): Step[] {
  const c = CAPS[role];
  const botTabs = (): Target[] => [STILL.header, { role: 'tablist', name: /detail$/ }, h1(/.+/)];
  return [
    open('/admin/bots', 'Open Bots: the fleet with each bot\'s target initiative by name, and a header count that agrees with the rows', {
      url: '/admin/bots', visible: [h1('Bots'), seen('obs-nightly-maintenance'), seen('Observability Platform'), seen(/^\d+ bots$/)],
      count: [{ target: tableRows, min: 10 }], numbers: [{ of: seen(/^\d+ bots$/), re: /(\d+)/, eqCount: tableRows }],
      ...(c.bots ? { visible: [h1('Bots'), seen('obs-nightly-maintenance'), seen('Observability Platform'), btn('+ New bot')] } : { absent: [btn('+ New bot')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/bots', 200, 'This role may read the bot roster: GET /api/bots answers 200'),
    fill(search('Search bots'), 'auth', 'Search auth: the dependency watch on Auth Migration stays', { visible: [seen('auth-dep-watch')], count: [{ target: tableRows, min: 1, max: 4 }] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search('Search bots'), 'zzzzqq', 'Search zzzzqq: the table says no bot matches', { visible: [seen('No bots match the current filters.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search bots'), '', 'Clear the search: every bot is back', { count: [{ target: tableRows, min: 10 }] }),
    ...(c.bots ? [
      click(btn('+ New bot'), 'New bot opens the wizard at its first step (nothing is created)', { visible: [dialog(/New bot/), { text: 'Start from a predefined bot', within: dialog(/New bot/) }] }, { state: 'dialog-open', proves: 'role-gating' }),
      press('Escape', 'Escape closes the wizard and focus returns to New bot', { hidden: [dialog(/New bot/)], focused: btn('+ New bot') }, { proves: 'keyboard' }),
    ] : []),
    press('Enter', 'Enter on the first bot opens its page', { url: /^\/admin\/bots\/[0-9a-f-]{36}$/, visible: [h1('obs-nightly-maintenance')] }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    tabClick(tabNamed('Mission'), 'Click the Mission tab: the written mission shows and the header and tab strip stay put', {
      ...selected(tabNamed('Mission')), visible: [seen('Nightly maintenance for the observability stack')],
    }, botTabs(), { proves: ['tab-stability', 'story-facts'] }),
    tabClick(tabNamed('Guardrails'), 'Click the Guardrails tab: model, budgets and review rule, nothing else moves', {
      ...selected(tabNamed('Guardrails')), visible: [seen('Budget / run'), seen('Requires review'), seen('us.amazon.nova-lite-v1:0')],
    }, botTabs()),
    tabClick(tabNamed(/^Runs/), 'Click the Runs tab: the firings table is back and nothing else moves', {
      ...selected(tabNamed(/^Runs/)), visible: [seen(/9 firings/)], count: [{ target: tableRows, min: 9 }],
    }, botTabs()),
    { do: 'wait', target: tabNamed(/^Runs/), name: 'No run is in flight, so there is no Live activity tab (it exists only while a firing runs)', proves: 'role-gating', expect: { absent: [tabNamed('Live activity')] } } as Step,
    ...(c.bots ? [
      { do: 'wait', target: btn(/Run now/), name: 'This role holds ManageBots: Run now, Pause and Delete are on the page', proves: 'role-gating', expect: { visible: [btn(/Run now/), btn('Pause'), btn('Delete')] } } as Step,
      click(btn('Delete'), 'Delete asks first and names the bot (nothing is deleted)', { visible: [dialog('Delete obs-nightly-maintenance?')] }, { state: 'dialog-open', proves: 'role-gating' }),
      press('Escape', 'Escape keeps the bot and focus returns to Delete', { hidden: [dialog('Delete obs-nightly-maintenance?')], focused: btn('Delete'), visible: [h1('obs-nightly-maintenance')] }, { proves: 'keyboard' }),
    ] : [
      { do: 'wait', target: tabNamed(/^Runs/), name: 'Without ManageBots the bot page offers no Run now, Pause or Delete', proves: 'role-gating', expect: { absent: [btn(/Run now/), btn('Pause'), btn('Delete')] } } as Step,
    ]),
    tabWalk(8),
    click(link('← Bots'), 'The back link returns to the fleet', { url: '/admin/bots', visible: [h1('Bots')] }),
    scoped({ scenario: 'empty', fixture: 'bots' }, '/admin/bots', 'In a world with no bots the page says what a bot is' + (c.bots ? ' and offers New bot' : ''), 'empty', {
      visible: [seen('No bots yet'), seen(/durable, mission-configured agent/)], ...(c.bots ? {} : { absent: [btn('+ New bot')] }),
    }),
    scoped({ scenario: 'error', fixture: 'bots' }, '/admin/bots', 'When the roster cannot be read the page says so, not that there are no bots', 'error', {
      visible: [seen('Could not load the bot roster'), btn('Try again')],
    }, { expectConsole: E500 }),
  ];
}

// ── budgets: /admin/budgets ─────────────────────────────────────────────────
export function budgets(role: Role): Step[] {
  const c = CAPS[role];
  const INF = 'Inference Platform';
  const editBtn = (amount: string): Target => btn(`Edit monthly budget for ${INF}: ${amount}`);
  const rowsN: Target = tableRows;
  return [
    open('/admin/budgets', 'Open Budgets: allocations per initiative by name, the roll-up above and a tab count that agrees with the rows', {
      url: '/admin/budgets', visible: [h1('Initiatives'), seen('Observability Platform'), seen('Auth Migration'), seen('$431.00'), seen('14 of 14 initiatives')],
      count: [{ target: rowsN, eq: 14 }], numbers: [{ of: link(/^Initiatives/, { css: 'main' }), re: /(\d+)/, eqCount: rowsN }],
      ...(c.budgets ? { visible: [h1('Initiatives'), seen('Observability Platform'), seen('Auth Migration'), seen('$431.00'), btn('Set budget')] } : { absent: [btn('Set budget'), btn(/^Edit monthly budget/)] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/budgets', 200, 'This role may read budgets: GET /api/budgets answers 200'),
    fill(search('Search initiative budgets'), 'auth', 'Search auth: only Auth Migration stays and the roll-up count follows', { visible: [seen('Auth Migration'), seen('1 of 14 initiatives')], count: [{ target: rowsN, eq: 1 }] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search('Search initiative budgets'), 'zzzzqq', 'Search zzzzqq: the table says no initiative matches', { visible: [seen('No initiative matches this search.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search initiative budgets'), '', 'Clear the search: every initiative is back', { count: [{ target: rowsN, eq: 14 }] }),
    click(link(/^Sprints/, { css: 'main' }), 'Switch to the Sprints view (no tab strip here, so the view switch is the stability check): header and strip stay put', {
      url: /report=sprints/, visible: [h1('Sprints'), seen('Layla Hassan'), seen(/^19 of 19 envelopes$/)], count: [{ target: rowsN, min: 18 }],
      numbers: [{ of: link(/^Sprints/, { css: 'main' }), re: /(\d+)/, eqNumberOf: seen(/^\d+ of \d+ envelopes$/), reOther: /^\d+ of (\d+)/ }],
    }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }], state: 'filtered' }),
    fill(search('Search sprint envelopes'), 'zzzzqq', 'Search zzzzqq among envelopes: the table says no envelope matches', { visible: [seen(/No sprint envelope matches/)] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search sprint envelopes'), '', 'Clear the search: every envelope is back', { count: [{ target: rowsN, min: 18 }] }),
    click(link(/^Initiatives/, { css: 'main' }), 'Switch back to Initiatives: the allocations table returns', { url: /^\/admin\/budgets(?!.*report=sprints)/, visible: [h1('Initiatives'), seen('14 of 14 initiatives')] }),
    ...(c.budgets ? [
      click(btn('Set budget'), `Set budget on ${INF} (the one unallocated initiative) opens an inline editor`, { visible: [{ label: `Monthly budget for ${INF}` }] }, { state: 'dialog-open', proves: 'keyboard' }),
      press('Escape', 'Escape cancels the editor and Set budget is back', { hidden: [{ label: `Monthly budget for ${INF}` }], visible: [btn('Set budget')] }, { proves: 'keyboard' }),
      click(btn('Set budget'), 'Set budget again to type an allocation', { visible: [{ label: `Monthly budget for ${INF}` }] }),
      fill({ label: `Monthly budget for ${INF}` }, '42', 'Type 42 dollars a month into the editor', { visible: [{ label: `Monthly budget for ${INF}` }], focused: { label: `Monthly budget for ${INF}` } }),
      press('Enter', `Enter saves the allocation: ${INF} now reads $42.00 and the allocated total grows to $473.00`, { visible: [editBtn('$42.00'), seen('$473.00')], absent: [btn('Set budget')] }, { writes: true, proves: ['keyboard', 'role-gating'] }),
      reload('Reload: the saved allocation survived and the roll-up still says $473.00', { visible: [editBtn('$42.00'), seen('$473.00'), seen('14 of 14 initiatives')] }, { proves: 'role-gating' }),
      click(btn(`Remove allocation for ${INF}`), 'Remove allocation asks first and names the initiative', { visible: [dialog('Remove allocation?'), { text: /keeps accruing spend/, within: dialog('Remove allocation?') }] }, { state: 'dialog-open', proves: 'role-gating' }),
      press('Escape', 'Escape keeps the allocation: the dialog closes and $42.00 is still there', { hidden: [dialog('Remove allocation?')], visible: [editBtn('$42.00')] }, { proves: 'keyboard' }),
      click(btn(`Remove allocation for ${INF}`), 'Open Remove allocation again to confirm it', { visible: [dialog('Remove allocation?')] }, { state: 'dialog-open' }),
      click({ role: 'button', name: 'Remove', exact: true, within: dialog('Remove allocation?') }, `Remove: ${INF} is an unallocated blind spot again and the total is $431.00`, { hidden: [dialog('Remove allocation?')], visible: [btn('Set budget'), seen('$431.00')], absent: [editBtn('$42.00')] }, { writes: true }),
      reload('Reload: the removal survived, the initiative is unallocated again', { visible: [btn('Set budget'), seen('$431.00')], absent: [editBtn('$42.00')] }),
    ] : []),
    tabWalk(10),
    scoped({ scenario: 'empty', fixture: 'initiative-budgets' }, '/admin/budgets', 'In a world with no allocations every initiative reads unallocated' + (c.budgets ? ' with Set budget' : '') + ' and the roll-up says spend is over a zero allocation', 'empty', {
      visible: [h1('Initiatives'), seen('unallocated'), seen('over allocation')], noText: [/\$-\d/], ...(c.budgets ? { count: [{ target: btn('Set budget'), eq: 14 }] } : {}),
    }),
    scoped({ scenario: 'error', fixture: 'initiative-budgets' }, '/admin/budgets', 'When budgets cannot be read the page says so, not that nothing is allocated', 'error', {
      visible: [seen('Could not load budgets'), btn('Try again')],
    }, { expectConsole: E500 }),
    scoped({ scenario: 'empty', fixture: 'budget-grants' }, '/admin/budgets?report=sprints', 'In a world with no envelopes the Sprints view says none were granted and where to grant one', 'empty', {
      visible: [seen('No sprint envelopes yet'), seen(/Granting an envelope to an SME is done from Sprints/), { text: 'Open Sprints' }],
    }),
  ];
}

// ── changes-review: /admin/changes and /admin/changes/:id ───────────────────
export function changesReview(role: Role): Step[] {
  const c = CAPS[role];
  const queue = tabNamed(/^Review queue/);
  const policies = tabNamed('Policies');
  const strip = (): Target[] => [STILL.header, { role: 'tablist' }, h1('Changes')];
  return [
    open('/admin/changes', 'Open Changes: the review queue names the change, its codebase and the initiative it delivers', {
      url: '/admin/changes', visible: [h1('Changes'), queue, policies, seen('Suppress downstream pages during a cluster-wide outage'), seen('Observability Platform'), seen('3 of 3 changes')],
      ...selected(queue),
      ...(c.devbox ? { visible: [h1('Changes'), queue, seen('Suppress downstream pages during a cluster-wide outage'), btn('Approve'), btn('Reject')], numbers: [{ of: queue, re: /\((\d+)\)/, eqCount: btn('Approve') }] } : { absent: [btn('Approve'), btn('Reject')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    fill(search('Search changes'), 'dedup', 'Search dedup: the alert-dedup change stays and the count follows', { visible: [seen('Alert dedup: collapse by alertname+namespace'), seen('1 of 3 changes')] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search('Search changes'), 'zzzzqq', 'Search zzzzqq: the queue says no change matches and how to get them back', { visible: [seen('No change matches this search'), seen(/Clear the search to see the whole review queue/)] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search changes'), '', 'Clear the search: all three changes are back', { visible: [seen('3 of 3 changes')] }),
    tabClick(policies, 'Click the Policies tab: the governance rules show and the header and tab strip stay put', {
      ...selected(policies), visible: [seen('GOVERNANCE POLICIES'), seen('SENSITIVE PATHS NEED A HUMAN')],
      ...(c.devbox ? { visible: [seen('GOVERNANCE POLICIES'), seen('SENSITIVE PATHS NEED A HUMAN'), btn('+ Add policy')] } : { absent: [btn('+ Add policy'), btn('Delete')] }),
    }, strip(), { proves: ['tab-stability', 'role-gating'] }),
    tabClick(queue, 'Click the Review queue tab: the changes are back and nothing else moves', { ...selected(queue), visible: [seen('Suppress downstream pages during a cluster-wide outage')] }, strip()),
    press('Enter', 'Enter on Review diff opens the change with its files and notes', { url: /^\/admin\/changes\/[0-9a-f-]{36}$/, visible: [h1('Suppress downstream pages during a cluster-wide outage'), seen('infra/alerting/inhibit.tf'), seen('infra/alerting/routes.tf')] },
      { target: { role: 'link', name: /Review diff/, nth: 0 }, state: 'row-open', proves: 'keyboard', expectConsole: KEYWARN }),
    {
      do: 'wait', target: h1('Suppress downstream pages during a cluster-wide outage'),
      name: c.devbox ? 'This role holds ManageDevbox: the change can be approved or rejected here' : 'Without ManageDevbox the change is readable but offers no Approve or Reject',
      proves: 'role-gating', expect: c.devbox ? { visible: [btn('Approve'), btn('Reject')], noText: LEAKS } : { absent: [btn('Approve'), btn('Reject')] },
    } as Step,
    back('Browser Back returns to the queue', { url: '/admin/changes', visible: [h1('Changes'), queue] }),
    tabWalk(8),
    scoped({ scenario: 'empty', fixture: 'sdlc-changes' }, '/admin/changes', 'In a world with no changes the queue says none have been captured yet', 'empty', {
      visible: [seen('No changes yet'), seen(/captured, reviewed, and gated/), seen('0 of 0 changes')],
    }),
  ];
}

// ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageIngest and ManageKB are hr-admin only (middleware/seeds/roles/orgiq/*.cedar);
// org-leader reaches the same pages read-only.
const adminWrite = (role: Role): boolean => role === 'hr-admin';

// ── devbox: /admin/devbox (the Computer Lab) ────────────────────────────────
export function devbox(role: Role): Step[] {
  const c = CAPS[role];
  const fleet = { role: 'tablist', name: 'Fleet' } as Target;
  const computers = tabNamed(/^Computers/);
  const agents = tabNamed(/^Agents/);
  const VIEWER = /You can see the fleet but not drive it/;
  // The fleet each persona's clone sees: hr-admin's has her scratch computer, an sme's is the initiatives she sits on.
  const scratch = role === 'hr-admin' ? { name: 'rachel-scratch', query: 'rachel' } : { name: 'auth-migration-2', query: 'migration-2' };
  const agentLine = role === 'hr-admin' ? /running · / : /needs you/;
  return [
    open('/admin/devbox', 'Open the Computer Lab: the fleet grouped by initiative with each computer named, its spend against the initiative budget', {
      url: '/admin/devbox', visible: [computers, agents, seen('Observability Platform'), seen('observability-1'), seen(/\d+ computers/)],
      numbers: [{ of: computers, re: /(\d+)/, eqNumberOf: seen(/^\d+ computers/), reOther: /^(\d+)/ }],
      ...(c.devbox ? { noText: [VIEWER] } : { visible: [computers, agents, seen('observability-1'), seen(VIEWER)] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/devbox/boxes', 200, 'This role may read the fleet: GET /api/devbox/boxes answers 200'),
    tabClick(agents, 'Click the Agents view (the Lab has no filter box, so the view switch is the stability check): the running agents list by work item and the header stays put', {
      ...selected(agents), ...(role === 'hr-admin' ? { visible: [seen(agentLine)] } : { visible: [seen(/\d+ computers · \d+ agents/)], numbers: [{ of: agents, re: /(\d+)/, eqNumberOf: seen(/\d+ computers · \d+ agents/), reOther: /· (\d+) agents/ }] }),
    }, [STILL.header, fleet], { proves: ['tab-stability', 'story-facts'], state: 'filtered' }),
    tabClick(computers, 'Click the Computers view: the fleet is back, grouped by initiative', { ...selected(computers), visible: c.devbox ? [seen('Auth Migration'), seen('auth-migration-2')] : [seen('auth-migration-2'), seen('observability-1')] }, [STILL.header, fleet]),
    press('Enter', 'Enter on the Agents tab (focused by the key press) selects it', { ...selected(agents), focused: agents }, { target: agents, proves: 'keyboard' }),
    click(computers, 'Back to the Computers view with the mouse', { ...selected(computers), visible: [seen(scratch.name)] }),
    fill({ placeholder: 'Find computer or agent…' }, 'zzzzqq', 'Find zzzzqq: the lab says nothing matches instead of an empty rail', { visible: [seen('Nothing matches.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill({ placeholder: 'Find computer or agent…' }, scratch.query, `Find ${scratch.query}: only ${scratch.name} stays`, { visible: [seen(scratch.name)], absent: [{ text: 'observability-1', exact: true }] }, { state: 'filtered' }),
    fill({ placeholder: 'Find computer or agent…' }, '', 'Clear the find box: the whole fleet is back', { visible: [seen('observability-1'), seen(scratch.name)] }),
    tabWalk(10),
  ];
}

// ── scores: /iq/scores, /iq/scores/cohorts, /iq/scores/compare ──────────────
export function scores(_role: Role): Step[] {
  const people = seen(/^\d+ people$/);
  const compareBox = (name: string): Target => ({ role: 'checkbox', name: `Compare ${name}` });
  return [
    open('/iq/scores', 'Open Scores: people ranked by composite score with their department, a header count that agrees with the rows', {
      url: '/iq/scores', visible: [h1('Scores'), people, seen('Vera Green'), seen('Platform Engineering'), btn('How scoring works')],
      count: [{ target: tableRows, min: 40 }], numbers: [{ of: people, re: /(\d+)/, eqCount: tableRows }],
    }, { facts: true }),
    api('/api/scores/leaderboard?limit=1', 200, 'This role may read the leaderboard: GET /api/scores/leaderboard answers 200'),
    press('Enter', 'Enter on the first person opens their score beside the table (this stack has no radar or contribution data for anyone: the page asks and is answered 404)', { url: /[?&]person=p-/, visible: [btn('Why this score?'), btn('Close')] }, { target: firstRow, state: 'row-open', proves: 'keyboard', expectConsole: /404/ }),
    click(btn('Close'), 'Close the person pane: the address loses the person and the whole table is still there', { url: /^\/iq\/scores(?!.*person=)/, visible: [people], count: [{ target: tableRows, min: 40 }] }),
    click(compareBox('Vera Green'), 'Tick Vera Green to compare', { count: [{ target: { css: 'input[aria-label="Compare Vera Green"]:checked' }, eq: 1 }] }, { state: 'filtered' }),
    click(compareBox('Nora DaSilva'), 'Tick Nora DaSilva too: a Compare button appears', { visible: [btn(/^Compare/)] }),
    click(btn(/^Compare/), 'Compare opens the page for the two people', { url: /^\/iq\/scores\/compare\?ids=p-\d+,p-\d+/, visible: [h1('Compare 2 people'), link('← Back to Scores')] }, { state: 'row-open' }),
    click(link('Cohorts', { css: '[data-shell-nav]' }), 'Open Cohorts: departments with their size and median, brokers named', {
      url: '/iq/scores/cohorts', visible: [h1('Score Cohorts'), seen('Platform Engineering'), seen(/\d+ people · median/), seen('Isabel Vasquez')], noText: LEAKS,
    }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    click(link('Overview', { css: '[data-shell-nav]' }), 'Back to the Overview: the leaderboard again', { url: '/iq/scores', visible: [h1('Scores'), people] }),
    tabWalk(10),
    scoped({ scenario: 'empty', fixture: 'scores' }, '/iq/scores', 'In a world with nobody scored the page says so in plain words and names no command to run', 'empty', {
      visible: [seen('No scored people yet'), seen(/computed by the scoring agent/)], noText: [/schema\/seed\.py/, /python /],
    }),
    scoped({ scenario: 'empty', fixture: 'scores' }, '/iq/scores/cohorts', 'In the same world Cohorts says departments appear once people are scored', 'empty', {
      visible: [seen('No department data yet'), seen(/Once people have been scored/)], noText: [/schema\/seed\.py/],
    }),
    scoped({ scenario: 'error', fixture: 'scores' }, '/iq/scores', 'When scores cannot be read the page says so, not that nobody is scored', 'error', {
      visible: [seen('Could not load scores'), btn('Try again')],
    }, { expectConsole: E500 }),
  ];
}

// ── observability: /admin/observability/summary, invocations, tools ─────────
export function observability(_role: Role): Step[] {
  const rows = tableRows;
  const railLink = (href: string): Target => ({ css: `[data-shell-nav] a[href="${href}"]` });
  return [
    open('/admin/observability/summary', 'Open the Overview: what is deployed, whether it is working and what needs attention, agents by name', {
      url: '/admin/observability/summary', visible: [h1('Overview'), seen(/deployed agents/i), seen('Supervisor'), seen('Search'), seen(/what to do next/i)], noText: LEAKS,
    }, { facts: true }),
    api('/api/observability/recent-invocations?limit=1', 200, 'This role may read observability: GET /api/observability/recent-invocations answers 200'),
    click(railLink('/admin/observability/invocations'), 'Open Runs from the observability rail: the live invocation list, a header count that agrees with the rows', {
      url: '/admin/observability/invocations', visible: [h1('Runs'), seen(/last \d+ invocations/), seen('Supervisor'), seen('Search & triage →')],
      count: [{ target: rows, min: 20 }], numbers: [{ of: seen(/last \d+ invocations/), re: /last (\d+)/, eqCount: rows }],
    }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    fill(search('Search runs'), 'zzzzqq', 'Search zzzzqq: the list says no invocation matches and offers Clear filters', { visible: [seen('No invocations match'), seen(/No invocations match the current filters/), btn('Clear filters')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search runs'), 'kubernetes', 'Search kubernetes: the supervisor question about it stays', { visible: [seen('Who knows Kubernetes best on the platform team?')], count: [{ target: rows, min: 1, max: 5 }] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search('Search runs'), '', 'Clear the search: the whole list is back', { count: [{ target: rows, min: 20 }] }),
    press('Enter', 'Enter on the Kubernetes invocation\'s time link opens its trace (the list\'s newest rows come from live runs, whose traces are not stored)', { url: /^\/admin\/observability\/invocations\/[^/]+$/, visible: [h1('Supervisor'), seen(/tool calls/i), seen('Who knows Kubernetes best on the platform team?')] }, { target: { css: 'main tbody tr:has-text("Who knows Kubernetes best on the platform team?") a', nth: 0 }, state: 'row-open', proves: 'keyboard' }),
    back('Browser Back returns to the list', { url: '/admin/observability/invocations', visible: [h1('Runs')] }),
    open('/admin/observability/tools', 'Open Tool Calls: each tool with its calls, latency and error rate', {
      url: '/admin/observability/tools', visible: [h1('Tool Calls'), seen('route_to_agent'), seen(/\d+ tools · \d+ calls/)],
      count: [{ target: rows, min: 10 }], numbers: [{ of: seen(/^\d+ of \d+ tools$/), re: /^(\d+)/, eqNumberOf: seen(/^\d+ tools · \d+ calls/), reOther: /^(\d+)/ }],
    }, { facts: true }),
    fill(search('Filter by tool name'), 'zzzzqq', 'Filter zzzzqq: the table says no tool matches and how to widen it', { visible: [seen('No tool matches these filters'), seen(/Widen the window/)] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Filter by tool name'), '', 'Clear the filter: every tool is back', { count: [{ target: rows, min: 10 }] }),
    tabWalk(10),
  ];
}

// ── knowledge: /admin/knowledge and a knowledge base ────────────────────────
export function knowledge(role: Role): Step[] {
  const w = adminWrite(role);
  const kb = 'OrgIQ Knowledge Base';
  return [
    open('/admin/knowledge', 'Open Knowledge: each knowledge base checked against the live account, the broken one flagged', {
      url: '/admin/knowledge', visible: [h1('Knowledge'), seen(kb), seen('OrgIQ Legacy Docs'), seen('in sync'), seen(/^\d+ of \d+ knowledge bases/)],
      count: [{ target: tableRows, eq: 3 }], numbers: [{ of: seen(/^\d+ of \d+ knowledge bases/), re: /^(\d+)/, eqCount: tableRows }],
      ...(w ? { visible: [h1('Knowledge'), seen(kb), seen('OrgIQ Legacy Docs'), btn('Sync now')] } : { absent: [btn('Sync now')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/admin/kb-registry', 200, 'This role may read the registry: GET /api/admin/kb-registry answers 200'),
    click({ role: 'radio', name: 'Needs attention' }, 'Needs attention keeps the knowledge base that points at nothing', { visible: [seen('OrgIQ Legacy Docs'), seen('points at nothing')], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered', proves: ['empty-state', 'tab-stability'], stable: [STILL.header, h1('Knowledge')] }),
    click({ role: 'radio', name: 'All' }, 'All brings the three knowledge bases back', { count: [{ target: tableRows, eq: 3 }] }),
    fill(search('Search by name, slug or id…'), 'zzzzqq', 'Search zzzzqq: the registry says no knowledge base matches', { visible: [seen('No knowledge bases match the current filters.'), seen('0 of 3 knowledge bases')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search by name, slug or id…'), '', 'Clear the search: the three are back', { count: [{ target: tableRows, eq: 3 }] }),
    press('Enter', 'Enter on the knowledge base name opens its page', { url: /^\/admin\/knowledge\/registry\/[0-9a-f-]{36}$/, visible: [seen(kb), seen('Pipeline chain'), seen('Landing zone')] }, { target: link(kb), state: 'row-open', proves: 'keyboard' }),
    { do: 'wait', target: seen('Pipeline chain'), name: w ? 'This role holds ManageKB: Sync Now is on the page' : 'Without ManageKB the knowledge base is readable and offers no Sync Now', proves: 'role-gating', expect: w ? { visible: [btn('Sync Now')], noText: LEAKS } : { absent: [btn('Sync Now')] } } as Step,
    back('Browser Back returns to the registry', { url: '/admin/knowledge', visible: [h1('Knowledge')] }),
    tabWalk(8),
  ];
}

// ── capabilities: guardrails, code interpreter, browser ─────────────────────
export function capabilities(role: Role): Step[] {
  const w = adminWrite(role);
  const c = CAPS[role];
  const browserTabs = { role: 'tablist', name: 'Browser diagnostics' } as Target;
  const qa = tabNamed('Web Q&A'); const journey = tabNamed('Journey Recorder'); const sessions = tabNamed('Sessions');
  return [
    open('/admin/capabilities/guardrails', 'Open Guardrails: the live guardrail with its thresholds, PII actions and denied topics', {
      url: '/admin/capabilities/guardrails', visible: [seen('orgiq-guardrail'), seen('PII Filters'), seen('Content Policy'), seen('Denied Topics'), seen('READY')],
      ...(w ? { visible: [seen('orgiq-guardrail'), seen('PII Filters'), btn('Add'), btn('Edit'), btn('Delete')] } : { absent: [btn('Add'), btn('Edit'), btn('Delete')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/capabilities/guardrail', 200, 'This role may read the guardrail: GET /api/capabilities/guardrail answers 200'),
    open('/admin/capabilities/code-interpreter', 'Open Code Interpreter: the sandbox sessions, who ran them and the traces', {
      url: '/admin/capabilities/code-interpreter', visible: [h1('Code Interpreter'), seen('Run Python'), seen(/active sessions/), seen('graph-builder')],
      ...(c.devbox ? { visible: [h1('Code Interpreter'), seen('Run Python'), btn('Run'), btn('Terminate')] } : { absent: [btn('Terminate')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    { do: 'wait', target: seen('Past Sessions'), name: 'Code Interpreter says in words that nothing has run yet: no traces, no agent executions, no past sessions', state: 'empty', proves: 'empty-state', expect: { visible: [seen(/No code executions in this process/), seen(/No agent-driven sandbox executions/), seen('No past sessions yet.')] } } as Step,
    open('/admin/capabilities/browser', 'Open Browser: diagnostics for the browser capability, the stale profile named', {
      url: '/admin/capabilities/browser', visible: [h1('Browser'), qa, journey, sessions, seen(/Browser profile/)], ...selected(qa),
    }, { facts: true }),
    tabClick(journey, 'Click Journey Recorder: the recorder shows and the header, tab strip and title stay put', { ...selected(journey), ...(c.devbox ? { visible: [seen('Start journey')] } : { visible: [seen(/Viewing only — your role can't start a journey/), seen('Open sessions below can still be replayed.')], absent: [btn('Start journey')] }) }, [STILL.header, browserTabs, h1('Browser')]),
    tabClick(sessions, 'Click Sessions: the open browser sessions list by label and status', { ...selected(sessions), visible: [seen(/Open sessions/), seen('ACTIVE')] }, [STILL.header, browserTabs, h1('Browser')]),
    press('ArrowLeft', 'ArrowLeft on the Sessions tab moves back to Journey Recorder', { ...selected(journey) }, { target: sessions, proves: 'keyboard' }),
    tabClick(qa, 'Click Web Q&A: the question form is back', { ...selected(qa), ...(c.devbox ? { visible: [seen('Ask a webpage'), btn('Ask the page')] } : { visible: [seen('Ask a webpage'), seen(/Viewing only — your role can't drive the browser/)], absent: [btn('Ask the page')] }) }, [STILL.header, browserTabs, h1('Browser')]),
    tabWalk(8),
  ];
}

// ── prompts: /iq/prompts, /iq/agents (+ an agent), /iq/evaluations ──────────
export function prompts(_role: Role): Step[] {
  const sup = 'orgiq-supervisor-system-prompt';
  return [
    open('/iq/prompts', 'Open Prompt Studio: the system prompts the agents read, each named and described', {
      url: '/iq/prompts', visible: [h1('Prompt Studio'), seen(sup), seen('orgiq-search-system-prompt'), seen(/Routes an org question/), btn('+ New prompt')], noText: LEAKS,
    }, { facts: true }),
    api('/api/observability/canary', [200, 404], 'This role may read prompt operations: the canary read is not refused', 'role-gating'),
    click({ css: 'main button:has-text("orgiq-search-system-prompt")' }, 'Open the search agent prompt: its editor names it and offers Test and Edit', { visible: [{ role: 'heading', name: 'orgiq-search-system-prompt' }, btn('Test'), btn('Edit')] }, { state: 'row-open', proves: 'keyboard' }),
    fill(search('Search prompts…'), 'zzzzqq', 'Search zzzzqq: no prompt matches', { count: [{ target: { css: 'main button:has-text("-system-prompt")' }, eq: 0 }] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search prompts…'), '', 'Clear the search: the six prompts are back', { count: [{ target: { css: 'main button:has-text("-system-prompt")' }, min: 6 }] }),
    open('/iq/agents', 'Open the agent architecture: the fleet as a diagram with calls, errors and latency per agent', {
      url: '/iq/agents', visible: [h1('Architecture'), seen('Supervisor'), seen('Graph Builder'), seen(/Online/), seen(/not on this diagram/)], noText: LEAKS,
    }, { facts: true }),
    click({ role: 'radio', name: 'List' }, 'Switch to List: the nine agents with status, model and tools', { url: /[?&]view=list/, visible: [seen('9 agents'), seen('orgiq-search'), seen('healthy')], count: [{ target: tableRows, min: 9 }], numbers: [{ of: seen(/^\d+ agents$/), re: /(\d+)/, eqCount: tableRows }] }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, h1('Architecture')] }),
    press('Enter', 'Enter on the Supervisor opens its page', { url: '/iq/agents/orgiq-supervisor', visible: [h1('Supervisor'), seen('Running now'), seen('Recent invocations'), seen(/Calls \(24h\)/)] }, { target: link('Supervisor'), state: 'row-open', proves: 'keyboard' }),
    back('Browser Back returns to the list', { url: /^\/iq\/agents/, visible: [h1('Architecture')] }),
    open('/iq/evaluations', 'Open Evals: the judge model and the rubric weights', {
      url: '/iq/evaluations', visible: [h1('Evals'), seen(/LLM-as-Judge/), seen('Nova Pro'), seen('Helpfulness'), btn('Save configuration')],
    }, { facts: true }),
    tabWalk(8),
  ];
}

// ── identity: users, roles, policies ────────────────────────────────────────
export function identity(role: Role): Step[] {
  const w = adminWrite(role);
  const users = seen(/^\d+ of \d+ users$/);
  const sub = (name: string): Target => link(name, { css: '[data-shell-nav]' });
  return [
    open('/admin/identity/users', 'Open Users: login-able people by name with their per-workspace role grants and a header count that agrees with the rows', {
      url: '/admin/identity/users', visible: [h1('Users & Tenants'), users, seen('Theo Chang'), seen('Rachel Kowalski'), seen('orgiq/hr-admin')],
      count: [{ target: tableRows, min: 20 }], numbers: [{ of: users, re: /^(\d+)/, eqCount: tableRows }],
      ...(w ? { visible: [h1('Users & Tenants'), seen('Theo Chang'), btn('+ User'), btn('+ Tenant')] } : { absent: [btn('+ User'), btn('+ Tenant')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/identity/users', [200], 'This role may read the identity directory: GET /api/identity/users answers 200'),
    fill(search('Search users'), 'rachel', 'Search rachel: one person stays, with her grants', { visible: [seen('Rachel Kowalski'), seen('1 of 24 users'), seen('orgiq/hr-admin')], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search('Search users'), 'zzzzqq', 'Search zzzzqq: the table says no user matches', { visible: [seen('No user matches this search.'), seen('0 of 24 users')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search users'), 'theo', 'Search theo: Theo Chang is the one match', { visible: [seen('Theo Chang'), seen('theo.chang@orgiq.example')], count: [{ target: tableRows, eq: 1 }] }),
    press('Enter', 'Enter on the row opens Theo Chang with his person link and grants', { url: /^\/admin\/identity\/users\/[^/]+$/, visible: [seen('Person link'), seen('Grants'), seen('Theo Chang')] }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    back('Browser Back returns to the filtered user list', { url: /^\/admin\/identity\/users/, visible: [h1('Users & Tenants')] }),
    fill(search('Search users'), '', 'Clear the search: every user is back before moving on', { visible: [seen('24 of 24 users')] }),
    click(sub('Roles'), 'Open Roles from the identity rail: the permission matrix names each action and role', {
      url: '/admin/identity/roles', visible: [h1('Roles'), seen('Permission matrix'), seen(/^\d+ of \d+ actions$/), seen('HR Admin')], count: [{ target: tableRows, min: 40 }],
      numbers: [{ of: seen(/^\d+ of \d+ actions$/), re: /^(\d+)/, eqCount: tableRows }],
    }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    fill(search('Search actions'), 'zzzzqq', 'Search zzzzqq: the matrix says no action matches', { visible: [seen('0 of 53 actions')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search actions'), 'ManageBots', 'Search ManageBots: the one action stays with who may do it', { visible: [seen('ManageBots')], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered' }),
    click(sub('Policies'), 'Open Policies from the identity rail: in this local stack the policy store is not configured and the page says it does not know, not that there are none', {
      url: '/admin/identity/policies', visible: [h1('Cedar Policies'), seen('Could not load policies'), btn('Try again')],
    }, { proves: ['tab-stability', 'empty-state'], stable: [STILL.header, { css: '[data-shell-nav] aside' }], state: 'error', expectConsole: /503/ }),
    tabWalk(8),
  ];
}

// ── ingest: crawl targets, crawl runs, KB sync ──────────────────────────────
export function ingest(role: Role): Step[] {
  const w = adminWrite(role);
  const wiki = 'AWS Well-Architected docs';
  return [
    open('/admin/ingest/crawl', 'Open Sources: connected systems and the crawl targets by label, each with its mode and last status', {
      url: '/admin/ingest/crawl', visible: [h1('Sources'), seen(/connected sources/i), seen(wiki), seen('Internal engineering wiki'), seen(/^\d+ of \d+ targets$/)],
      count: [{ target: tableRows, eq: 3 }], numbers: [{ of: seen(/^\d+ of \d+ targets$/), re: /^(\d+)/, eqCount: tableRows }],
      ...(w ? { visible: [h1('Sources'), seen(wiki), btn('+ New Target'), btn('+ Connect')] } : { absent: [btn('+ New Target'), btn('+ Connect')] }),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/ingest/targets', [200, 404], 'This role may read the crawl targets: the read is not refused'),
    fill(search('Search crawl targets'), 'zzzzqq', 'Search zzzzqq: the table says no target matches', { count: [{ target: tableRows, eq: 0 }] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search crawl targets'), 'wiki', 'Search wiki: the internal wiki stays', { visible: [seen('Internal engineering wiki')], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search('Search crawl targets'), '', 'Clear the search: the three targets are back', { count: [{ target: tableRows, eq: 3 }] }),
    press('Enter', 'Enter on the first target opens it with its settings and recent runs', { url: /^\/admin\/ingest\/crawl\/target-/, visible: [seen(wiki), seen('Settings'), seen('Recent runs')] }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    click(link(/^Runs/, { css: '[data-shell-nav]' }), 'Open Runs from the pipeline rail: what each crawl did, by target name, status and cost', {
      url: '/admin/ingest/history', visible: [h1('Crawl runs'), seen(wiki), seen(/^\d+ of \d+ runs$/), seen('running'), seen('failed')], count: [{ target: tableRows, eq: 5 }],
      numbers: [{ of: seen(/^\d+ of \d+ runs$/), re: /^(\d+)/, eqCount: tableRows }],
    }, { facts: true, proves: ['story-facts', 'tab-stability'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    click(btn('Failed'), 'Filter to the failed runs: only the wiki crawl that failed stays', { visible: [seen('Internal engineering wiki'), seen('failed')], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered' }),
    fill(search('Search crawl runs'), 'zzzzqq', 'Search zzzzqq among the failed runs: the table says no crawl run matches the search and status', { visible: [seen('No crawl run matches this search and status.'), seen('0 of 5 runs')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search crawl runs'), '', 'Clear the search: the failed run is back', { visible: [seen('Internal engineering wiki')], count: [{ target: tableRows, eq: 1 }] }),
    click(btn('All'), 'All brings the five runs back', { count: [{ target: tableRows, eq: 5 }] }),
    click(link(/^KB sync/, { css: '[data-shell-nav]' }), 'Open KB sync from the pipeline rail: the data source that feeds the knowledge base and the sync jobs it ran', {
      url: '/admin/ingest/sources', visible: [h1('KB sync'), seen('Data Sources'), seen('orgiq-documents-s3'), seen(/1 of 1 sources · 3 of 3 jobs/)], count: [{ target: tableRows, min: 4 }],
    }, { facts: true, proves: ['story-facts', 'tab-stability'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    tabWalk(8),
  ];
}

// ── codebases: /admin/projects ──────────────────────────────────────────────
export function codebases(role: Role): Step[] {
  const w = adminWrite(role);
  const c = CAPS[role];
  const zt = 'connorhoehnslalom/orgiq-zero-trust';
  return [
    open('/admin/projects', 'Open Codebases: each repository with the initiative it delivers, by name', {
      url: '/admin/projects', visible: [h1('Codebases'), seen(zt), seen('Zero Trust Network'), seen(/^\d+ of \d+ codebases$/)], noText: LEAKS,
      ...(c.devbox ? { visible: [h1('Codebases'), seen(zt), seen('Zero Trust Network'), btn('+ Link a repository'), btn('Clone into workspace')] } : {}),
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/agent-projects', 200, 'This role may read the codebases: GET /api/agent-projects answers 200'),
    fill(search('Search codebases'), 'zzzzqq', 'Search zzzzqq: the page says no codebase matches', { visible: [seen('No codebase matches this search'), seen(/Clear the search to see every linked codebase/), seen('0 of 14 codebases')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search codebases'), 'zero', 'Search zero: only the zero-trust repository stays', { visible: [seen(zt), seen('1 of 14 codebases')] }, { state: 'filtered', proves: ['empty-state', 'tab-stability'], stable: [STILL.header, h1('Codebases')] }),
    fill(search('Search codebases'), '', 'Clear the search: all fourteen are back', { visible: [seen('14 of 14 codebases')] }),
    click(btn('unlink'), 'Unlink asks first and names the repository (nothing is unlinked)', { visible: [dialog(/Unlink/)] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape keeps the link and the dialog closes', { hidden: [dialog(/Unlink/)], visible: [seen(zt)] }, { proves: 'keyboard' }),
    { do: 'wait', target: link('Zero Trust Network'), name: 'The codebase names the initiative it delivers and links to it', proves: 'story-facts', expect: { attr: [{ target: link('Zero Trust Network'), name: 'href', value: '/iq/projects/p-zero-trust' }], noText: LEAKS } } as Step,
    open('/admin/projects?project=340cfae2-476d-533d-a291-49d29d3f1496', 'Open the zero-trust codebase by its link: the page lands on it and keeps all fourteen on the page', {
      url: '/admin/projects?project=340cfae2-476d-533d-a291-49d29d3f1496', visible: [h1('Codebases'), seen(zt), seen('Zero Trust Network'), seen('14 of 14 codebases')],
    }, { state: 'row-open' }),
    tabWalk(8),
    scoped({ scenario: 'empty', fixture: 'agent-projects' }, '/admin/projects', 'In a world with no codebases the page says to link one and that public repositories need no credential', 'empty', {
      visible: [seen('No codebases linked'), seen(/Public repositories need no credential/)],
    }),
  ];
}

// ── The registry: the map each role instantiates ────────────────────────────
const PAGE_FILES: Record<string, string> = {
  runs: 'portal/src/pages/iq/RunsPage.tsx, portal/src/components/runs/RunsLedger.tsx, portal/src/pages/pipelines/RunDetailPage.tsx',
  bots: 'portal/src/pages/bots/BotsPage.tsx, portal/src/pages/bots/BotDetailPage.tsx',
  budgets: 'portal/src/pages/budgets/BudgetsPage.tsx, portal/src/pages/budgets/InitiativesReport.tsx, portal/src/pages/budgets/SprintsReport.tsx',
  'changes-review': 'portal/src/pages/admin/ChangesPage.tsx, portal/src/pages/admin/ChangeReviewPage.tsx',
  devbox: 'portal/src/pages/admin/DevboxPage.tsx, portal/src/components/compute/ComputeHost.tsx',
  scores: 'portal/src/pages/ScoresPage.tsx, portal/src/pages/ScoresCohortPage.tsx, portal/src/pages/ScoresComparePage.tsx',
  observability: 'portal/src/pages/observability/SummaryPage.tsx, portal/src/pages/observability/InvocationsPage.tsx, portal/src/pages/observability/InvocationDetailPage.tsx, portal/src/pages/observability/ToolCallsPage.tsx',
  knowledge: 'portal/src/pages/knowledge/KnowledgeHomePage.tsx, portal/src/pages/admin/KBDetailPage.tsx, portal/src/pages/admin/KBRegistryPage.tsx',
  capabilities: 'portal/src/pages/capabilities/GuardrailsPage.tsx, portal/src/pages/capabilities/CodeInterpreterPage.tsx, portal/src/pages/capabilities/BrowserPage.tsx',
  prompts: 'portal/src/pages/capabilities/PromptsPage.tsx, portal/src/pages/AgentFlowPage.tsx, portal/src/pages/iq/AgentDetailPage.tsx, portal/src/pages/iq/EvaluationsPage.tsx',
  identity: 'portal/src/pages/identity/UsersPage.tsx, portal/src/pages/identity/RolesPage.tsx, portal/src/pages/identity/PoliciesPage.tsx',
  ingest: 'portal/src/pages/ingest/CrawlTargetsPage.tsx, portal/src/pages/ingest/RunHistoryPage.tsx, portal/src/pages/ingest/DataSourcesPage.tsx',
  codebases: 'portal/src/pages/admin/AgentProjectsPage.tsx',
};
const GOAL: Record<string, string> = {
  runs: 'Agent runs: status and kind, search, open the run record and its brief, a missing run, the empty and error worlds',
  bots: 'Bots: the fleet, search, open a bot and its tabs held still, New bot gated by ManageBots, empty and error',
  budgets: 'Budgets: allocations and sprint envelopes, search, set an allocation read back after a reload, Remove allocation asks first and Escape keeps it, empty and error',
  'changes-review': 'Code review: the queue and policies tabs held still, open a change, an empty queue',
  devbox: 'The computer lab: the fleet, drive controls gated by ManageDevbox with the sentence for a viewer, empty and error',
  scores: 'Expertise scores: people by score, cohorts, compare two people by name, no scores, an error',
  observability: 'Observability: health, invocations and tool calls, a search that finds nothing, open an invocation',
  knowledge: 'Knowledge bases: the registry against live Bedrock, open a knowledge base',
  capabilities: 'Capabilities: guardrails, code interpreter and browser; editing gated by EditGuardrail and ManageDevbox',
  prompts: 'Prompt studio, the agent architecture and evaluations: open a prompt and an agent by name',
  identity: 'Identity: users by name, roles, policies; a search that finds nobody; open a user and their grants',
  ingest: 'Ingest: crawl targets, history and sources; open a crawl',
  codebases: 'Codebases: the agent projects and what each delivers',
};
const ADMIN_STEPS: Record<string, (role: Role) => Step[]> = {
  runs, bots, budgets, 'changes-review': changesReview, devbox, scores, observability, knowledge, capabilities, prompts, identity, ingest, codebases,
};
/** Journeys that write: they run inside a scoped mock world and read the write back after a reload. */
const WRITING = new Set(['budgets']);

/** The map a role walks for one admin surface: `docs/journeys/maps/work/<role>/<journey>.ts` is one line of this. */
export function adminMap(role: Role, journey: string, opts: Partial<JourneyMap> = {}): JourneyMap {
  const steps = ADMIN_STEPS[journey];
  if (!steps) throw new Error(`no admin steps for ${journey}`);
  const writes = WRITING.has(journey) && CAPS[role].budgets;
  return {
    family: 'work', log: `${role}/${journey}`, kind: 'surface', persona: PERSONA[role], identity: 'clone',
    scenario: writes ? { scope: 'default' } : 'shared', ...(writes ? { writes: true } : readOnlyPostsFor(role)),
    viewport: { width: 1440, height: 900 },
    goal: `${PERSONA[role].name}: ${GOAL[journey]}`,
    fields: { surface: journey, pages: PAGE_FILES[journey] ?? 'portal/src/pages' },
    steps: steps(role), ...opts,
  };
}
