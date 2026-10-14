/** Repository binding for the portable $ui-dom-audit skill. No duplicated route list. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { cloneIdentity, signIn, withMockScope, type MockScopeScenario } from './realSession';
import { selectAuditRoutes, matchesAuditLocation, auditAliasTarget } from './ui-dom-audit.routes';
import { pipelineComposerPolicy, tenantComposerPolicy } from './ui-dom-audit.policies';
import { staticInventory, paramInventory, PARAM_ROUTES, OBSERVED_ROUTES, resolveParam, SWEEP_USER, sourceDigest, type InventoryRoute } from './route-inventory';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const selectors = {
  graphDetailLabels: '[data-ui-text="graph-detail"]', graphMetadataLabels: '[data-ui-text="graph-metadata"]', activePersonCaptions: '[data-ui-text="active-person-caption"]',
  // Input mono emits data-ui-text="code" (ui-components 2.442.1): a URL/regex/cron value on the code profile.
  codeLabels: 'button code, button .font-mono:not(kbd), [role="button"] code, [role="button"] .font-mono:not(kbd), input[data-ui-text="code"]',
  // Since ui-components 2.441.0 every rail caption/group heading emits data-ui-text="rail-caption" (the 11px rail profile).
  railCaptionLabels: '[data-ui-text="rail-caption"], [data-testid="social-chat-rail-scroll"] button[aria-expanded]:not([aria-haspopup]) > span, button[data-heading="label"][data-focus-key^="g:"] > span',
  railItemLabels: '[data-ui-text="rail-item"]',
  conversationLabels: '[data-testid="conversation-row"] > span:nth-of-type(2) > span:first-child > span:first-child',
  conversationMetadata: '[data-testid="conversation-time"], [data-testid="conversation-mention"], [data-testid="conversation-unread"]',
  decorativeText: '[aria-hidden="true"]',
  rowMenuGlyphs: '[data-testid*="-row-menu-"][aria-haspopup] > span',
  keyboardHints: 'kbd', captions: '[data-ui-text="caption"], [data-testid^="social-active-now-person-"] > span:last-child',
  tenantControl: 'button[aria-label$=": switch tenant"]', tickerControl: '[data-testid="footer-today"] > button', avatarControl: '[data-testid="presence-avatar"], button[aria-label$=" more users"], [data-ui-text="avatar"]',
  header: '.shell-header', footer: '[data-testid="shell-footer"]', footerRow: '[data-testid="shell-footer-row"]',
  shellColumns: '[data-shell-nav] > div',
  nestedColumns: 'div:has(> [data-subnav-content]):not([data-shell-nav] > div)',
  workspaceColumns: '[data-testid="social-chat-workspace"], [data-testid="explorer-layout"]',
  splitColumns: '[data-testid$="-split"]:has(> [data-testid$="-primary"])',
  controls: 'button, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="hidden"]), select, textarea, [role="button"]',
  // Dropdowns (ui-components 2.445.0, contracts.md "Dropdowns"): any <select>
  // (painted or hidden), <input list> or <datalist> is the platform's unstyled
  // menu unless it is Select's reasoned native escape hatch; a role=listbox
  // without the library marker is hand-rolled; an open listbox's options sit
  // on the 12/14 scale and the panel inside the viewport.
  nativeSelects: 'select:not([data-ui-native-select][data-ui-native-reason]), select[data-ui-native-reason=""], input[list], datalist',
  unmarkedListboxes: '[role="listbox"]:not([data-ui-listbox])',
  listboxOptions: '[data-ui-listbox] [role="option"]',
  openListboxes: '[data-ui-listbox]',
  railHeaders: '[data-testid="subnav-group-header"]',
  toolbarControls: '[data-toolbar-variant="collection"] button:not([aria-label="Clear search"]), [data-toolbar-variant="collection"] input',
  collections: '[data-collection-page]', collectionToolbars: '[data-toolbar-variant="collection"]', sectionTitles: '[data-section-title]',
  tables: '[data-shell-nav] table:not([role="presentation"]):not(.ProseMirror table)',
  // A collection's table: the library DataTable (data-collection-table) or any
  // table a CollectionPage holds. Its body rows must open their record
  // (row-activatable) unless the table declares static rows with a reason.
  collectionTables: '[data-shell-nav] [data-collection-table] table, [data-shell-nav] [data-collection-page] table:not([role="presentation"]):not(.ProseMirror table)',
  composers: '[data-composer-surface]', nestedComposers: '[data-composer-surface] [data-composer-surface]',
  // Explicit content hosts, rather than the immediate padded parent: catches
  // an extra wrapper inset that otherwise makes a narrow shelf look correct.
  // Embedded ledgers use their PageSection; full-page ledgers use the actual
  // content column. Never use the ledger/command host as its own boundary.
  // Since ui-components 2.448.0 a section's command composer docks at the bottom of the content
  // column (DockedColumn + ColumnDock), so an embedded section is no longer a boundary.
  composerBoundary: '[data-docked-column], [data-testid$="-pane-column"], [data-testid="social-chat-pane"], [data-section-content], [data-testid="shell-split-primary"], [data-subnav-content], [data-testid="page-conversation-pane"]',
  // composer.last: the column a composer must be the last content of (the same hosts), and the dock
  // that holds it (content inside the dock — a call strip — is the dock's, not "below the composer").
  composerColumns: '[data-docked-column], [data-testid$="-pane-column"], [data-testid="social-chat-pane"], [data-section-content], [data-testid="shell-split-primary"], [data-subnav-content], [data-testid="page-conversation-pane"]',
  composerDocks: '[data-column-dock], [data-floating-composer-dock]',
  rightPane: '[data-testid="page-conversation-pane"]',
  // The content column (the trail's parent: SectionContent, or a ListRailLayout header's column) and its
  // reading edge (the trail band, padded by the page gutter): content.gutter, header-alignment, single-title.
  contentColumns: ':has(> [data-testid="section-crumbs"])', trail: '[data-testid="section-crumbs"]',
  // layout.contained-controls: every visible control inside the viewport, its column and its clipping ancestors.
  containedControls: ':is(button, a[href], [role="tab"], select, textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]))',
  containmentRegions: '[data-section-content], [data-subnav-content], [data-shell-nav] aside, .shell-header, [data-testid="shell-footer"]',
  // people.sparse-row: tile lists (ActivePeopleGrid and other role="list" grids) in the app.
  tileLists: '[data-shell-nav] [role="list"]',
  conversationState: '[data-composer-surface], [data-testid="social-channel-not-joined"], [data-testid="social-shared-work"]',
  // popover.fit: an open InlinePopover panel; board.lane-*: CatalogGrid variant="lanes" and its BoardColumn lanes (ui-components 2.443.1).
  popovers: '[data-ui-dialog="popover"]', boards: '[data-ui-board]', boardLanes: '[data-ui-board-lane]',
  // panel.inset / panel.empty-height: every anchored panel (popover, dialog, drawer) and the library
  // EmptyState's semantic marker (ui-components 2.448.0).
  panels: '[role="dialog"], [role="alertdialog"], dialog[open], [data-ui-dialog]', emptyStates: '[data-ui-empty]',
  // section.empty-row: page sections (PageSection's data-ui-section, ui-components 2.449.0).
  sections: '[data-shell-nav] [data-ui-section]',
};
/** Body rows of a collection that has not declared its rows static (see `collectionTables`). */
const collectionRows = ':is([data-shell-nav] [data-collection-table], [data-shell-nav] [data-collection-page]) table:not([role="presentation"]):not([data-collection-rows="static"] table) > tbody > tr:not(:has([colspan])):not([data-testid="datatable-loading-row"])';
/** A record-detail action whose result belongs in the page (a tab, a section or the right pane), never a drawer/modal. */
const RECORD_DETAIL_ACTION = /^(revision history|version history|history|revisions?|view history|view details|details)\b/i;
/** Buttons that can be a record's detail action: in the page, not a navigation rail's disclosure heading. */
const RECORD_ACTION_CANDIDATES = '[data-shell-nav] :is(button, [role="button"]):not([aria-expanded]):not(nav *):not([data-testid="subnav-group-header"])';
/** Details buttons the `details-pane` state already opens into the right pane. */
const DETAILS_PANE = /^(Initiative details|Open initiative details|Show details)$/;
/** A conversation surface's view tabs (ConversationSurface: Chat | Documents | Pinned | Calls). */
const CONVERSATION_VIEW_TABS = '[role="tablist"][aria-label="Views of this conversation"] [role="tab"]';
type Probes = { activateRow: (page: Page, o: { rows: string }) => Promise<unknown>; recordAction: (page: Page, o: { scope: string; name: RegExp; candidates?: string }) => Promise<unknown>; toggleSelection: (page: Page, o: { checkbox: string }) => Promise<unknown> };
/** The footer's NotificationBell (shell chrome, the same on every route — so it is opened on one list route per tenant). */
const FOOTER_BELL = '[data-testid="shell-footer"] [data-notification-bell] button[aria-haspopup="dialog"]';
const BELL_STATE_ROUTES = /^\/(iq\/projects|assessment\/runs|pipelines\/runs|social\/contacts|access\/requests)$/;
type AuditState = { name: string; enter: (p: Page, ctx: { probes: Probes }) => Promise<unknown>; required?: string[]; navigates?: boolean; composerExpectation?: { mode: 'exempt'; reason: string } };
/** The shell regions every page keeps, including the record a probe navigated to. */
const SHELL_REQUIRED = ['$header', '$footer', '$shellColumns'];
/** After a probe navigated or opened something, wait (bounded) for its loading rows to settle. */
async function settled(page: Page) {
  await expect(page.getByTestId('loading-state')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('[data-testid="datatable-loading-row"]')).toHaveCount(0, { timeout: 15000 });
}

/** Each tenant's deck detail API, so a missing report is observed (404), never assumed. */
const DECK_API: Record<string, (id: string) => string> = {
  orgiq: id => `/api/initiative-decks/${id}`,
  assessment: id => `/api/assessment/decks/${id}`,
  pipelines: id => `/api/pipelines/decks/${id}`,
  social: id => `/api/chat/decks/${id}`,
};
/** Where a seeded record route reads its record, so a 404 can be observed rather than assumed. */
const RECORD_API: Record<string, (path: string) => string> = {
  '/iq/work/:jobId': path => `/api/work/jobs/${path.split('/').pop()}`,
  '/iq/library/:assetId': path => `/api/library/${path.split('/').pop()}`,
};
async function assertRoute(page: Page, spec: InventoryRoute) {
  // The tenant root intentionally opens Runs. Other redirects cannot certify the requested page.
  await expect.poll(() => matchesAuditLocation(spec.path, page.url()), { message: `Expected audit route and selected view: ${spec.path}` }).toBe(true);
}
async function ready(page: Page, spec: InventoryRoute & { required?: string[] }) {
  await expect(page.locator(selectors.header)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-tenant', spec.tenant);
  await expect(page.getByTestId('loading-state')).toHaveCount(0, { timeout: 15000 });
  if (spec.required?.includes('$conversationState')) await expect(page.locator(selectors.conversationState).first()).toBeVisible({ timeout: 15000 });
  if (spec.required?.includes('$composers')) await expect(page.locator(selectors.composers).first()).toBeVisible({ timeout: 15000 });
  if (spec.judges?.includes('table')) await expect(page.locator(selectors.tables).first()).toBeVisible();
  await expect(page.locator('[data-testid="datatable-loading-row"]')).toHaveCount(0);
  // Absence of a loading indicator can precede the lazy page mounting. Wait
  // for the actual configuration control before classifying its form policy.
  if (auditAliasTarget(new URL(spec.path, 'http://audit.local').pathname) === '/pipelines/configuration') {
    await expect(page.getByTestId('pipelines-default-approver')).toBeVisible();
  }
  await assertRoute(page, spec);
}
export default {
  assertRoute,
  baseURL: process.env.UI_AUDIT_BASE_URL ?? 'http://127.0.0.1:5183', selectors,
  revision: () => ({ uiComponents: JSON.parse(readFileSync(new URL('../node_modules/@connorhoehnslalom/ui-components/package.json', import.meta.url), 'utf8')).version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sourceDigest: sourceDigest(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) }),
  async cases(options: { tenant?: string; path?: string; all?: boolean }) {
    let routes: InventoryRoute[] = [...staticInventory(), ...paramInventory(), ...OBSERVED_ROUTES.map(r => ({ tenant: r.tenant, path: r.template.replace(':id', encodeURIComponent(r.id ?? r.fallback ?? 'missing')), pattern: r.pattern, source: 'param' as const, kind: /communication|social\/dms/.test(r.pattern) ? 'chat' as const : 'record' as const }))];
    if (options.tenant) routes = routes.filter(r => r.tenant === options.tenant);
    if (options.path) routes = selectAuditRoutes(routes, options.path);
    if (!options.all && !options.path) {
      routes = [...new Set(routes.map(r => r.tenant))].flatMap(tenant => {
        const own = routes.filter(r => r.tenant === tenant && r.source !== 'param');
        const list = own.filter(r => r.judges?.includes('table')).sort((a, b) => Number(/\/(runs|contacts)$/.test(b.path)) - Number(/\/(runs|contacts)$/.test(a.path)))[0];
        const chat = routes.find(r => r.tenant === tenant && /social\/dms\//.test(r.path)) ?? routes.find(r => r.tenant === tenant && r.source === 'param' && r.kind === 'chat') ?? routes.find(r => r.tenant === tenant && /social\/channels\//.test(r.path)) ?? own.find(r => r.kind === 'chat');
        const record = routes.find(r => r.tenant === tenant && /projects\/:id$/.test(r.pattern ?? ''));
        return [list, chat, record].filter(Boolean);
      }) as InventoryRoute[];
    }
    return routes.map(r => ({ ...r, actor: `${r.tenant}:${r.user ?? SWEEP_USER}`,
      // Inspected shared RunsLedger consumers and existing contextual composers.
      // Other route families stay visibly unclassified until their policy is reviewed.
      composerExpectation: pipelineComposerPolicy(r.path) ?? (/^(\/pipelines\/runs(?:\/[^/]+)?|\/iq\/runs|\/assessment\/runs|\/social\/contacts)$/.test(new URL(r.path, 'http://audit.local').pathname)
        || /social\/dms\//.test(r.path) || /projects\/:id$/.test(r.pattern ?? '') ? { mode: 'required' as const } : undefined),
      required: ['$header', '$footer', '$shellColumns', ...(r.judges?.includes('table') ? ['$tables'] : []), ...(r.kind === 'chat' && r.source === 'param' ? ['$conversationState'] : [])],
    }));
  },
  // Default: sign in as the seed persona itself. UI_DOM_AUDIT_CLONES=1 signs each actor in as a
  // fresh dev:mock clone of that persona (own session epoch), so the audit runs beside other
  // browser runs as the same persona without revoking them; UI_DOM_AUDIT_SCOPE=<scenario> also puts
  // the actor's context in a scoped dev:mock world (docs/mock-floor.md § Scopes and clones).
  authenticate: async (context: Parameters<typeof signIn>[0], spec: InventoryRoute) => {
    const persona = spec.user ?? SWEEP_USER;
    if (process.env.UI_DOM_AUDIT_CLONES !== '1') return signIn(context, persona, { tenant: spec.tenant });
    const clone = await cloneIdentity(context.request, persona, 'ui-dom-audit');
    if (process.env.UI_DOM_AUDIT_SCOPE) await withMockScope(context, process.env.UI_DOM_AUDIT_SCOPE as MockScopeScenario);
    return signIn(context, clone, { tenant: spec.tenant });
  },
  async resolveCases(context: any, cases: any[]) {
    return Promise.all(cases.map(async spec => {
      if (spec.auditPreservePath) return spec;
      const param = [...PARAM_ROUTES, ...OBSERVED_ROUTES].find(p => p.pattern === spec.pattern);
      if (!param) return spec;
      const path = await resolveParam(param, async url => { const response = await context.request.get(url); if (!response.ok()) throw new Error(`Route discovery ${url}: ${response.status()}`); return response.json(); });
      // Only an actual 404 can classify a missing report, never an arbitrary load failure.
      const deck = /^\/(?:pipelines|iq|assessment|social)\/decks\/([^/?]+)$/.exec(path);
      const deckApi = deck && DECK_API[spec.tenant]?.(deck[1]);
      const report = deckApi ? await context.request.get(deckApi) : null;
      // A seeded "-missing" record is only classified missing when its API says 404.
      const recordApi = /-missing(?:$|\?)/.test(path) ? RECORD_API[param.pattern]?.(path) : undefined;
      const record = recordApi ? await context.request.get(recordApi) : null;
      return { ...spec, path, auditMissingDeck: report?.status() === 404, auditMissingRecord: record?.status() === 404 };
    }));
  },
  async theme(page: Page, theme: string) {
    if (!['light', 'dark'].includes(theme)) throw new Error(`Unknown theme ${theme}`);
    await page.evaluate(value => { localStorage.setItem('theme', value); document.documentElement.dataset.theme = value; }, theme);
  },
  ready,
  async composerExpectation(page: Page, listSpec: InventoryRoute & { navigatedFrom?: string; auditMissingDeck?: boolean; auditMissingRecord?: boolean; composerExpectation?: { mode: 'required' | 'exempt'; reason?: string } }) {
    // A probe that opened a row's record is classified as that record: none of
    // the list route's own declarations (its table judge, its pattern, its
    // composer policy) describe the page it reached.
    const spec = listSpec.navigatedFrom
      ? { tenant: listSpec.tenant, path: listSpec.path, source: 'param' as const, kind: 'record' as const }
      : listSpec;
    if (spec.tenant !== 'pipelines' || listSpec.navigatedFrom) {
      // Evidence is read after the network settles so a lazily filled table is not mistaken for an empty page.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      const visible = async (selector: string) => (await page.locator(selector).count()) > 0 && await page.locator(selector).first().isVisible();
      const composer = await visible(selectors.composers);
      const table = await visible(selectors.tables);
      const pathname = auditAliasTarget(new URL(spec.path, 'http://audit.local').pathname);
      const controls = await visible('select, [data-ui-control="select"], [role="switch"], input[type="checkbox"], input[type="radio"], [data-testid$="-save"], button[type="submit"]');
      const policy = tenantComposerPolicy({ tenant: spec.tenant, path: auditAliasTarget(new URL(spec.path, 'http://audit.local').pathname) + new URL(spec.path, 'http://audit.local').search, kind: spec.kind, judges: spec.judges, pattern: spec.pattern }, {
        collection: await visible(`${selectors.collections}, ${selectors.collectionToolbars}`),
        table,
        tableSearch: table && await visible('[data-toolbar-variant], input[type="search"], input[aria-label^="Search"], input[placeholder^="Search"]'),
        listRail: await visible('[data-list-rail]'),
        composer,
        graph: await visible('[data-testid=work-activity-canvas], [data-testid=work-graph-canvas], [data-testid=work-graph-empty], .react-flow, [data-testid="explorer-layout"] canvas, [data-testid="explorer-layout"] svg'),
        charts: await visible('.recharts-wrapper, .recharts-responsive-container'),
        chatDirectory: !composer && await visible('[data-testid="social-chat-workspace"], [data-testid="social-chat-rail-scroll"], [data-testid="social-chat-rail"], [data-testid="communication-plane"]'),
        documentDirectory: !composer && !table && await visible('[data-testid^="document-rail"]'),
        communicationOverview: await visible('[data-testid="communication-overview"]'),
        socialAccessRequired: await visible('[data-testid="communication-no-social"]'),
        settingsSurface: !composer && (await visible('[data-testid$="configuration-page"], [data-testid$="-configuration"], [data-testid="settings-profile"]') || (/\/(?:configuration|settings)$/.test(pathname) && controls)),
        form: !composer && !table && (controls || await visible('form, [data-form-wizard]')),
        placeholder: await visible('[data-testid^="social-empty-"], [data-testid="pipelines-empty-settings"], [data-testid="access-empty-settings"]'),
        lab: await visible('[data-testid^="lab-"]'),
        landing: await visible('[data-testid$="-landing"]'),
        missingDeck: !!spec.auditMissingDeck && await page.getByText(/^Couldn't open the /).first().isVisible(),
        missingRecord: !!spec.auditMissingRecord && await visible('[role="alert"], [data-testid$="-unavailable"], [data-testid$="-missing"], [data-testid="load-error"]'),
        recordDetail: spec.kind === 'record' && await visible(`${selectors.sectionTitles}, h1, h2, [data-testid="page-header"], [data-testid="page-section-title"], ${selectors.rightPane}, [data-testid$="-pane-column"], [data-testid$="-record-page"], [data-testid$="-detail-page"]`),
        channelNotJoined: await visible('[data-testid="social-channel-not-joined"]'),
        sharedWorkView: await visible('[data-testid="social-shared-work"]'),
      });
      if (policy) return policy;
    }
    if (spec.tenant === 'pipelines') {
      const policy = pipelineComposerPolicy(spec.path, {
        graph: await page.locator('[data-testid=work-activity-canvas], [data-testid=work-graph-canvas], [data-testid=work-graph-empty]').first().isVisible(),
        communicationOverview: await page.getByTestId('communication-overview').isVisible(),
        socialAccessRequired: await page.getByTestId('communication-no-social').isVisible(),
        configurationForm: await page.getByTestId('pipelines-default-approver').isVisible(),
        settingsPlaceholder: await page.getByTestId('pipelines-empty-settings').isVisible(),
        missingDeck: !!spec.auditMissingDeck && await page.getByText("Couldn't open the report", { exact: true }).isVisible(),
      });
      if (policy) return policy;
    }
    if (spec.composerExpectation) return spec.composerExpectation;
    if (spec.kind === 'chat' && spec.source === 'param') {
      if (await page.getByTestId('social-channel-not-joined').isVisible()) return { mode: 'exempt', reason: 'Channel membership is required before the user can compose messages; join-required state is visible.' };
      if (await page.getByTestId('social-shared-work').isVisible()) return { mode: 'exempt', reason: 'The active shared-work view displays contextual work; its message composer is outside this view.' };
      return { mode: 'required' };
    }
    return undefined;
  },
  async describe(page: Page) {
    return { conversation: await page.getByTestId('social-channel-not-joined').isVisible() ? 'join-required' : await page.getByTestId('social-shared-work').isVisible() ? 'shared-work' : await page.locator(selectors.composers).first().isVisible() ? 'composer' : 'not-present' };
  },
  async discoverStates(page: Page, spec?: InventoryRoute) {
    const states: AuditState[] = [];
    const pathname = spec ? new URL(spec.path, 'http://audit.local').pathname : '';
    // popover.fit: the footer bell's panel (a 99+ feed once grew past the window, over its own trigger).
    // panel.inset / panel.empty-height: the same panel with an EMPTY Unread tab. Read-only: the sweep
    // user (SWEEP_USER, seeded with no inbox items — middleware/src/mock/notifications.ts) opens it; no
    // item is marked read and no scenario is switched to empty it.
    if (BELL_STATE_ROUTES.test(pathname) && await page.locator(FOOTER_BELL).count() === 1) states.push({ name: 'notification-bell-open', required: ['$emptyStates'], enter: async p => {
      await p.locator(FOOTER_BELL).click();
      const panel = p.locator(selectors.popovers).last();
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('tab', { name: /^Unread/ })).toHaveAttribute('aria-selected', 'true');
      await expect(panel.locator(selectors.emptyStates)).toBeVisible();
    } });
    // board.lane-surface / board.lane-columns: the Sprints lens with its first sprint's board open.
    if (pathname === '/iq/projects') states.push({ name: 'sprint-board', navigates: true, required: [...SHELL_REQUIRED, '$boardLanes'], enter: async p => {
      // The user's own active sprint, else (a role that reads every sprint) any active one; the lens opens in the matching scope.
      let found: { id: string; scope: string } | null = null;
      for (const scope of ['mine', 'all']) {
        const response = await p.request.get(`/api/sprints?scope=${scope}&status=active`);
        if (!response.ok()) continue;
        const sprint = ((await response.json()) as { sprints?: { id: string }[] }).sprints?.[0];
        if (sprint) { found = { id: sprint.id, scope }; break; }
      }
      if (!found) throw new Error('No active sprint the sweep user can read; the board state cannot be exercised');
      await p.goto(`/iq/projects?lens=sprints&sprintScope=${found.scope}&sprint=${encodeURIComponent(found.id)}`);
      await settled(p);
      await expect(p.locator(selectors.boardLanes).first()).toBeVisible({ timeout: 15000 });
    } });
    const group = page.getByTestId('subnav-group-header').first();
    if (await group.count() && await group.isVisible()) {
      for (const expanded of [false, true]) states.push({ name: `sidebar-${expanded ? 'expanded' : 'collapsed'}`, required: ['$railHeaders'], enter: async p => {
        const header = p.getByTestId('subnav-group-header').first();
        if (await header.getAttribute('aria-expanded') !== String(expanded)) await header.click();
        await expect(header).toHaveAttribute('aria-expanded', String(expanded));
        const controlled = await header.getAttribute('aria-controls');
        if (!controlled) throw new Error('Accordion is missing aria-controls');
        const body = p.locator(`[id=${JSON.stringify(controlled)}]`);
        if (expanded) await expect(body).toBeVisible(); else await expect(body).toBeHidden();
      } });
    }
    const filter = page.getByRole('button', { name: /^Filters(?: \(\d+ active\))?$/ });
    if (await filter.count() === 1 && await filter.isVisible()) states.push({ name: 'filters-open', enter: async p => { await p.getByRole('button', { name: /^Filters(?: \(\d+ active\))?$/ }).click(); await expect(p.getByRole('dialog').last()).toBeVisible(); } });
    const commandHost = page.getByTestId('collection-command-host');
    if (await commandHost.count() === 1 && await commandHost.isVisible()) states.push({ name: 'commands-help', enter: async p => {
      await p.getByTestId('collection-command-host').locator('[contenteditable="true"]').click();
      const trigger = p.getByTestId('collection-command-host').getByRole('button', { name: /^Available .+ commands$/ });
      await expect(trigger).toHaveCount(1);
      const label = await trigger.getAttribute('aria-label');
      if (!label) throw new Error('Command help trigger must have an accessible label');
      await trigger.click();
      await expect(p.getByRole('dialog', { name: label, exact: true })).toBeVisible();
    } });
    const owner = page.getByRole('button', { name: 'Change who runs this initiative', exact: true });
    if (await owner.count() === 1 && await owner.isVisible()) states.push({ name: 'owner-menu', enter: async p => {
      const trigger = p.getByRole('button', { name: 'Change who runs this initiative', exact: true });
      await trigger.click();
      await expect(p.getByRole('menu', { name: 'Change who runs this initiative' })).toBeVisible();
      await p.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(p.getByRole('menu', { name: 'Change who runs this initiative' })).toBeHidden();
      await trigger.click();
      await expect(p.getByRole('menu', { name: 'Change who runs this initiative' })).toBeVisible();
    } });
    const info = page.getByRole('button', { name: /^(Initiative details|Open initiative details|Show details)$/ });
    if (await info.count() === 1 && await info.isVisible()) states.push({ name: 'details-pane', required: ['$rightPane'], enter: async p => { await p.getByRole('button', { name: /^(Initiative details|Open initiative details|Show details)$/ }).click(); await expect(p.locator(selectors.rightPane)).toBeVisible(); } });
    // A conversation's other views (Documents, Pinned, Calls …): each tab is a state, so a view's own
    // layout (its tab row, empty state, panel) is measured on every plane and Social route that shows it.
    // The composer belongs to the Chat view, so the other views declare it absent with that reason.
    const viewTabs = page.locator(CONVERSATION_VIEW_TABS);
    const views = (await viewTabs.evaluateAll(els => els.filter(el => (el as HTMLElement).offsetParent !== null && el.getAttribute('aria-selected') !== 'true').map(el => (el.textContent ?? '').replace(/\d+$/, '').trim()))).filter(Boolean);
    // A view tab rewrites the URL (`?view=`), so the state is judged as the view it reached: the shell
    // regions, not the Chat view's composer-or-join requirement.
    for (const label of views) states.push({ name: `conversation-view-${label.toLowerCase()}`, navigates: true, required: SHELL_REQUIRED,
      composerExpectation: { mode: 'exempt', reason: `The conversation's ${label} view lists what this conversation holds; its message composer belongs to the Chat view.` },
      enter: async p => {
        const tab = p.locator(CONVERSATION_VIEW_TABS).filter({ hasText: new RegExp(`^${label}\\s*\\d*$`) }).first();
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await settled(p);
      } });
    // Interaction probes (read-only: every non-GET request is blocked and reported).
    // record-popout: activating a collection row must route the record into the
    // page, never open a drawer or modal.
    const row = page.locator(collectionRows).first();
    if (await row.count() && await row.isVisible()) states.push({ name: 'row-activate', navigates: true, required: SHELL_REQUIRED, enter: async (p, { probes }) => {
      const probe = await probes.activateRow(p, { rows: collectionRows });
      await settled(p);
      return probe;
    } });
    // record-popout: a record-detail action (revision history, details) belongs in the page too.
    const detail = page.getByRole('button', { name: RECORD_DETAIL_ACTION }).and(page.locator(RECORD_ACTION_CANDIDATES));
    const detailNames = (await detail.evaluateAll(els => els.filter(el => (el as HTMLElement).offsetParent !== null).map(el => el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()))).filter(name => !DETAILS_PANE.test(name));
    if (detailNames.length) {
      const name = new RegExp(`^${detailNames[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      states.push({ name: 'record-detail-action', navigates: true, required: SHELL_REQUIRED, enter: async (p, { probes }) => {
        const probe = await probes.recordAction(p, { scope: '[data-shell-nav]', name, candidates: RECORD_ACTION_CANDIDATES });
        await settled(p);
        return probe;
      } });
    }
    // selection-shift: ticking a row's checkbox must not move the table.
    const checkbox = `${collectionRows} input[type="checkbox"]`;
    const box = page.locator(checkbox).first();
    if (await box.count() && await box.isVisible()) states.push({ name: 'row-select', enter: (p, { probes }) => probes.toggleSelection(p, { checkbox }) });
    // The first library dropdown on the page, opened: its listbox is judged on
    // the option type scale and viewport containment (contracts.md "Dropdowns").
    const dropdown = page.locator('[data-shell-nav] [data-ui-control="select"]:not([disabled])').first();
    if (await dropdown.count() && await dropdown.isVisible()) states.push({ name: 'dropdown-open', required: ['$openListboxes'], enter: async p => {
      await p.locator('[data-shell-nav] [data-ui-control="select"]:not([disabled])').first().click();
      await expect(p.locator('[data-ui-listbox]').first()).toBeVisible();
    } });
    return states;
  },
};
