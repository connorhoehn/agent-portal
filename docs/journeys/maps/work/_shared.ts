// Shared pieces of the work family's maps (docs/work-journeys/PROTOCOL.md, docs/work-journeys-goal.md). The Work
// tenant (`orgiq`) is walked once per surface per role; each surface's steps are written ONCE here as a function of
// the role, so a later role's map is one line (`surfaceMap('sme', 'initiatives')`) and differs from member's only
// where its grants do (the capability table below, read from middleware/seeds/roles/orgiq/*.cedar).
//
// Not a map: files starting with `_` are fragments. Every page step is measured by the DOM audit; every click, key,
// fill, reload and back asserts the state it produced; every navigate asserts what it shows. Walked as CLONES of the
// persona (never the seed user), headless, never in the user's Chrome.
import type { Expect, JourneyMap, Persona, Step, Target, Text } from '../../../../scripts/journeys/journey-map.ts';
import { readRouteSources } from '../../../../portal/e2e/route-sources.ts';

// ── Who walks ───────────────────────────────────────────────────────────────
export type Role = 'member' | 'sme' | 'program-owner' | 'org-leader' | 'hr-admin';
export const ROLES: Role[] = ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin'];

/** `switchRole` only where the persona lands on another role (u-mia, u-vera, u-release land as member, u-rachel as org-leader). */
export const PERSONA: Record<Role, Persona> = {
  member: { user: 'u-theo', name: 'Theo Chang', tenant: 'orgiq', role: 'member' },
  sme: { user: 'u-nora', name: 'Nora DaSilva, SME on Auth Migration', tenant: 'orgiq', role: 'sme' },
  'program-owner': { user: 'u-mia', name: 'Mia Singh, program owner', tenant: 'orgiq', role: 'program-owner', switchRole: true },
  'org-leader': { user: 'u-vera', name: 'Vera Green, owner of Auth Migration', tenant: 'orgiq', role: 'org-leader', switchRole: true },
  'hr-admin': { user: 'u-rachel', name: 'Rachel Kowalski', tenant: 'orgiq', role: 'hr-admin', switchRole: true },
};
/** Sienna Garcia, the release manager, for the journeys that are hers (budgets, envelopes, the escalated decision). */
export const RELEASE_MANAGER: Persona = { user: 'u-release', name: 'Sienna Garcia, release manager', tenant: 'orgiq', role: 'org-leader', switchRole: true };

/** What each role may do in the Work tenant (the Cedar actions of middleware/seeds/roles/orgiq/<role>.cedar). */
export interface Caps {
  dispatch: boolean;       // DispatchAgentRun: prepare and send a job, create and edit work
  sprints: boolean;        // ManageSprints: New sprint, envelopes
  budgets: boolean;        // ManageBudgets: figures unlocked, allocations
  bots: boolean;           // ManageBots
  devbox: boolean;         // ManageDevbox: review and requeue, drive a computer
  reviewRunbook: boolean;  // ReviewRunbook
  localCompute: boolean;   // ConnectLocalCompute
  libraryNew: boolean;     // New asset (org-leader, hr-admin)
  composerPost: boolean;   // may post to an initiative discussion
}
export const CAPS: Record<Role, Caps> = {
  member: { dispatch: false, sprints: false, budgets: false, bots: false, devbox: false, reviewRunbook: false, localCompute: true, libraryNew: false, composerPost: false },
  sme: { dispatch: true, sprints: true, budgets: false, bots: true, devbox: true, reviewRunbook: true, localCompute: true, libraryNew: false, composerPost: true },
  'program-owner': { dispatch: true, sprints: true, budgets: true, bots: true, devbox: false, reviewRunbook: true, localCompute: false, libraryNew: false, composerPost: true },
  'org-leader': { dispatch: true, sprints: true, budgets: true, bots: true, devbox: false, reviewRunbook: true, localCompute: true, libraryNew: true, composerPost: true },
  'hr-admin': { dispatch: true, sprints: false, budgets: true, bots: true, devbox: true, reviewRunbook: false, localCompute: true, libraryNew: true, composerPost: true },
};

// ── What no page may show a person ──────────────────────────────────────────
/** Raw ids and slugs, ISO stamps, template filler, developer copy (the demo family's rubric, shared). */
export const LEAKS: Text[] = [
  /\b(?:p-\d{3}|u-(?:operator|theo|vera|hr|release|rachel|mia|nora|eli|layla|caleb|asha|jonas|farah|mira|lena|sana|ines|kofi|dara|tomas|rhea|omar|priya))\b/,
  /\bwi-[a-z0-9]+(?:-[a-z0-9]+)+\b/, /\bdes-[a-z0-9]+(?:-[a-z0-9]+)*\b/, /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /\b(?:undefined|NaN)\b|\[object Object\]/, /\(\+\d+ more\)/,
  /\b(?:dev:mock|fixture|MOCK_[A-Z_]+)\b/,
];

/** Visible inside the page's content (<main>), the first match a reader can see (`{ text }` finds the breadcrumb's hidden copies first). */
export const seen = (text: Text): Target => ({
  css: typeof text === 'string'
    ? `main :visible:has-text(${JSON.stringify(text)})`
    : `main :visible:text-matches(${JSON.stringify(text.source)}, "${text.flags.replace(/[^i]/g, '')}")`,
});

// ── Targets ─────────────────────────────────────────────────────────────────
export const STILL = {
  header: { css: '.shell-header' } as Target,
  initiativeHeader: { testId: 'initiative-header' } as Target,
  pane: { testId: 'initiative-pane' } as Target,
  tablist: (name: Text): Target => ({ role: 'tablist', name }),
};
// The accessible name is the label, the activity marker, then the count badge:
// "Communication 1 conversation with unread messages · 1 unread notice in this inbox 1".
// navigationActivity keeps unread conversations and inbox notices as separate categories.
export const rail = (name: string): Target => ({ role: 'link', name: new RegExp(`^${name}(?: ?(?:\\d+ conversations? with unread messages(?: · \\d+ unread notices? in this inbox)?|\\d+ unread notices? in this inbox))?(?: ?\\d+)?$`), within: { css: '[data-shell-nav]' } });
export const search = (name: string): Target => ({ role: 'textbox', name, exact: true });
export const tableRows: Target = { css: 'main tbody tr' };
export const firstRow: Target = { css: 'main tbody tr', nth: 0 };
export const dialog = (name: Text): Target => ({ role: 'dialog', name });
export const PALETTE = dialog('Command palette');
export const tabOf = (name: string, within?: Target): Target => ({ role: 'tab', name, ...(within ? { within } : {}) });
/** A tab strip entry whose accessible name carries a count badge ("Work 7"): matched by its leading word. */
export const tabNamed = (name: string, within?: Target): Target => ({ role: 'tab', name, ...(within ? { within } : {}) });

// ── Step builders ───────────────────────────────────────────────────────────
type Extra = Partial<Omit<Step, 'do' | 'name' | 'expect'>> & { expect?: Expect };
const withLeaks = (e: Expect | undefined, facts: boolean): Expect => ({ ...(e ?? {}), ...(facts ? { noText: [...LEAKS, ...(e?.noText ?? [])] } : {}) });

/** Open a page and assert what it shows; `facts` makes it a story-facts step (no leak on screen). */
export function open(url: string, name: string, expect: Expect, extra: Extra & { facts?: boolean } = {}): Step {
  const { facts, expect: _ignored, ...rest } = extra;
  return { do: 'navigate', url, name, ...(facts ? { proves: 'story-facts' } : {}), ...rest, expect: withLeaks(expect, !!facts) } as Step;
}
export const click = (target: Target, name: string, expect: Expect, extra: Extra = {}): Step => ({ do: 'click', target, name, ...extra, expect }) as Step;
export const press = (key: string, name: string, expect: Expect, extra: Extra & { target?: Target } = {}): Step => ({ do: 'press', key, name, ...extra, expect }) as Step;
export const fill = (target: Target, value: string, name: string, expect: Expect, extra: Extra = {}): Step => ({ do: 'fill', target, value, name, ...extra, expect }) as Step;
export const back = (name: string, expect: Expect, extra: Extra = {}): Step => ({ do: 'back', name, ...extra, expect }) as Step;
export const reload = (name: string, expect: Expect, extra: Extra = {}): Step => ({ do: 'reload', name, ...extra, expect }) as Step;
export const tabWalk = (min: number, name = 'Tab from the top of the page: the controls take focus in turn'): Step => ({ do: 'tab-walk', name, proves: 'keyboard', expect: { minVisited: min } });
export const api = (url: string, status: number | number[], name: string, proves: string | string[] = 'role-gating', extra: { method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; refusal?: string } = {}): Step =>
  ({ do: 'api', url, name, proves, ...extra, expect: { status } }) as Step;

/** Move into a scoped mock world and open a page in it; the page's sentence for that world is the assertion. */
export const scoped = (scope: string | { scenario?: string; fixture?: string; delayMs?: number }, url: string, name: string, state: string, expect: Expect, extra: Extra = {}): Step =>
  ({ do: 'scope', scope: scope as never, url, name, state, proves: 'empty-state', ...extra, expect }) as Step;
export const backToShared = (url: string, name: string, expect: Expect): Step => open(url, name, expect, { state: 'default' });

/** A tab click with the stability check: the header, the tab strip and the pane must not move or resize. */
export const tabClick = (target: Target, name: string, expect: Expect, stable: Target[], extra: Extra = {}): Step =>
  click(target, name, expect, { proves: 'tab-stability', stable, ...extra });

// ── The list pattern: default, filtered, filtered-empty, row-open, back ─────
export interface ListSpec {
  url: string;
  box: string;               // the search box's accessible name
  match: string;             // a query that finds rows
  matchShows: Text;          // a name the matching query leaves on screen
  noneSentence: Text;        // the page's own words for a search that finds nothing
  rowsTarget?: Target;       // the rows (default: tbody rows of main)
  opens: RegExp;             // where Enter on the first row goes
  queryParam?: string;       // the URL parameter the search writes (default q)
}
export function listSteps(s: ListSpec): Step[] {
  const rows = s.rowsTarget ?? tableRows;
  const first: Target = { ...rows, nth: 0 };
  const q = s.queryParam ?? 'q';
  return [
    fill(search(s.box), s.match, `Search "${s.match}": the list narrows to what matches`, { url: new RegExp(`[?&]${q}=${s.match}`), visible: [seen(s.matchShows)], count: [{ target: rows, min: 1 }] }, { state: 'filtered', proves: 'empty-state' }),
    fill(search(s.box), 'zzzzqq', 'Search zzzzqq: the list says what it holds instead of a blank table', { visible: [seen(s.noneSentence)], count: [{ target: rows, eq: 0 }] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search(s.box), '', 'Clear the search: the rows come back', { url: new RegExp(`^(?!.*[?&]${q}=)`), count: [{ target: rows, min: 1 }] }),
    press('Enter', 'Enter on the first row opens its record', { url: s.opens }, { target: first, state: 'row-open', proves: 'keyboard' }),
  ];
}

// ── Palette, dialogs ────────────────────────────────────────────────────────
export const openPalette = (proves: string | null = 'keyboard'): Step => press('ControlOrMeta+k', 'ControlOrMeta+K opens the command palette over the page', { visible: [PALETTE], focused: { placeholder: /Jump to a page/ } }, { state: 'dialog-open', ...(proves ? { proves } : {}) });
export const closeDialog = (name: Text, returnTo?: Target, proves: string | null = 'keyboard'): Step => press('Escape', 'Escape closes it and focus returns to where it was', { hidden: [dialog(name)], ...(returnTo ? { focused: returnTo } : {}) }, proves ? { proves } : {});

// ── Facts of the seed story ─────────────────────────────────────────────────
export const AUTH = {
  id: 'p-auth-migration', name: 'Auth Migration', owner: 'Vera Green', smes: ['Simone Chang', 'Nora DaSilva'],
  stuck: 'Tenant-by-tenant cutover runbook with rollback', other: 'Logout leaves the legacy shim cookie alive', escalated: 'Cutover order for legacy SSO tenants',
  item: 'wi-auth-e1-s1', itemTitle: 'BFF authorization-code + PKCE flow behind the middleware',
};
/** The initiative each role finds on its landing list (member: where Theo is an owner or contributor). */
const OWN: Record<Role, string> = { member: 'Design System API', sme: 'Auth Migration', 'program-owner': 'Auth Migration', 'org-leader': 'Auth Migration', 'hr-admin': 'Auth Migration' };
const LANDS: Record<Role, RegExp> = { member: /^My initiatives$/, sme: /^My initiatives$/, 'program-owner': /initiatives$/i, 'org-leader': /initiatives$/i, 'hr-admin': /initiatives$/i };

const heading = (name: Text): Target => ({ role: 'heading', name, level: 1 });
const ARRIVED = /ERR_CONNECTION_REFUSED|Failed to fetch/;   // the recordings service (platform-api :23002) is not part of the Tilt stack
const railCount: Target = { testId: 'explorer-layout-rail-count' };

// ── initiatives ─────────────────────────────────────────────────────────────
export function initiatives(role: Role): Step[] {
  const c = CAPS[role];
  const rowsOf: Target = tableRows;
  return [
    open('/iq/projects', `Open Initiatives as ${role}: the list this role lands on, with its own initiative`, { url: '/iq/projects', visible: [heading(LANDS[role]), seen(OWN[role])], count: [{ target: rowsOf, min: 1 }], numbers: [{ of: railCount, eqCount: rowsOf }], firstRowTopMax: 640 }, { facts: true, proves: 'story-facts' }),
    click({ testId: 'rail-nav-list-item-/iq/projects?scope=all' }, c.budgets ? 'Open All initiatives from the rail: the whole program, spend figures open for this role' : 'Open All initiatives from the rail: the whole program, spend figures locked for this role',
      { url: /scope=all/, visible: [heading(/^All initiatives$/), seen(AUTH.name), seen('Observability Platform')], count: [{ target: rowsOf, min: 10 }], numbers: [{ of: railCount, eqCount: rowsOf }],
        ...(c.budgets ? { absent: [{ testId: 'spend-strip-locked' }, { testId: 'budget-access-request' }] } : { visible: [heading(/^All initiatives$/), seen(AUTH.name), seen('Observability Platform'), { testId: 'spend-strip-locked' }, { testId: 'budget-access-request' }] }),
        noText: LEAKS },
      { proves: ['tab-stability', 'story-facts', 'role-gating'], stable: [STILL.header, { testId: 'initiatives-pane-header' }, { testId: 'rail-nav-list' }] }),
    ...(c.budgets ? [] : [
      click({ testId: 'budget-access-request' }, 'Request budget access opens its dialog (nothing is sent)', { visible: [dialog(/budget access/i)] }, { state: 'dialog-open', proves: 'role-gating' }),
      press('Escape', 'Escape closes the dialog and focus returns to the button that opened it', { hidden: [dialog(/budget access/i)], focused: { testId: 'budget-access-request' } }, { proves: 'keyboard' }),
    ]),
    click({ role: 'button', name: 'Initiative list options' }, 'Open the list options: Sort and Status sit in one popover', { visible: [{ text: 'Agent spend', exact: true }, { text: 'In Progress', exact: true, within: { role: 'dialog' } }] }, { state: 'dialog-open' }),
    click({ text: 'In Progress', exact: true, within: { role: 'dialog' } }, 'Choose the In Progress status: the planning and completed rows leave the list', { count: [{ target: rowsOf, eq: 11 }] }, { state: 'filtered' }),
    press('Escape', 'Escape closes the popover', { hidden: [{ text: 'Agent spend', exact: true }] }, { proves: 'keyboard' }),
    ...listSteps({ url: '/iq/projects?scope=all', box: 'Find an initiative', match: 'auth', matchShows: AUTH.name, noneSentence: 'No matching initiatives', opens: /^\/iq\/projects\/p-[a-z0-9-]+/ }),
    back('Browser Back returns to the list', { url: /^\/iq\/projects/, visible: [heading(/initiatives$/i)] }),
    openPalette(),
    closeDialog('Command palette'),
    tabWalk(10),
    scoped({ scenario: 'empty', fixture: 'initiatives' }, '/iq/projects?scope=all', 'In a world with no initiatives, the list says nothing creates one by hand and where they come from', 'empty', { visible: [seen('No initiatives yet'), seen(/graph-builder agent/)] }),
    scoped({ scenario: 'empty', fixture: 'initiatives' }, '/iq/projects?scope=mine', 'In the same world My initiatives says no initiative lists this person and offers All initiatives', 'empty', { visible: [seen('No initiatives are linked to you yet.'), seen('Browse all initiatives')] }),
    scoped({ scenario: 'error', fixture: 'initiatives' }, '/iq/projects?scope=all', 'When the initiatives read fails, the list says it could not load them rather than showing an empty one', 'error', { visible: [seen('Could not load initiatives'), { role: 'button', name: 'Try again' }], count: [{ target: rowsOf, eq: 0 }] }, { expectConsole: /500 \(Internal Server Error\)/ }),
    scoped('long-text', '/iq/projects?scope=all', 'With very long names the list keeps every row on one line and the page scrolls no wider', 'long-text', { visible: [seen(/with a deliberately long value/)], count: [{ target: rowsOf, min: 10 }] }),
    scoped('many', '/iq/projects?scope=mine', 'With many initiatives the list grows downward and its count agrees with its rows', 'many', { count: [{ target: rowsOf, min: 14 }], numbers: [role === 'member' || role === 'program-owner' ? { of: railCount, eqCount: rowsOf } : { of: railCount, eqNumberOf: { testId: 'datatable-page-summary' }, reOther: /· (\d+) total/ }] }),
    scoped({ scenario: 'loading', delayMs: 2500 }, '/iq/projects?scope=all', 'While the list loads it says so (Loading initiatives…), not an empty table', 'loading', { visible: [{ text: 'Loading initiatives…' }], count: [{ target: rowsOf, eq: 0 }] }, { noSettle: true }),
  ];
}

// ── initiative ──────────────────────────────────────────────────────────────
const initiativeStill = (): Target[] => [STILL.header, STILL.initiativeHeader, STILL.tablist(/ views$/), STILL.pane];
const paneTabs: Target = { role: 'tablist', name: 'Pane sections' };
const selected = (t: Target): Expect => ({ attr: [{ target: t, name: 'aria-selected', value: 'true' }] });
const NO_PANE = /^\/iq\/projects\/[^/?]+(?:\?(?!.*pane=).*)?$/;

export function initiative(role: Role): Step[] {
  const c = CAPS[role];
  const base = `/iq/projects/${AUTH.id}`;
  const pageTab = (name: string, param: string, expect: Expect, extra: Extra = {}) =>
    tabClick(tabNamed(name), `Click the ${name} tab: it opens and the header, tab strip and side pane stay where they were`, { url: param ? new RegExp(`[?&]tab=${param}\\b`) : /^\/iq\/projects\/[^/?]+(?:\?(?!.*tab=).*)?$/, ...selected(tabNamed(name)), ...expect }, initiativeStill(), extra);
  const paneTab = (name: string, url: RegExp, expect: Expect) =>
    tabClick(tabNamed(name, paneTabs), `Click ${name} in the side pane: it switches and nothing else moves`, { url, ...selected(tabNamed(name, paneTabs)), ...expect }, initiativeStill());
  return [
    open(base, `Open ${AUTH.name}: its owner and SMEs by name, the tabs and the side pane`, { url: base, visible: [heading(AUTH.name), seen(AUTH.owner), seen(AUTH.smes[0]), seen(AUTH.smes[1]), tabNamed('Overview'), tabNamed('Work'), tabNamed('Discussion', paneTabs)] }, { facts: true }),
    click({ role: 'button', name: /^View all \d+$/ }, 'View all work on the overview opens the Work tab', { url: /[?&]tab=work\b/, visible: [seen(AUTH.stuck)] }, { state: 'row-open', proves: 'keyboard' }),
    paneTab('Details', /[?&]pane=details\b/, {}),
    paneTab('Agent', /[?&]pane=agent\b/, {}),
    paneTab('Discussion', NO_PANE, {}),
    pageTab('Overview', '', { visible: [seen(AUTH.stuck)], noText: LEAKS }, { proves: ['tab-stability', 'story-facts'] }),
    pageTab('Work', 'work', { visible: [seen(AUTH.stuck)], numbers: [{ of: tabNamed('Work'), re: /(\d+)/, eqNumberOf: seen(/^\d+ work items$/), reOther: /(\d+)/ }] }),
    pageTab('Docs', 'docs', { visible: [seen('Workspace')] }, { expectConsole: ARRIVED }),
    pageTab('Decisions', 'decisions', { visible: [seen(AUTH.escalated)], numbers: [{ of: tabNamed('Decisions'), re: /(\d+)/, eqCount: tableRows }], noText: LEAKS }, { proves: ['tab-stability', 'story-facts'] }),
    pageTab('Agents', 'agents', { visible: [seen(/agent spend over \d+ runs/)] }),
    pageTab('Contributors', 'contributors', { visible: [seen(AUTH.owner), seen('Nora DaSilva')], numbers: [{ of: tabNamed('Contributors'), re: /(\d+)/, eqCount: tableRows }], noText: LEAKS }, { proves: ['tab-stability', 'story-facts'] }),
    pageTab('Activity', 'activity', { visible: [seen('Recorded huddles')] }, { expectConsole: ARRIVED }),
    pageTab('Overview', '', { visible: [seen(AUTH.stuck)] }),
    press('Shift+I', 'Shift+I opens the Details pane from the keyboard', { url: /[?&]pane=details\b/ }, { proves: 'keyboard' }),
    paneTab('Discussion', NO_PANE, c.composerPost ? {} : { visible: [seen(/Your current role cannot post/)] }),
    click({ testId: 'initiative-header-menu-trigger' }, `Open the header menu: ${c.dispatch ? 'Prepare job and' : 'View job setup and'} the initiative's own entries`, { visible: [{ role: 'menuitem', name: 'Initiative details' }, { role: 'menuitem', name: 'Contributors' }] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape closes the menu and focus returns to its button', { hidden: [{ role: 'menuitem', name: 'Initiative details' }], focused: { testId: 'initiative-header-menu-trigger' } }, { proves: 'keyboard' }),
    tabWalk(12),
    open('/iq/projects/p-nope', 'A missing initiative says so and offers the way back', { visible: [seen('Initiative not found'), seen('No initiative has the id "p-nope".')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
    scoped('long-text', base, 'With a very long title the initiative header keeps it on screen and the page scrolls no wider', 'long-text', { visible: [seen(/with a deliberately long value/)] }),
  ];
}

// ── work-items ──────────────────────────────────────────────────────────────
const openItem: Target = { role: 'button', name: /^Open / };
const itemStill = (): Target[] => [STILL.header, { testId: 'work-item-header' }, STILL.tablist(/ views$/), STILL.pane];
const itemTab = (name: string, expect: Expect): Step =>
  tabClick(tabNamed(name), `Click the ${name} tab of the work item: it opens and the item header, tab strip and side pane stay where they were`, { ...selected(tabNamed(name)), ...expect }, itemStill(), { proves: 'tab-stability' });
const WORK_NUMBERS = { of: tabNamed('Work'), re: /(\d+)/, eqNumberOf: seen(/^\d+ work items$/), reOther: /(\d+)/ };

export function workItems(role: Role): Step[] {
  const c = CAPS[role];
  const url = `/iq/projects/${AUTH.id}?tab=work`;
  return [
    open(url, `Open the Work tab: the items by status with their owners by name, the count agreeing with the tab badge`, { url, visible: [seen(AUTH.stuck), seen('Simone Chang'), seen(/^\d+ work items$/)], numbers: [WORK_NUMBERS], count: [{ target: tableRows, min: 5 }] }, { facts: true }),
    ...listSteps({ url, box: 'Search work', match: 'logout', matchShows: AUTH.other, noneSentence: 'No work matches this search or these filters', rowsTarget: tableRows, opens: /[?&]item=wi-auth/, queryParam: 'wq' }).slice(0, 3),
    click({ role: 'button', name: 'Filter work' }, 'Open the work filters: type, owner and priority', { visible: [{ text: 'Clear filters' }, { text: 'Critical', exact: true }] }, { state: 'dialog-open' }),
    click({ text: 'Bug', exact: true, within: { role: 'dialog' } }, 'Filter to bugs: only the bug rows stay', { visible: [seen(AUTH.other)], count: [{ target: { role: 'button', name: new RegExp(`^Open ${AUTH.stuck}`) }, eq: 0 }] }, { state: 'filtered' }),
    press('Escape', 'Escape closes the filters', { hidden: [{ text: 'Clear filters' }] }, { proves: 'keyboard' }),
    open(url, 'Open the Work tab again: the filter is gone with the page', { url, visible: [seen(AUTH.stuck)] }),
    click({ role: 'button', name: new RegExp(`^Open ${AUTH.stuck}`) }, 'Open the stuck story: its brief, owner and why it is blocked, by name', { url: /[?&]item=wi-auth-e2-s2/, visible: [heading(AUTH.stuck), seen('Sienna Garcia decides the cutover order.'), seen('Simone Chang')], noText: LEAKS }, { state: 'row-open', proves: 'story-facts' }),
    ...(c.dispatch
      ? [{ do: 'wait', target: { role: 'button', name: /Add context/ }, name: 'This role may edit: the brief offers Add context', proves: 'role-gating', expect: { enabled: [{ role: 'button', name: /Add context/ }] } } as Step]
      : [{ do: 'wait', target: { role: 'button', name: /Add context/ }, name: 'This role cannot edit: Add context is there but disabled, and the page says why', proves: 'role-gating', expect: { disabled: [{ role: 'button', name: /Add context/ }], visible: [seen('Your role cannot edit work items')] } } as Step]),
    itemTab('Docs', {}),
    itemTab('Activity', {}),
    itemTab('Brief', { visible: [seen('Complete the brief')] }),
    tabWalk(10),
    scoped({ scenario: 'empty', fixture: 'work-items' }, url, 'In a world with no work items the tab says no work yet and why', 'empty', { visible: [seen(/No work yet/)], count: [{ target: tableRows, eq: 0 }] }),
    scoped({ scenario: 'many', fixture: 'work-items' }, url, 'With many work items the list grows and its count reads 252', 'many', { visible: [seen('252 work items')], count: [{ target: openItem, min: 20 }] }),
    scoped({ scenario: 'long-text', fixture: 'work-items' }, url, 'With very long titles every row keeps one line and the page scrolls no wider', 'long-text', { visible: [seen(/with a deliberately long value/)] }),
  ];
}

// ── prepare-job ─────────────────────────────────────────────────────────────
const DECK: Target = { css: '[data-composer-prompt-deck="expanded"]' };
const DECK_OPTION: Target = { css: '[data-composer-prompt-option]' };
const READ_ONLY_JOB = 'An SME with a sprint grant on this initiative, or a release manager, authorizes jobs.';

/** The roles that dispatch: their prepare-job and work-write maps write (inside `scenario: { scope: 'default' }`). */
const writesJob = (role: Role): boolean => CAPS[role].dispatch;
/** An item that is sized and up next, on the initiative where the sme holds her grant (bg-auth-3), and one on an initiative where she holds none. */
const DISPATCH = {
  granted: { item: 'wi-auth-e2-b3', title: AUTH.other, initiative: AUTH.id },
  ungranted: { item: 'wi-zt-e1-s2', title: 'mTLS rollout plan with break-glass procedure', initiative: 'p-zero-trust' },
};
const deckOption = (name: Text): Target => ({ role: 'button', name, within: DECK });
const SPRINT_ENVELOPE_GATE = /Over your sprint envelope|Over the run cap you set|Over the initiative.s monthly allocation/;

/** A dispatcher's card: the numbered options, the composer keys, the soft brakes and the refusal where no grant is held. */
function prepareJobDispatcher(role: Role): Step[] {
  const granted = DISPATCH.granted;
  const url = `/iq/projects/${granted.initiative}?item=${granted.item}`;
  const menu = { testId: 'initiative-header-menu-trigger' } as Target;
  const openDeck = (name: string): Step[] => [
    click(menu, `Open the item's header menu: it offers Prepare job`, { visible: [{ role: 'menuitem', name: 'Prepare job' }] }, { proves: 'role-gating' }),
    click({ role: 'menuitem', name: 'Prepare job' }, name, { visible: [DECK, { text: 'Prepare job' }], focused: DECK, count: [{ target: DECK_OPTION, min: 4 }] }, { state: 'dialog-open', proves: 'role-gating' }),
  ];
  return [
    open(url, `Open ${granted.title}: a sized item that is up next, where this sme holds a sprint grant`, { url, visible: [heading(granted.title), seen('Vera Green')], noText: LEAKS }, { facts: true }),
    tabClick(tabNamed('Docs'), 'Click the Docs tab of the work item: it opens and the item header, tab strip and side pane stay where they were', selected(tabNamed('Docs')), itemStill(), { proves: 'tab-stability', state: 'row-open' }),
    itemTab('Brief', {}),
    ...openDeck('Prepare job shows the job with its numbered options: Dispatch, Change model, Change cap, Edit instruction'),
    { do: 'wait', target: DECK, name: 'The card is the dispatcher\'s: it names the options and the sprint envelope this person spends from', proves: 'role-gating', expect: { visible: [deckOption(/Dispatch/), deckOption(/Change model/), deckOption(/Change cap/), deckOption(/Edit instruction/)], absent: [{ text: 'Needs dispatch rights' }] } } as Step,
    press('2', 'Key 2 picks Change model: the card asks which model runs the job', { visible: [DECK, seen(/Which model runs/)] }, { proves: 'keyboard' }),
    press('Enter', 'Enter keeps the current model and returns to the job', { visible: [DECK, deckOption(/Change model/)] }, { proves: 'keyboard' }),
    press('3', 'Key 3 picks Change cap: the card asks for a dollar amount', { visible: [DECK, seen(/Cap this run at how many dollars/)] }, { proves: 'keyboard' }),
    press('Enter', 'Enter keeps no cap and returns to the job', { visible: [DECK, deckOption(/Change cap/)] }, { proves: 'keyboard' }),
    press('4', 'Key 4 picks Edit instruction: the card shows the derived instruction', { visible: [DECK, seen(/Type the instruction in the composer/)] }, { proves: 'keyboard' }),
    press('Enter', 'Enter keeps the instruction and returns to the job', { visible: [DECK, deckOption(/Edit instruction/)] }, { proves: 'keyboard' }),
    press('Escape', 'Escape folds the card and the work item stays open', { hidden: [DECK], url }, { proves: 'keyboard' }),
    ...openDeck('Open the card again from the menu'),
    press('3', 'Key 3 picks Change cap again', { visible: [DECK, seen(/Cap this run at how many dollars/)] }, { proves: 'keyboard' }),
    fill({ css: 'main [contenteditable="true"]', nth: 0 }, '0.01', 'Type a one-cent cap, far under the forecast', { visible: [DECK] }, { proves: 'keyboard' }),
    press('Enter', 'Enter sets the cap: the card shows it beside the forecast', { visible: [DECK, { text: '$0.01', within: DECK }] }, { proves: 'keyboard' }),
    click(deckOption(/^(1 )?Dispatch$/), 'Dispatch: the cap is under the forecast, so the card stops and asks (Over the run cap you set)', { visible: [DECK, { text: 'Over the run cap you set', within: DECK }, deckOption('Dispatch anyway'), deckOption('Back to the job')] }, { state: 'dialog-open', expectConsole: /409/ }),
    click(deckOption('Back to the job'), 'Back to the job keeps nothing: the card is the job again and the item is still up next', { visible: [DECK, { text: 'Dispatch with these settings?', within: DECK }, { text: /Over the run cap you set: not dispatched/ }] }),
    click(deckOption(/^(1 )?Dispatch$/), 'Dispatch asks again', { visible: [{ text: 'Over the run cap you set', within: DECK }] }, { expectConsole: /409/ }),
    click(deckOption('Dispatch anyway'), 'Dispatch anyway confirms the brake: the job is sent and the card says so', { hidden: [DECK], visible: [{ text: /Dispatched/ }] }, { writes: true }),
    reload('Reload: the item is In progress, read back from the server', { visible: [heading(granted.title), { role: 'combobox', name: 'Status' }], attr: [{ target: { role: 'combobox', name: 'Status' }, name: 'data-value', value: 'in_progress' }] }),
    ...openDeck('Open the card again: the work is under way'),
    { do: 'wait', target: DECK, name: 'The job is running: the card says so and Dispatch is off until it is up next again', proves: 'role-gating', expect: { visible: [{ text: 'A job is already running for this item. Dispatch another with these settings?', within: DECK }], disabled: [deckOption(/^(1 )?Dispatch$/)] } } as Step,
    press('Escape', 'Escape folds the card', { hidden: [DECK] }, { proves: 'keyboard' }),
    open(`/iq/projects/${DISPATCH.ungranted.initiative}?item=${DISPATCH.ungranted.item}`, 'Open a work item on an initiative where this sme holds no grant', { visible: [heading(DISPATCH.ungranted.title)], noText: LEAKS }, { facts: true }),
    ...openDeck('Prepare job opens the card; its envelope field says there is no grant here'),
    { do: 'wait', target: DECK, name: 'The card says No sprint grant here', proves: 'role-gating', expect: { visible: [{ text: 'No sprint grant here', within: DECK }] } } as Step,
    press('1', 'Key 1 dispatches: the server refuses, with its sentence, and nothing runs', { visible: [seen(/no active sprint grant/i)] }, { state: 'refused', proves: 'role-gating', expectConsole: /403|Forbidden/ }),
    tabWalk(10),
    open(`/iq/projects/${granted.initiative}?item=wi-nope`, 'A work item that is not in the list says so and sends the reader to the rail', { visible: [seen('Work item unavailable'), seen('This item is not in the current work list.')] }, { state: 'not-found', proves: 'empty-state' }),
  ];
}

export function prepareJob(role: Role): Step[] {
  if (CAPS[role].dispatch) return prepareJobDispatcher(role);
  const c = CAPS[role];
  const url = `/iq/projects/${AUTH.id}?item=${AUTH.item}`;
  const entry = c.dispatch ? 'Prepare job' : 'View job setup';
  const menu = { testId: 'initiative-header-menu-trigger' } as Target;
  const openDeck = (name: string): Step[] => [
    click(menu, `Open the item's header menu: it offers ${entry}`, { visible: [{ role: 'menuitem', name: entry }] }, { proves: 'role-gating' }),
    click({ role: 'menuitem', name: entry }, name, { visible: [DECK, { text: 'Job setup' }], focused: DECK, ...(c.dispatch ? { count: [{ target: DECK_OPTION, min: 3 }] } : { absent: [DECK_OPTION] }) }, { state: 'dialog-open', proves: 'role-gating' }),
  ];
  return [
    open(url, `Open ${AUTH.itemTitle}: the work item whose job would run`, { url, visible: [heading(AUTH.itemTitle), seen('Simone Chang'), seen('Brief preview')] }, { facts: true }),
    tabClick(tabNamed('Docs'), 'Click the Docs tab of the work item: it opens and the item header, tab strip and side pane stay where they were', selected(tabNamed('Docs')), itemStill(), { proves: 'tab-stability', state: 'row-open' }),
    itemTab('Brief', { visible: [seen('Brief preview')] }),
    ...openDeck(c.dispatch ? 'Prepare job shows the job with its numbered options' : 'View job setup shows what the job would run with, and no options to pick'),
    ...(c.dispatch ? [] : [
      { do: 'wait', target: DECK, name: 'The card says who authorizes a job and that this role can only see the setup', proves: 'role-gating', expect: { visible: [{ css: '[data-composer-prompt-deck="expanded"] :text("authorizes jobs")' }, { text: 'Needs dispatch rights' }] } } as Step,
    ]),
    press('1', c.dispatch ? 'Key 1 picks the first option' : 'Key 1 picks nothing: this role has no option to pick, and nothing is sent', { visible: [DECK] }, { proves: 'keyboard' }),
    press('2', c.dispatch ? 'Key 2 picks the second option' : 'Key 2 picks nothing either: the card is unchanged', { visible: [DECK] }, { proves: 'keyboard' }),
    press('Enter', c.dispatch ? 'Enter confirms the focused option' : 'Enter on the focused Hide button folds the card to its one-line summary', c.dispatch ? { visible: [DECK] } : { hidden: [DECK], visible: [seen(/question waiting/)] }, { proves: 'keyboard' }),
    ...openDeck('Open the card again from the menu'),
    press('Escape', 'Escape folds the card and the work item stays open', { hidden: [DECK], url }, { proves: 'keyboard' }),
    tabWalk(10),
    open(`/iq/projects/${AUTH.id}?item=wi-nope`, 'A work item that is not in the list says so and sends the reader to the rail', { visible: [seen('Work item unavailable'), seen('This item is not in the current work list.')] }, { state: 'not-found', proves: 'empty-state' }),
  ];
}

// ── work-write ──────────────────────────────────────────────────────────────
const NEW_STORY = 'Draft the shim cookie purge checklist';
const NEW_EPIC_TITLE = 'Retire the SAML metadata endpoint';
const PLANNING_NOTE = 'Purge the shim cookie in the logout request';

/** Create, move, assign and annotate work as a role that holds DispatchAgentRun, each read back after a reload (a scoped world, so nothing leaks). */
export function workWrite(role: Role): Step[] {
  const c = CAPS[role];
  if (!c.dispatch) throw new Error(`${role} cannot dispatch; work-write is not its journey`);
  const w = DISPATCH.granted;
  const url = `/iq/projects/${w.initiative}?item=${w.item}`;
  const menu = { testId: 'initiative-header-menu-trigger' } as Target;
  const status = { role: 'combobox', name: 'Status' } as Target;
  const priority = { role: 'combobox', name: 'Priority' } as Target;
  const created: Target = { role: 'button', name: new RegExp(`^Open ${NEW_STORY}`) };
  const newWork = dialog('New work in Legacy SSO decommission');
  const openNewStory: Step[] = [
    click(menu, 'Open the header menu: it offers a new story in this item\'s epic', { visible: [{ role: 'menuitem', name: 'New story in Legacy SSO decommission' }, { role: 'menuitem', name: 'New epic' }] }, { proves: 'role-gating' }),
    click({ role: 'menuitem', name: 'New story in Legacy SSO decommission' }, 'New story opens its dialog, named for the epic', { visible: [newWork, { label: 'Title' }] }, { state: 'dialog-open', proves: 'keyboard' }),
  ];
  return [
    open(url, `Open ${w.title}: this role may edit, so the brief offers Add context and the header menu offers new work`, { url, visible: [heading(w.title), { role: 'button', name: /Add context/ }], enabled: [{ role: 'button', name: /Add context/ }], noText: LEAKS }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    ...openNewStory,
    press('Escape', 'Escape closes the dialog and nothing is created', { hidden: [newWork], absent: [created] }, { proves: 'keyboard' }),
    ...openNewStory,
    { do: 'wait', target: newWork, name: 'With no title typed the dialog will not create anything: Create is disabled', proves: 'empty-state', expect: { disabled: [{ role: 'button', name: 'Create' }] } } as Step,
    fill({ label: 'Title' }, NEW_STORY, 'Type the story title', { visible: [newWork], focused: { label: 'Title' } }),
    press('Enter', 'Enter creates the story: the dialog closes and the header menu stays shut', { hidden: [newWork, { role: 'menuitem', name: 'New epic' }] }, { writes: true, proves: 'keyboard' }),
    reload('Reload the page: this item is where it was', { visible: [heading(w.title)], hidden: [newWork] }),
    open(`/iq/projects/${w.initiative}?tab=work`, 'Open the Work tab: the new story is listed in its epic, read back from the server', { url: `/iq/projects/${w.initiative}?tab=work`, visible: [created], noText: LEAKS }, { facts: true }),
    click(created, 'Open the new story: its header names it', { url: /[?&]item=wi-/, visible: [heading(NEW_STORY)] }, { state: 'row-open' }),
    click(status, 'Open the status list of the new story', { visible: [{ role: 'option', name: 'In progress' }, { role: 'option', name: 'Done' }] }, { state: 'dialog-open' }),
    click({ role: 'option', name: 'In progress' }, 'Choose In progress: the story moves', { attr: [{ target: status, name: 'data-value', value: 'in_progress' }] }, { writes: true }),
    reload('Reload: the story is still In progress', { attr: [{ target: status, name: 'data-value', value: 'in_progress' }], visible: [heading(NEW_STORY)] }, {}),
    click(priority, 'Open the priority list of the story', { visible: [{ role: 'option', name: 'Critical priority' }] }, { state: 'dialog-open' }),
    click({ role: 'option', name: 'Critical priority' }, 'Choose Critical priority', { attr: [{ target: priority, name: 'data-value', value: 'critical' }] }, { writes: true }),
    reload('Reload: the priority is still Critical', { attr: [{ target: priority, name: 'data-value', value: 'critical' }], visible: [heading(NEW_STORY)] }, {}),
    click({ role: 'button', name: /^Owner: .*Change owner/ }, 'Open the owner picker of the story: it searches the initiative\'s people', { visible: [{ placeholder: /Search people/ }] }, { state: 'dialog-open' }),
    fill({ placeholder: /Search people/ }, 'Nora', 'Search Nora: the picker narrows to her', { visible: [{ placeholder: /Search people/ }] }),
    click({ role: 'button', name: /Nora DaSilva/, within: { testId: 'work-owner-picker' } }, 'Pick Nora DaSilva: she owns the story', { visible: [{ role: 'button', name: /^Owner: Nora DaSilva/ }] }, { writes: true }),
    tabClick(tabNamed('Activity'), 'Click Activity: the change is in the story\'s history', { ...selected(tabNamed('Activity')), visible: [{ role: 'button', name: /^Owner: Nora DaSilva/ }] }, itemStill(), { proves: 'tab-stability' }),
    reload('Reload: Nora DaSilva still owns it', { visible: [{ role: 'button', name: /^Owner: Nora DaSilva/ }, heading(NEW_STORY)] }),
    tabClick(tabNamed('Brief'), 'Click Brief: the story\'s brief and the composer are back', { ...selected(tabNamed('Brief')), visible: [heading(NEW_STORY)] }, itemStill(), { proves: 'tab-stability' }),
    fill({ css: 'main [contenteditable="true"]', nth: 0 }, `/comment ${PLANNING_NOTE}`, 'Type a planning note into the composer with /comment', { visible: [heading(NEW_STORY)] }),
    press('Enter', 'Enter posts the note to the story: Activity opens with it', { ...selected(tabNamed('Activity')), visible: [seen(PLANNING_NOTE)] }, { writes: true, proves: 'keyboard' }),
    reload('Reload and read the note back: the story\'s Activity still holds it', { visible: [heading(NEW_STORY)] }),
    tabClick(tabNamed('Activity'), 'Click Activity: the planning note is there, by its author', { ...selected(tabNamed('Activity')), visible: [seen(PLANNING_NOTE), seen('Nora DaSilva')], noText: LEAKS }, itemStill(), { proves: 'tab-stability' }),
    click(menu, 'Open the header menu again for a new epic', { visible: [{ role: 'menuitem', name: 'New epic' }] }),
    click({ role: 'menuitem', name: 'New epic' }, 'New epic opens its dialog', { visible: [dialog('New epic')] }, { state: 'dialog-open' }),
    press('Escape', 'Escape closes it', { hidden: [dialog('New epic')] }, { proves: 'keyboard' }),
    tabWalk(10),
  ];
}

// ── sprints ─────────────────────────────────────────────────────────────────
const SPRINT_OF: Partial<Record<Role, { name: string; steward: string; initiative: string; search: string; work: string }>> = {
  sme: { name: 'Sprint 10 — Session hygiene', steward: 'Simone Chang', initiative: 'Auth Migration', search: 'Session', work: 'Session cookie hardening: max-age, rotation on switch' },
};
const SPRINT_DEFAULT = { name: 'Sprint 7 — Contracts', steward: 'Ben Okafor', initiative: 'Design System API', search: 'Contracts', work: 'Breaking prop rename slipped past the semver gate' };
const sprintTabs: Target = { role: 'tablist', name: 'Sprint detail sections' };
const sprintStill = (): Target[] => [STILL.header, sprintTabs];
const SPRINT_NUMBERS = { of: seen(/^\d+ sprints?$/), eqCount: tableRows };

export function sprints(role: Role): Step[] {
  const c = CAPS[role];
  const SPRINT = SPRINT_OF[role] ?? SPRINT_DEFAULT;
  const url = '/iq/projects?lens=sprints';
  const sprintTab = (name: string, expect: Expect) =>
    tabClick(tabNamed(name, sprintTabs), `Click ${name} on the sprint: it opens and the header and tab strip stay where they were`, { ...selected(tabNamed(name, sprintTabs)), ...expect }, sprintStill());
  return [
    open(url, `Open Sprints: whose sprint, which initiative and steward, and which window`, { url, visible: [heading('Sprints'), seen(SPRINT.name), seen(SPRINT.steward), seen(/^\d+ sprints?$/)], numbers: [SPRINT_NUMBERS], count: [{ target: tableRows, min: 1 }], ...(c.sprints ? { visible: [heading('Sprints'), seen(SPRINT.name), seen(SPRINT.steward), { role: 'button', name: /New sprint/ }] } : { absent: [{ role: 'button', name: /New sprint/ }] }) }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    fill(search('Search sprints'), 'zzzzqq', 'Search zzzzqq: the table says which search matched no sprint', { visible: [seen('No sprint matches “zzzzqq”.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search sprints'), SPRINT.search, `Search ${SPRINT.search}: the sprint stays`, { visible: [seen(SPRINT.name)], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered' }),
    press('Enter', 'Enter on the sprint row opens it: its steward, window and points, by name', { url: /[?&]sprint=spr-/, visible: [seen(SPRINT.name), seen(`Steward: ${SPRINT.steward}`), seen('points done')], noText: LEAKS }, { target: { role: 'button', name: new RegExp(`^Open sprint ${SPRINT.name}`) }, state: 'row-open', proves: ['story-facts', 'keyboard'] }),
    sprintTab('Money', { visible: [seen(/envelope granted/)] }),
    sprintTab('Work', { visible: [seen(SPRINT.work)] }),
    ...(c.budgets ? [sprintTab('Envelopes', {})] : [{ do: 'wait', target: sprintTabs, name: 'The sprint has no Envelopes tab for this role: envelopes are granted by a release manager', proves: 'role-gating', expect: { absent: [tabNamed('Envelopes')], visible: [tabNamed('Money', sprintTabs)] } } as Step]),
    back('Browser Back leaves the sprint and returns to the sprints table', { url, visible: [seen(SPRINT.name)] }),
    ...(c.sprints ? [
      click({ role: 'button', name: /New sprint/ }, 'New sprint opens its form and asks for the initiative, name and window (nothing is created)', { visible: [dialog('New sprint'), { text: 'Initiative', within: dialog('New sprint') }] }, { state: 'dialog-open', proves: 'role-gating' }),
      closeDialog('New sprint', { role: 'button', name: /New sprint/ }),
    ] : []),
    ...(c.dispatch ? [
      click({ role: 'button', name: /my envelope/i }, `The "My envelope" tile opens Your sprint envelopes, naming the grant on ${SPRINT.initiative}`, { visible: [dialog(/Your sprint envelopes/), { text: SPRINT.name, within: dialog(/Your sprint envelopes/) }] }, { state: 'dialog-open', proves: 'role-gating' }),
      closeDialog(/Your sprint envelopes/),
    ] : []),
    tabWalk(8),
    scoped({ scenario: 'empty', fixture: 'sprints' }, url, 'In a world with no sprints the page says no sprint is yours', 'empty', { visible: [seen('No sprints of yours'), seen(/No sprint currently has your stewardship/)], count: [{ target: tableRows, eq: 0 }] }),
  ];
}

// ── automate ────────────────────────────────────────────────────────────────
const openLinks: Target = { text: 'open →' };

export function automate(role: Role): Step[] {
  const c = CAPS[role];
  const clear = (box: string, q = 'q'): Step => fill(search(box), '', 'Clear the search: the rows come back', { url: new RegExp(`^(?!.*[?&]${q}=)`) });
  return [
    open('/iq/work', 'Open the Inbox: the questions waiting, the queue and the recent runs', { url: '/iq/work', visible: [heading('Inbox'), seen('Needs your attention'), seen('Recent runs')], count: [{ target: tableRows, min: 1 }], noText: [] }, { facts: true }),
    c.devbox
      ? { do: 'wait', target: seen('Needs your attention'), name: 'This role holds ManageDevbox: the questions can be answered, no read-only sentence', proves: 'role-gating', expect: { noText: [/need the ManageDevbox capability/] } } as Step
      : { do: 'wait', target: seen('Needs your attention'), name: 'Answering and reviewing need ManageDevbox: the inbox says so and offers no answer', proves: 'role-gating', expect: { visible: [seen(/need the ManageDevbox capability; you can read these but not decide them/)] } } as Step,
    press('Enter', 'Enter on the first recent run opens its record', { url: /^\/iq\/work\/job-/ }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    back('Browser Back returns to the Inbox', { url: '/iq/work', visible: [heading('Inbox')] }),
    click({ css: '[data-shell-nav] a[href="/iq/work/queue"]' }, 'Open Runs: every job by state, with the dispatched runs running outside the queue named by work item', { url: '/iq/work/queue', visible: [heading('Runs'), seen('Running now outside the queue'), seen('Span-metrics connector feeding RED dashboards')], count: [{ target: tableRows, min: 10 }] }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    click({ role: 'button', name: /^Failed/ }, 'Filter to the failed (dead-letter) jobs: the badge agrees with the rows', { url: /[?&]status=failed/, numbers: [{ of: { role: 'button', name: /^Failed/ }, re: /(\d+)/, eqCount: openLinks }], visible: [seen('inference-canary-nightly')] }, { state: 'filtered' }),
    fill(search('Search runs'), 'zzzzqq', 'Search zzzzqq among the failed jobs: the table says nothing is dead-lettered', { visible: [seen('No loaded run matches this search.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    clear('Search runs'),
    click({ css: '[data-shell-nav] a[href="/iq/work/findings"]' }, 'Open Findings: the dead-letter queue and the open findings by sweep', { url: '/iq/work/findings', visible: [heading('Findings'), seen('Dead-letter queue'), seen('Orphan decisions')], ...(c.devbox ? { visible: [heading('Findings'), seen('Dead-letter queue'), seen('Orphan decisions'), { role: 'button', name: /requeue/i, nth: 0 }, { role: 'button', name: 'Run sweeps now', nth: 0 }] } : c.dispatch ? { visible: [heading('Findings'), seen('Dead-letter queue'), seen('Orphan decisions'), { role: 'button', name: 'Run sweeps now', nth: 0 }], absent: [{ role: 'button', name: /requeue/i }] } : { absent: [{ role: 'button', name: /requeue/i }] }) }, { proves: ['tab-stability', 'story-facts', 'role-gating'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    fill(search('Search findings'), 'zzzzqq', 'Search zzzzqq: the findings list says nothing is open', { url: /[?&]q=zzzzqq/, visible: [seen(c.dispatch ? /Nothing open\. Sweeps run every 6 hours, or run one now\./ : /Nothing open\. Sweeps run automatically every 6 hours\./)] }, { state: 'filtered-empty', proves: 'empty-state' }),
    clear('Search findings'),
    click({ css: '[data-shell-nav] a[href="/iq/work/changes"]' }, 'Open Graph updates: what agents proposed to the org graph and who decided it', { url: '/iq/work/changes', visible: [heading('Graph updates'), seen('Linked a document to an entity'), seen('Rachel Kowalski')], ...(c.devbox ? {} : { absent: [{ role: 'button', name: /^(Approve|Reject)( |$)/ }] }), noText: LEAKS }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    click({ role: 'button', name: /^applied/ }, 'Filter to the applied changes: three of them, each decided by a named person', { visible: [seen('decided by Rachel Kowalski')] }, { state: 'filtered' }),
    fill(search('Search graph updates'), 'zzzzqq', 'Search zzzzqq: no graph update matches', { visible: [seen('No loaded graph update matches this search.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    tabWalk(10),
    scoped({ scenario: 'empty', fixture: 'agent-jobs' }, '/iq/work', 'In a world with no runs the Inbox says there are no completed runs yet', 'empty', { visible: [seen('No completed runs yet')] }),
    scoped({ scenario: 'empty', fixture: 'agent-jobs' }, '/iq/work/queue', 'In the same world Runs says no jobs yet and how they begin', 'empty', { visible: [seen('Nothing here'), seen(/No jobs yet/)] }),
    scoped({ scenario: 'error', fixture: 'agent-jobs' }, '/iq/work', 'When the queue cannot be read, the Inbox says its numbers are unknown, not zero', 'error', { visible: [seen('Could not reach the work queue'), seen(/the numbers below are not zero/i)] }, { expectConsole: /500 \(Internal Server Error\)/ }),
  ];
}

// ── job ─────────────────────────────────────────────────────────────────────
const JOB = { id: 'job-auth-maint-1', title: 'auth-dep-watch', outcome: 'Bumped the JWT library in the token verifier; the OIDC conformance suite is green.' };
const jobTabs = STILL.tablist('Run details');
const jobStill = (): Target[] => [STILL.header, jobTabs, heading(JOB.title)];

export function job(role: Role): Step[] {
  const c = CAPS[role];
  const url = `/iq/work/${JOB.id}`;
  const jobTab = (name: string, param: string | null, expect: Expect, extra: Extra = {}) =>
    tabClick(tabNamed(name, jobTabs), `Click ${name} on the run: it opens and the title, tab strip and page stay where they were`, { url: param ? new RegExp(`[?&]tab=${param}\\b`) : /^\/iq\/work\/[^?]+(?:\?tab=summary)?$/, ...selected(tabNamed(name, jobTabs)), ...expect }, jobStill(), extra);
  return [
    open(url, 'Open one agent run: who scheduled it, how long it took, what it cost and what it concluded', { url, visible: [heading(JOB.title), seen('Completed'), seen(JOB.outcome), seen(/Scheduled by auth-dep-watch/)], noText: LEAKS }, { facts: true }),
    c.devbox
      ? { do: 'wait', target: heading(JOB.title), name: 'This role holds ManageDevbox, but this maintenance run ran on no computer, so there is no Open computer to offer, and a finished run has no Cancel, Accept or Reject', proves: 'role-gating', expect: { visible: [seen('Completed')], absent: [{ role: 'button', name: /^(Open computer|Cancel|Accept|Reject)/ }] } } as Step
      : { do: 'wait', target: heading(JOB.title), name: 'This role cannot drive a computer: the run offers no Open computer, Cancel, Accept or Reject', proves: 'role-gating', expect: { absent: [{ role: 'button', name: /^(Open computer|Cancel|Accept|Reject)/ }] } } as Step,
    jobTab('Activity', 'activity', { visible: [seen('Activity unavailable')] }),
    jobTab('Outputs', 'outputs', { visible: [seen('Recorded result'), seen('git_commit')] }, { proves: ['tab-stability', 'story-facts'] }),
    jobTab('Changes', 'changes', { visible: [seen('No graph changes recorded')] }),
    jobTab('Summary', null, { visible: [seen(JOB.outcome), seen('Timing')] }),
    press('ArrowRight', 'ArrowRight moves focus along the tab strip to Activity', { focused: tabNamed('Activity', jobTabs) }, { target: tabNamed('Summary', jobTabs), proves: 'keyboard' }),
    tabWalk(8),
    open('/iq/work/job-missing', 'A run that does not exist says so and offers the way back to the runs', { visible: [seen('Job not found'), seen('No job with id job-missing — it may have been pruned.')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
    ...(c.devbox ? [
      scoped({ scenario: 'large', fixture: 'agent-jobs' }, '/iq/work/job-live-queued', 'In the demo world a queued run is live: this role may Cancel it', 'default', { visible: [{ role: 'button', name: 'Cancel' }], absent: [{ role: 'button', name: /^(Accept|Reject)/ }] }, { proves: 'role-gating' }),
      click({ role: 'button', name: 'Cancel' }, 'Cancel asks first and names the state of the run (nothing is cancelled)', { visible: [dialog('Cancel this run?')] }, { state: 'dialog-open', proves: 'role-gating' }),
      closeDialog('Cancel this run?', { role: 'button', name: 'Cancel' }),
      scoped({ scenario: 'large', fixture: 'agent-jobs' }, '/iq/work/job-live-review', 'A run awaiting review offers Accept and Reject to this role', 'default', { visible: [{ role: 'button', name: 'Accept' }, { role: 'button', name: 'Reject' }] }, { proves: 'role-gating' }),
    ] : []),
  ];
}

// ── decisions ───────────────────────────────────────────────────────────────
const DECISION = { id: 'd-cognito-cutover', title: 'Cutover order for legacy SSO tenants', decider: 'Sienna Garcia' };
const decisionNumbers = { of: seen(/^\d+ decisions?$/), eqCount: tableRows };

export function decisions(role: Role): Step[] {
  const rail = (name: string) => ({ role: 'link', name: new RegExp(`^${name}`), within: { css: '[data-shell-nav]' } }) as Target;
  return [
    open('/iq/decisions', 'Open Decisions: who decides each call, which initiative it holds up, and when it was settled', { url: '/iq/decisions', visible: [heading('Decisions'), seen(DECISION.title), seen('Auth Migration'), seen(/^\d+ decisions?$/)], numbers: [decisionNumbers], count: [{ target: tableRows, min: 8 }], firstRowTopMax: 640 }, { facts: true }),
    click(rail('Waiting'), 'Filter to the decisions still waiting: three, and the count agrees with the rows', { url: /[?&]status=waiting/, numbers: [decisionNumbers], visible: [seen(DECISION.title), seen('Judge model for canary evaluation'), seen('Warm floor or scale-to-zero for tier-1 models')], count: [{ target: tableRows, eq: 3 }] }, { state: 'filtered', proves: 'tab-stability', stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    fill(search('Search decisions'), 'zzzzqq', 'Search zzzzqq: the list says no loaded decision matches', { visible: [seen('No decisions'), seen('No loaded decision matches this search.')], count: [{ target: tableRows, eq: 0 }] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search decisions'), '', 'Clear the search: the waiting decisions come back', { count: [{ target: tableRows, eq: 3 }] }),
    click(rail('All decisions'), 'Back to all decisions: twelve', { url: /[?&]status=all|^\/iq\/decisions$/, visible: [seen('12 decisions')], numbers: [decisionNumbers], count: [{ target: tableRows, min: 8 }] }),
    press('Enter', 'Enter on the first decision opens its record', { url: /^\/iq\/decisions\/d-/ }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    open(`/iq/decisions/${DECISION.id}`, 'Read the decision: who decides, what it needs, the question, the people involved and its history, by name', { url: `/iq/decisions/${DECISION.id}`, visible: [seen(DECISION.title), seen(DECISION.decider), seen('The question'), seen('Nora DaSilva'), seen('Simone Chang'), seen('Auth Migration')], absent: [{ role: 'button', name: /^(Decide|Approve|Reject|Escalate)( |$)/ }], noText: LEAKS }, { facts: true, state: 'row-open', proves: ['story-facts', 'role-gating'] }),
    tabWalk(8),
    open('/iq/decisions/d-nope', 'A decision that does not exist says so and offers the way back', { visible: [seen('Decision not found'), seen('No decision has this id.')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
    scoped({ scenario: 'empty', fixture: 'graph-decisions' }, '/iq/decisions', 'In a world with no decisions the page says nothing is recorded yet', 'empty', { visible: [seen('No decisions'), seen('Nothing is recorded in this view yet.')], count: [{ target: tableRows, eq: 0 }] }),
  ];
}

// ── search ──────────────────────────────────────────────────────────────────
const searchTabs = STILL.tablist(/ views$/);
// One header density for every Search tab (SearchPage useHeaderDensity), so the shell header and the tab strip are both held.
const searchStill = (): Target[] => [STILL.header, { role: 'tablist' }];

export function searchSurface(role: Role): Step[] {
  const sTab = (name: string, url: RegExp, expect: Expect) =>
    tabClick(tabNamed(name, searchTabs), `Click ${name} on Search: it opens and the header and tab strip stay where they were`, { url, ...selected(tabNamed(name, searchTabs)), ...expect }, searchStill());
  return [
    open('/iq/search', 'Open Search: one ranked result list with content-type navigation', { url: '/iq/search', visible: [heading('Search'), seen(/People/), seen(/Initiatives/), tabNamed('Results', searchTabs)], noText: LEAKS }, { facts: true }),
    sTab('Answer', /[?&]tab=answer\b/, { visible: [seen('Ask Supervisor')] }),
    sTab('Connections', /[?&]tab=connections\b/, { visible: [seen(/\d+ records · \d+ connections/)] }),
    sTab('Results', /^\/iq\/search(?:\?(?!.*tab=(?!results)).*)?$/, { visible: [seen(/People/)] }),
    open('/iq/search?q=Nora', 'Search Nora: the person is found with her title and team, and the count agrees', { url: '/iq/search?q=Nora', visible: [seen('Nora DaSilva'), seen('Senior Engineer · Platform Engineering'), seen(/^\d+ results?$/)], numbers: [{ of: tabNamed('Results', searchTabs), re: /(\d+)/, eqNumberOf: seen(/^\d+ results?$/), reOther: /(\d+)/ }], noText: [/\b(salary|compensation|performance rating)\b/i] }, { facts: true, state: 'filtered', proves: ['story-facts', 'role-gating'] }),
    open('/iq/search?q=auth', 'Search auth: people, the initiative and its decisions are all found', { url: '/iq/search?q=auth', visible: [seen('Vera Green'), seen('Auth Migration')] }, { facts: true, state: 'filtered' }),
    click({ css: 'a[href*="type=decision"]' }, 'Narrow to decisions: the escalated cutover decision is among them', { url: /[?&]type=decision/, visible: [seen(DECISION.title)] }, { proves: 'tab-stability', stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    click({ role: 'link', name: new RegExp(DECISION.title), within: { css: 'main' } }, 'Open the decision from the results: its record names who decides', { url: /^\/iq\/decisions\/d-/ }, { state: 'row-open' }),
    open('/iq/search?q=zzzzqq', 'Search zzzzqq: the page says no records match and offers another phrase', { url: '/iq/search?q=zzzzqq', visible: [seen('No matching records'), seen('Try another phrase or choose another record type.')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    open('/iq/search?tab=connections&type=person', 'The people graph: fifty-nine people and their relationships, by name', { url: '/iq/search?tab=connections&type=person', visible: [heading('People & connections'), seen(/\d+ people · \d+ edges/)], noText: LEAKS }, { facts: true }),
    open('/iq/projects', 'Back on Initiatives to use the palette from another page', { url: '/iq/projects', visible: [heading(/initiatives$/i)] }),
    open('/iq/search?scope=p-llm-platform', 'Initiative search opens only Work and retains its context', { visible: [seen('LLM Application Platform'), { css: '[data-testid="search-results"] [data-group="work"]' }], count: [{ target: { css: '[data-testid="search-results"] [data-group]' }, eq: 1 }] }, { state: 'scoped-work' }),
    click({ role: 'link', name: /^People/, within: { testId: 'search-type-rail' } }, 'Switch to People without stacking another collection or leaving the initiative', { url: /scope=p-llm-platform/, visible: [{ css: '[data-testid="search-results"] [data-group="person"] [data-record-key^="person:"]' }], absent: [{ css: '[data-testid="search-results"] [data-record-key^="work:"]' }] }, { state: 'scoped-people' }),
    // Wait for the newly requested payload, not the group label which changes before the fetch completes.
    click({ role: 'link', name: /^All results/, within: { testId: 'search-type-rail' } }, 'All results is one ranked collection within the initiative', { url: /scope=p-llm-platform/, visible: [{ css: '[data-testid="search-results"] [data-group="all"] [data-record-key^="work:"]' }, { css: '[data-testid="search-results"] [data-group="all"] [data-record-key^="person:"]' }], count: [{ target: { css: '[data-testid="search-results"] [data-group]' }, eq: 1 }] }, { state: 'scoped-all' }),
    openPalette(),
    fill({ placeholder: /Jump to a page/ }, 'decisions', 'Type "decisions" into the palette: the Decisions page is offered', { visible: [{ role: 'option', name: /^Decisions/ }, { css: '[role="option"][data-testid^="command-palette-record-"]' }], absent: [{ testId: 'command-palette-records-loading' }] }),
    click({ role: 'option', name: /^Decisions/ }, 'Pick Decisions: the palette jumps to the page and closes', { url: /^\/iq\/decisions/, hidden: [PALETTE], visible: [heading('Decisions')] }),
    tabWalk(8),
  ];
}

// ── documents ───────────────────────────────────────────────────────────────
const DOC = { id: 'adr-d-vectordb', title: 'ADR: Vector DB vendor selection' };

export function documents(role: Role): Step[] {
  return [
    open(`/iq/projects/${AUTH.id}?tab=docs`, 'The initiative’s Docs tab lists what the initiative holds; for Auth Migration nothing is linked yet and the tab says so', { visible: [seen('No project files yet'), seen('Workspace')] }, { state: 'default', proves: 'empty-state', expectConsole: ARRIVED }),
    open(`/iq/documents/${DOC.id}`, 'Open the document record: the title, its source and when it was ingested, read-only', { url: `/iq/documents/${DOC.id}`, visible: [heading(DOC.title), seen('This is the ingested document record.'), seen('Ingested'), seen('Source location')], noText: [...LEAKS, /\b\d{4}-\d{2}-\d{2}T/] }, { facts: true, state: 'row-open' }),
    { do: 'wait', target: heading(DOC.title), name: 'The record offers no edit: source content and editing stay with the source', proves: 'role-gating', expect: { absent: [{ role: 'button', name: /^(edit|save|delete)/i }], visible: [seen(/editing remain governed by the source/)] } } as Step,
    openPalette(),
    closeDialog('Command palette'),
    click(rail('Search'), 'Open Search from the rail: the header and rail stay where they were', { url: /^\/iq\/search/, visible: [heading('Search')] }, { proves: 'tab-stability', stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    back('Browser Back returns to the document', { url: `/iq/documents/${DOC.id}`, visible: [heading(DOC.title)] }),
    tabWalk(5),
    open('/iq/documents/doc-missing', 'A document that does not exist says it could not load the record and why', { visible: [seen('Could not load this document record'), seen('404 Not Found — Document record not found.')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
  ];
}

// ── designs ─────────────────────────────────────────────────────────────────
const DESIGN = { id: 'des-auth-rotation', title: 'Session token rotation on tenant switch' };
const designNumbers = { of: seen(/^\d+ designs?$/), eqCount: tableRows };

export function designs(role: Role): Step[] {
  const rail = (name: string): Target => ({ role: 'link', name: new RegExp(`^${name}`), within: { css: '[data-shell-nav]' } });
  return [
    open('/iq/designs', 'Open Designs: each thread with its initiative, status and what it is waiting for', { url: '/iq/designs', visible: [heading('Designs'), seen(DESIGN.title), seen('Auth Migration'), seen(/^\d+ designs?$/)], numbers: [designNumbers], count: [{ target: tableRows, min: 3 }], firstRowTopMax: 640, noText: LEAKS }, { facts: true }),
    click(rail('Approved'), 'Filter to approved designs: one, an ADR with three sign-offs', { url: /[?&]status=approved/, numbers: [designNumbers], visible: [seen('ADR: tail-sampling policy for the collector fleet'), seen(/3 sign-offs/)], count: [{ target: tableRows, eq: 1 }] }, { state: 'filtered', proves: 'tab-stability', stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    fill(search('Search designs'), 'zzzzqq', 'Search zzzzqq: the list says no loaded design matches', { visible: [seen('No design reviews'), seen('No loaded design matches this search.')], count: [{ target: tableRows, eq: 0 }] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search designs'), '', 'Clear the search: the approved design comes back', { count: [{ target: tableRows, eq: 1 }] }),
    click(rail('All designs'), 'Back to all designs: three', { count: [{ target: tableRows, min: 3 }] }),
    press('Enter', 'Enter on the first design opens its thread', { url: /^\/iq\/designs\/des-/ }, { target: firstRow, state: 'row-open', proves: 'keyboard' }),
    open(`/iq/designs/${DESIGN.id}`, CAPS[role].dispatch ? 'Read the thread: who posted what, by name, with Answer, Approve and Reject for this role' : 'Read the thread: who posted what, by name, and who may sign off', { url: `/iq/designs/${DESIGN.id}`, visible: [seen(DESIGN.title), seen('Vera Green'), seen('Simone Chang'), seen('Nora DaSilva'), seen('PROBLEM STATEMENT')], ...(CAPS[role].dispatch ? { visible: [seen(DESIGN.title), { role: 'button', name: /^Answer( |$)/, nth: 0 }, { role: 'button', name: 'Approve' }, { role: 'button', name: 'Reject' }, seen('Vera Green'), seen('Simone Chang'), seen('Nora DaSilva'), seen('PROBLEM STATEMENT')], absent: [{ role: 'button', name: /^(Sign off|Request changes)( |$)/ }] } : { absent: [{ role: 'button', name: /^(Answer|Sign off|Approve|Request changes)( |$)/ }] }), noText: LEAKS }, { facts: true, state: 'row-open', proves: ['story-facts', 'role-gating'] }),
    tabWalk(8),
    open('/iq/designs/des-nope', 'A design that does not exist says so and offers the way back', { visible: [seen('Design not found')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
    scoped({ scenario: 'empty', fixture: 'design-reviews' }, '/iq/designs', 'In a world with no design threads the page says no initiative has opened one', 'empty', { visible: [seen('No design reviews'), seen('No initiative has opened a design thread yet.')], count: [{ target: tableRows, eq: 0 }] }),
    scoped({ scenario: 'error', fixture: 'design-reviews' }, '/iq/designs', 'When the designs cannot be read the page says so instead of showing none', 'error', { visible: [seen('Could not load designs'), { role: 'button', name: 'Try again' }] }, { expectConsole: /500 \(Internal Server Error\)/ }),
  ];
}

// ── library ─────────────────────────────────────────────────────────────────
const ASSET = { id: 'lib-csrf-check', title: 'CSRF risk evaluator' };

export function library(role: Role): Step[] {
  const c = CAPS[role];
  return [
    open('/iq/library', c.libraryNew ? 'Open the Agent library: assets by kind, tier and status, with New asset for this role' : 'Open the Agent library: assets by kind, tier and status, and no New asset for this role', { url: '/iq/library', visible: [heading('Agent library'), seen(ASSET.title), seen(/^\d+ assets$/)], numbers: [{ of: seen(/^\d+ assets$/), eq: 12 }], ...(c.libraryNew ? { visible: [heading('Agent library'), seen(ASSET.title), { role: 'button', name: /New asset/ }] } : { absent: [{ role: 'button', name: /New asset/ }] }), noText: LEAKS }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    click({ css: 'button[aria-label="Asset kind"]' }, 'Open the kind filter', { visible: [{ role: 'option', name: /Evaluator/ }] }, { state: 'dialog-open' }),
    click({ role: 'option', name: /Evaluator/ }, 'Choose Evaluator: only the two evaluators stay', { count: [{ target: tableRows, eq: 2 }], visible: [seen(ASSET.title)] }, { state: 'filtered', proves: 'tab-stability', stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    open('/iq/library', 'Open the library again: the filter is gone with the page', { count: [{ target: tableRows, min: 8 }] }),
    ...listSteps({ url: '/iq/library', box: 'Search assets', match: 'csrf', matchShows: ASSET.title, noneSentence: 'No asset matches these facets.', opens: /^\/iq\/library\/[a-z0-9-]+/ }),
    open(`/iq/library/${ASSET.id}`, 'Read the asset: its contract, release readiness, evals and who ratified it, by name', { url: `/iq/library/${ASSET.id}`, visible: [seen(ASSET.title), seen('RELEASE READINESS')], noText: LEAKS }, { facts: true, state: 'row-open' }),
    tabWalk(8),
    open('/iq/library/lib-nope', 'An asset that does not exist says so and offers the way back', { visible: [seen('Asset not found'), seen('No library asset has the id "lib-nope".')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
  ];
}

// ── runbooks ────────────────────────────────────────────────────────────────
const RUNBOOK = { id: 'rb-tenant-cutover', title: 'Cut one tenant over from SAML to Cognito' };
const DIFF_KEY_WARNING = /unique "key" prop/;
const rbTabs: Target = { role: 'tablist', name: / sections$/ };
const rbStill = (): Target[] => [STILL.header, rbTabs];

export function runbooks(role: Role): Step[] {
  const c = CAPS[role];
  const rbTab = (name: string, param: string | null, expect: Expect) =>
    tabClick(tabNamed(name, rbTabs), `Click ${name} on the runbook: it opens and the header and tab strip stay where they were`, { url: param ? new RegExp(`[?&]tab=${param}\\b`) : new RegExp(`^/iq/runbooks/${RUNBOOK.id}(?:\\?(?!.*tab=).*)?$`), ...selected(tabNamed(name, rbTabs)), ...expect }, rbStill());
  return [
    open('/iq/runbooks', 'Open the runbook library: the procedures the fleet follows, grouped by where they apply', { url: '/iq/runbooks', visible: [heading('Library'), seen(RUNBOOK.title), seen(/^\d+ of \d+ runbooks$/)], noText: LEAKS }, { facts: true }),
    fill(search('Search runbooks'), 'zzzzqq', 'Search zzzzqq: the list says nothing matches and offers to clear', { visible: [seen('Nothing in this list matches the search.'), seen('0 of 19 runbooks')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(search('Search runbooks'), '', 'Clear the search: all nineteen come back', { visible: [seen('19 of 19 runbooks')] }),
    click({ role: 'button', name: new RegExp(`^${RUNBOOK.title}`), nth: 0 }, 'Open a runbook from the list: its purpose, when to use it and what recent runs found', { url: /^\/iq\/runbooks\/rb-/, visible: [seen('Recent runs have stumbled on this runbook')] }, { state: 'row-open', proves: 'story-facts' }),
    rbTab('History', 'history', { visible: [seen('Versions'), seen('Vera Green')] }),
    rbTab('Runs', 'runs', { visible: [seen('The steps')] }),
    rbTab('Suggest an edit', 'suggest', { visible: [seen('Runbook markdown'), seen(/Why this change/)] }),
    rbTab('Read', null, { visible: [seen('Use this when')] }),
    press('ArrowRight', 'ArrowRight moves focus along the tab strip to History', { focused: tabNamed('History', rbTabs) }, { target: tabNamed('Read', rbTabs), proves: 'keyboard' }),
    click(rail('Proposals'), 'Open Proposals from the section rail: five open, edits and new runbooks that runs and colleagues suggested', { url: '/iq/runbooks/proposals', visible: [heading('Proposals'), seen('Cut one tenant over from SAML to Cognito'), seen(/5 of 5 proposals/)] }, { proves: 'tab-stability', stable: [STILL.header] }),
    open('/iq/runbooks/proposals/prop-tenant-cutover-callback', c.reviewRunbook ? 'Open a proposal: its diff, and Accept and Reject for this reviewer' : 'Open a proposal: its diff is readable, and the page says deciding it belongs to the owner or an SME', { visible: [seen('What it changes')], ...(c.reviewRunbook ? {} : { visible: [seen('What it changes'), seen('You can read this proposal, not decide it')], absent: [{ role: 'button', name: /^(accept|reject|merge)/i }] }) }, { state: 'row-open', proves: 'role-gating', expectConsole: DIFF_KEY_WARNING }),
    click(rail('Briefs'), 'Open Briefs: what each run was told when it started', { url: '/iq/runbooks/briefs', visible: [heading('Briefs'), seen('Choose a brief')] }, { proves: 'tab-stability', stable: [STILL.header] }),
    tabWalk(8),
    open('/iq/runbooks/rb-missing', 'A runbook that does not exist says it could not load it, and that the cause is unknown rather than empty', { visible: [seen('Could not load this runbook'), seen('That runbook does not exist.')] }, { state: 'not-found', proves: 'empty-state', expectConsole: /404/ }),
  ];
}

// ── social ──────────────────────────────────────────────────────────────────
const bell: Target = { testId: 'activity-bell-button' };
const activityDialog = dialog('Activity');

export function social(role: Role): Step[] {
  const c = CAPS[role];
  const base = `/iq/projects/${AUTH.id}`;
  const panelTab = (testId: string, name: string, expect: Expect) =>
    tabClick({ testId }, `Click ${name} on the conversation: it switches and the header and conversation header stay where they were`, { visible: [{ testId: 'social-chat-panel' }], ...expect }, [STILL.header, { testId: 'social-chat-panel-header' }]);
  return [
    open(base, c.composerPost ? 'The initiative’s discussion lets this role post' : 'The initiative’s discussion is read-only for this role, and says why', { url: base, visible: [heading(AUTH.name), ...(c.composerPost ? [] : [seen(/Your current role cannot post/)])] }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    click(bell, 'Open the activity bell: the notifications dialog opens over the page', { visible: [activityDialog, { text: 'Notifications' }] }, { state: 'dialog-open', proves: 'keyboard' }),
    press('Escape', 'Escape closes the dialog and focus returns to the bell', { hidden: [activityDialog], focused: bell }, { proves: 'keyboard' }),
    click({ testId: 'shell-social-open' }, 'The Social button in the footer opens the conversations (the Communication page), on the initiative’s own channel', { url: /^\/iq\/communication\/channels\/auth-migration/, visible: [{ testId: 'social-chat-panel' }] }, { proves: 'keyboard' }),
    { do: 'wait', target: { testId: 'social-chat-composer-input' }, name: 'The channel’s composer is there for this role: Social lets a participant post where the initiative’s discussion does not', proves: 'role-gating', expect: { visible: [{ testId: 'social-chat-composer-input' }, seen('Sienna Garcia')], noText: LEAKS } } as Step,
    panelTab('social-chat-panel-tab-documents', 'Documents', {}),
    panelTab('social-chat-panel-tab-pins', 'Pinned', {}),
    panelTab('social-chat-panel-tab-calls', 'Calls', {}),
    panelTab('social-chat-panel-tab-chat', 'Chat', { visible: [{ testId: 'social-chat-composer-input' }] }),
    open('/iq/communication', 'The communication page opens on the initiative’s channel, with the other channels in its rail', { url: /^\/iq\/communication\/channels\/[a-z-]+/, visible: [{ testId: 'social-chat-rail' }, { testId: 'social-chat-panel' }] }, { facts: true }),
    tabWalk(10),
    scoped({ scenario: 'empty', fixture: 'notifications' }, base, 'In a world with no notifications the project page loads as before', 'empty', { visible: [heading(AUTH.name)] }, { proves: 'empty-state' }),
    click(bell, 'The bell dialog says there is nothing new and where activity will appear', { visible: [activityDialog, { text: 'Nothing new' }, { text: 'Activity will appear here.' }] }, { state: 'dialog-open', proves: 'empty-state' }),
    press('Escape', 'Escape closes the dialog again', { hidden: [activityDialog], focused: bell }, { proves: 'keyboard' }),
  ];
}

// ── settings ────────────────────────────────────────────────────────────────
const html: Target = { css: 'html' };

export function settings(role: Role): Step[] {
  const user = PERSONA[role].name!.split(',')[0]!;
  // Light is the default: Settings clears the attribute instead of setting it.
  const theme = (v: 'light' | 'dark') => ({ attr: [{ target: html, name: 'data-theme', value: v === 'dark' ? 'dark' : null }] }) as Expect;
  return [
    open('/settings', 'Open Settings: the signed-in person, the session and its role', { url: '/settings', visible: [heading('Settings'), seen('Signed in as'), seen(user), seen(`orgiq · ${role}`)], noText: LEAKS }, { facts: true }),
    click({ text: 'Dark', exact: true, within: { css: 'main' } }, 'Choose the Dark theme: the page turns dark at once', theme('dark'), { proves: 'tab-stability', stable: [STILL.header] }),
    reload('Reload the page: the dark theme is still there', { ...theme('dark'), visible: [heading('Settings')] }),
    click({ text: 'Light', exact: true, within: { css: 'main' } }, 'Choose the Light theme: the page turns light at once', theme('light'), { proves: 'tab-stability', stable: [STILL.header] }),
    reload('Reload the page: the light theme is still there', { ...theme('light'), visible: [heading('Settings')] }),
    { do: 'navigate', url: '/settings#profile', name: 'The #profile link lands on the profile card', expect: { visible: [seen('Signed in as'), seen('Team profile')] } } as Step,
    tabWalk(5),
    press('Tab', 'Tab moves focus to the next control', { visible: [heading('Settings')] }, { proves: 'keyboard' }),
    { do: 'wait', target: heading('Settings'), name: 'Signing out other sessions is offered, not forced: this session is unaffected', proves: 'role-gating', expect: { visible: [seen('This session is unaffected.')] } } as Step,
    { do: 'wait', target: heading('Settings'), name: 'The gateway card says plainly that no standalone gateway is configured, instead of showing a blank', proves: 'empty-state', expect: { visible: [seen(/No standalone WebSocket gateway is configured/)] } } as Step,
  ];
}

// ── local-compute ───────────────────────────────────────────────────────────
const lcTabs = STILL.tablist('Configuration contents');
const lcStill = (): Target[] => [STILL.header, lcTabs];

export function localCompute(role: Role): Step[] {
  const c = CAPS[role];
  const lcTab = (name: string, param: string | null, expect: Expect) =>
    tabClick(tabNamed(name, lcTabs), `Click ${name}: the contents switch and the header and tab strip stay where they were`, { url: param ? new RegExp(`[?&]contents=${param}\\b`) : /^\/iq\/local-compute\/configuration(?:\?(?!.*contents=).*)?$/, ...selected(tabNamed(name, lcTabs)), ...expect }, lcStill());
  return [
    open('/iq/local-compute', 'Open Local compute: the paired machines, and a person with none is told how to pair one', { url: '/iq/local-compute', visible: [heading('Local compute'), seen('No paired machines'), ...(c.localCompute ? [{ role: 'button', name: 'Pair a machine' } as Target] : [])], ...(c.localCompute ? { enabled: [{ role: 'button', name: 'Pair a machine' }] } : { absent: [{ role: 'button', name: 'Pair a machine' }] }) }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    click({ role: 'link', name: /^Configuration/, within: { css: '[data-shell-nav]' } }, 'Open Configuration from the section rail: the bundled skills, hooks and settings', { url: '/iq/local-compute/configuration', visible: [heading('Session settings'), seen(/Configuration preview/)], noText: LEAKS }, { proves: ['tab-stability', 'story-facts'], stable: [STILL.header, { css: '[data-shell-nav] aside' }] }),
    lcTab('Hooks', 'hooks', { visible: [seen(/Hooks/)] }),
    lcTab('Settings', 'settings', { visible: [seen(/Settings/)] }),
    lcTab('Skills', null, { numbers: [{ of: tabNamed('Skills', lcTabs), re: /(\d+)/, eqCount: tableRows }] }),
    fill(search('Search skills'), 'zzzzqq', 'Search zzzzqq among the skills: none match', { visible: [seen('No skill matches the search or availability')] }, { state: 'filtered-empty', proves: 'empty-state' }),
    press('ArrowRight', 'ArrowRight moves focus along the tab strip to Hooks', { focused: tabNamed('Hooks', lcTabs) }, { target: tabNamed('Skills', lcTabs), proves: 'keyboard' }),
    tabWalk(6),
    scoped({ scenario: 'empty', fixture: 'compute-nodes' }, '/iq/local-compute', 'In a world with no machines the page says no paired machines and how pairing goes', 'empty', { visible: [seen('No paired machines'), seen(c.localCompute ? /Pair a machine and it appears here/ : /Pairing a machine needs machine-pairing access/)] }),
    scoped({ scenario: 'error', fixture: 'compute-nodes' }, '/iq/local-compute', 'When the machines cannot be read the page says so instead of showing none', 'error', { visible: [seen('Could not load your paired machines'), { role: 'button', name: 'Try again' }] }, { expectConsole: /500 \(Internal Server Error\)/ }),
  ];
}

// ── refusals ────────────────────────────────────────────────────────────────
/** The rail as each role sees it, verbatim and in order (Layout.tsx rail rows, middleware/seeds/roles/orgiq). */
export const RAIL: Record<Role, string[]> = {
  member: ['Initiatives', 'Decisions', 'Designs', 'Automate', 'Runbooks', 'Agent library', 'Local compute', 'Search', 'Communication', 'Settings'],
  sme: ['Initiatives', 'Decisions', 'Designs', 'Automate', 'Runbooks', 'Agent library', 'Local compute', 'Computer Lab', 'Runs', 'Search', 'Communication', 'Settings'],
  'program-owner': ['Initiatives', 'Decisions', 'Budgets', 'Designs', 'Automate', 'Runbooks', 'Agent library', 'Local compute', 'Computer Lab', 'Runs', 'Search', 'Communication', 'Settings'],
  'org-leader': ['Initiatives', 'Decisions', 'Budgets', 'Designs', 'Automate', 'Runbooks', 'Agent library', 'Local compute', 'Computer Lab', 'Runs', 'Observability', 'Architecture', 'Knowledge', 'Capabilities', 'Search', 'Communication', 'Scores', 'Settings'],
  'hr-admin': ['Initiatives', 'Decisions', 'Budgets', 'Designs', 'Automate', 'Runbooks', 'Agent library', 'Local compute', 'Computer Lab', 'Codebases', 'Runs', 'Observability', 'Architecture', 'Knowledge', 'Capabilities', 'Search', 'Communication', 'Scores', 'Settings', 'Identity'],
};
/** Every rail item any role has, so a role's missing ones are asserted absent. */
const ALL_RAIL = [...new Set(Object.values(RAIL).flat())];
/** Options in the command palette on open, and what ⌘I does (denied, lists or create), per role. The member's are walked; the other roles' are confirmed by their own walks. */
export const PALETTE_COUNT: Record<Role, number> = { member: 19, sme: 28, 'program-owner': 24, 'org-leader': 72, 'hr-admin': 64 };
export const QUICK_SWITCH: Record<Role, 'denied' | 'lists' | 'create'> = { member: 'denied', sme: 'lists', 'program-owner': 'denied', 'org-leader': 'denied', 'hr-admin': 'lists' };
/** APIs that answer 403 for the role (the Cedar action it lacks), probed with the role's own session. */
export const API_403: Record<Role, string[]> = {
  member: ['/api/bots', '/api/budgets', '/api/devbox/boxes', '/api/identity/users', '/api/scores'],
  sme: ['/api/budgets', '/api/identity/users', '/api/scores'],
  'program-owner': ['/api/sdlc/changes', '/api/identity/users', '/api/scores'],
  'org-leader': ['/api/identity/users'],
  'hr-admin': [],
};

const SAMPLE_PARAM = /:[A-Za-z]+/g;
/** A refused route lands on the workspace chooser (RequireRole's fallback), for every persona here: each holds a Social grant beside its Work role. Walked for the member. */
/** Every gated /iq and /admin route (App.tsx, read live) the role cannot reach, with a sample id in each :param. */
export function refusedRoutes(role: Role): Array<{ path: string; url: string }> {
  const src = readRouteSources();
  return src.routes
    .filter((r) => r.roles && !r.roles.includes(role) && /^\/(iq|admin)(\/|$)/.test(r.path) && !r.path.includes('*'))
    .map((r) => ({ path: r.path, url: r.path.replace(SAMPLE_PARAM, 'sample') }));
}
const escapeRe = (p: string) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function refusals(role: Role): Step[] {
  const rail_ = RAIL[role];
  const missing = ALL_RAIL.filter((x) => !rail_.includes(x));
  const absentRail: Target[] = missing.map((x) => ({ role: 'link', name: new RegExp(`^${escapeRe(x)}(?: \\d+)?$`), within: { css: '[data-shell-nav]' } }));
  const qs = QUICK_SWITCH[role];
  // The shared Computer Lab fleet (an in-memory registry no scope forks) puts one palette entry per computer a ManageDevbox role can see.
  const fleetInPalette = CAPS[role].devbox && role !== 'hr-admin';
  const qsText = { denied: 'You don’t have access to computers', lists: 'Jump to a computer, or create one', create: 'Jump to a computer, or create one' }[qs];
  const refused = refusedRoutes(role).map((r): Step => ({
    do: 'navigate', url: r.url, name: `Type ${r.url}: the route sends this role back to its Work home, Initiatives`, state: 'refused', proves: 'hidden-surfaces-direct-route',
    expect: { urlNot: new RegExp(`^${escapeRe(r.url.split('?')[0]!)}`), url: '/iq/projects', visible: [rail('Initiatives')] },
  }));
  const probes = API_403[role].map((u) => api(u, 403, `GET ${u} answers 403: this role lacks the action behind it`, 'api-refused'));
  const post: Step[] = CAPS[role].dispatch ? [] : [api('/api/bots/dispatch-work', 403, 'POST /api/bots/dispatch-work is refused: dispatching needs DispatchAgentRun', 'api-refused', { method: 'POST', body: {}, refusal: 'the empty body names no work item, which the route rejects even past the gate' })];
  return [
    open('/iq/projects', `The rail for ${role}: ${rail_.join(', ')}${missing.length ? '' : ''}`, { url: '/iq/projects', visible: rail_.map(rail), absent: absentRail }, { proves: 'rail-items' }),
    openPalette(null),
    fleetInPalette
      ? { do: 'wait', target: PALETTE, name: `The palette lists ${PALETTE_COUNT[role]} entries for this role, and one more for each computer in the fleet it can see`, proves: 'palette-entries', expect: { count: [{ target: { role: 'option', within: PALETTE }, min: PALETTE_COUNT[role], max: PALETTE_COUNT[role] + 16 }] } } as Step
      : { do: 'wait', target: PALETTE, name: `The palette lists ${PALETTE_COUNT[role]} entries for this role`, proves: 'palette-entries', expect: { count: [{ target: { role: 'option', within: PALETTE }, eq: PALETTE_COUNT[role] }] } } as Step,
    closeDialog('Command palette', undefined, null),
    press('ControlOrMeta+i', qs === 'denied' ? '⌘I quick switch says this role has no access to computers' : '⌘I quick switch lists the computers and offers to create one', { visible: [PALETTE, { text: qsText }] }, { proves: 'quick-switch', state: 'dialog-open' }),
    closeDialog('Command palette', undefined, null),
    ...refused,
    ...probes, ...post,
    { do: 'tab-walk', name: 'Tab from the top of the workspace chooser: its few controls take focus in turn', expect: { minVisited: 4 } } as Step,
  ];
}

// ── frames ──────────────────────────────────────────────────────────────────
export const FRAME_ROUTES = ['/iq/projects', `/iq/projects/${AUTH.id}`, '/iq/decisions', '/iq/work', '/iq/search', '/settings'];
const FRAME_HEADING = (role: Role): Record<string, Target> => ({
  '/iq/projects': heading(LANDS[role]), [`/iq/projects/${AUTH.id}`]: heading(AUTH.name), '/iq/decisions': heading('Decisions'), '/iq/work': heading('Inbox'), '/iq/search': heading('Search'), '/settings': heading('Settings'),
});

export function frames(role: Role): Step[] {
  const heads = FRAME_HEADING(role);
  const out: Step[] = [];
  const pages = (w: number, th: string) => FRAME_ROUTES.map((url): Step => ({ do: 'navigate', url, name: `${url} at ${w} wide, ${th}: nothing clipped, no horizontal scroll`, state: 'default', proves: ['story-facts', 'widths', 'themes'], expect: { url, visible: [heads[url]!], noText: LEAKS } }) as Step);
  out.push(...pages(1440, 'light'));
  for (const th of ['light', 'dark'] as const) {
    if (th === 'dark') {
      out.push({ do: 'theme', value: 'dark', name: 'Switch to the dark theme', state: 'default', proves: 'themes', expect: { attr: [{ target: { css: 'html' }, name: 'data-theme', value: 'dark' }] } } as Step);
      out.push({ do: 'viewport', width: 1440, height: 900, name: 'Back to 1440 wide', proves: 'widths', expect: { visible: [{ css: '.shell-header' }] } } as Step);
      out.push(...pages(1440, th));
    }
    out.push({ do: 'viewport', width: 900, height: 900, name: `Resize to 900 wide, ${th}`, proves: 'widths', expect: { visible: [{ css: '.shell-header' }] } } as Step);
    out.push(...pages(900, th));
  }
  return out;
}

// ── The registry: one function per catalog surface, and the map each role instantiates ──
const PAGE_FILES: Record<string, string> = {
  'local-compute': 'portal/src/pages/local-compute',
  'settings': 'portal/src/pages/SettingsPage.tsx',
  'social': 'portal/src/pages/communication, portal/src/components/shell',
  runbooks: 'portal/src/pages/runbooks',
  library: 'portal/src/pages/library',
  designs: 'portal/src/pages/designs',
  documents: 'portal/src/pages/iq/DocumentRecordPage.tsx, portal/src/lib/workDocuments.ts',
  search: 'portal/src/pages/search',
  job: 'portal/src/pages/work/JobDetailPage.tsx',
  decisions: 'portal/src/pages/decisions',
  automate: 'portal/src/pages/work, portal/src/pages/work/QueuePage.tsx',
  sprints: 'portal/src/pages/projects/SprintsLens.tsx, portal/src/pages/sprints',
  'prepare-job': 'portal/src/pages/project-detail/usePrepareJobDeck.ts, portal/src/pages/project-detail/prepareJobModel.ts, portal/src/pages/ProjectDetailPage.tsx',
  'work-write': 'portal/src/pages/ProjectDetailPage.tsx, portal/src/pages/project-detail/NewItemForm.tsx, portal/src/pages/project-detail/BriefDialogs.tsx, portal/src/pages/project-detail/WorkItemDetail.tsx',
  'work-items': 'portal/src/pages/ProjectDetailPage.tsx, portal/src/pages/project-detail',
  initiative: 'portal/src/pages/ProjectDetailPage.tsx, portal/src/pages/projects, portal/src/pages/project-detail',
  initiatives: 'portal/src/pages/ProjectsPage.tsx, portal/src/pages/initiatives',
};
const GOAL: Record<string, string> = {
  'local-compute': 'Local compute: machines, pairing gated by ConnectLocalCompute, the configuration tabs held still, no machines, an error',
  'settings': 'Settings and profile: the session card, the theme switch read back after a reload',
  'social': 'The bell, the Social bottom bar and its dialog, the chat pane enabled for a poster and disabled with its sentence for a reader, the communication page, no notifications',
  runbooks: 'Runbooks: the library, proposals and briefs; a runbook’s tabs held still; review controls only for ReviewRunbook roles',
  library: 'The agent library: kind, tier and status filters, search, open an asset, a missing asset; New asset only for org-leader and hr-admin',
  designs: 'Design reviews: by status, search, open a thread signed off by people, a missing design, the empty and error worlds',
  documents: 'Read a document from its initiative and its record page; the page thread beside it; a missing document',
  search: 'Search and the palette: find a person, an initiative and a decision; the connections graph; a query that finds nothing; ControlOrMeta+K jumps to a page',
  job: 'One agent run: every tab held still, what it changed and produced, a missing run',
  decisions: 'Decisions: by status, search, open a record that names who decides, a missing record, no decisions at all',
  automate: 'Automate: the inbox, runs, findings and graph changes; filter each, open a run, the empty and error worlds; review and requeue gated by ManageDevbox',
  sprints: 'Sprints: whose and which window, a search that matches nothing, open a sprint and its tabs, no sprints at all',
  'prepare-job': 'The prepare-job card: what a job would run with, the composer keys 1-5 and Enter, Escape; who may dispatch and the sentence that says who can when this role cannot',
  'work-write': 'Change work: create a story, move its status, assign an owner, add a planning note, each read back after a reload, inside a scoped world',
  'work-items': 'Find and read work: search and facets, a filter that matches nothing, open an item and every item tab, the list empty and crowded; edit controls absent or explained by role',
  initiative: 'Read one initiative: every tab and the side pane held still, the header menu and Escape, owner and SMEs by name, a missing initiative',
  initiatives: 'Find an initiative: all and mine, search and status, a search that matches nothing, open one; the list under empty, error, long-text, many and loading worlds',
};
const SURFACE_STEPS: Record<string, (role: Role) => Step[]> = {
  initiatives, initiative, 'work-items': workItems, 'prepare-job': prepareJob, 'work-write': workWrite, sprints, automate, job, decisions, search: searchSurface, documents, designs, library, runbooks, social, settings, 'local-compute': localCompute,
};

/** The journeys that write for a role that dispatches: they run inside a scoped world. */
const writesJourney = (role: Role, journey: string): boolean => writesJob(role) && (journey === 'work-write' || journey === 'prepare-job');

/** The map a role walks for one surface: `docs/journeys/maps/work/<role>/<journey>.ts` is one line of this. */
export function surfaceMap(role: Role, journey: string, opts: Partial<JourneyMap> = {}): JourneyMap {
  const steps = SURFACE_STEPS[journey];
  if (!steps) throw new Error(`no surface steps for ${journey}`);
  return {
    family: 'work', log: `${role}/${journey}`, kind: 'surface', persona: PERSONA[role], scenario: 'shared', identity: 'clone',
    ...(writesJourney(role, journey) ? { scenario: { scope: 'default' }, writes: true } : {}),
    viewport: { width: 1440, height: 900 },
    goal: `${PERSONA[role].name}: ${GOAL[journey]}`,
    fields: { surface: journey, pages: PAGE_FILES[journey] ?? 'portal/src/pages' },
    steps: steps(role), ...opts,
  };
}

/** The refusals map of a role: its rail and palette, ⌘I, every gated route it cannot reach, and the APIs that answer 403. */
export function refusalsMap(role: Role): JourneyMap {
  return {
    family: 'work', log: `${role}/refusals`, kind: 'refusals', persona: PERSONA[role], scenario: 'shared', identity: 'clone', viewport: { width: 1440, height: 900 },
    goal: `${PERSONA[role].name}: the rail and palette as this role sees them, ⌘I quick switch, every gated /iq and /admin route it cannot reach and the APIs that answer 403`,
    fields: { surface: 'refusals', pages: 'portal/src/App.tsx, portal/src/components/shell/Layout.tsx, portal/src/components/shell/portalCommands.ts, middleware/seeds/roles/orgiq' },
    claims: {
      'rail-items': RAIL[role].join(', '),
      'hidden-surfaces-direct-route': 'redirect',
      'palette-entries': String(PALETTE_COUNT[role]),
      'quick-switch': QUICK_SWITCH[role],
      'api-refused': 'pass',
    },
    steps: refusals(role),
  };
}

/** The frames map of a role: the core pages at 1440 and 900 wide, light and dark. */
export function framesMap(role: Role): JourneyMap {
  return {
    family: 'work', log: `${role}/frames`, kind: 'frames', persona: PERSONA[role], scenario: 'shared', identity: 'clone', viewport: { width: 1440, height: 900 },
    goal: `${PERSONA[role].name}: the core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes`,
    fields: { surface: 'frames', pages: 'portal/src/pages/ProjectsPage.tsx, portal/src/pages/ProjectDetailPage.tsx, portal/src/pages/decisions, portal/src/pages/work, portal/src/pages/search, portal/src/pages/SettingsPage.tsx' },
    claims: { widths: '1440, 900', themes: 'light, dark' },
    steps: frames(role),
  };
}
