/** Repository binding for the portable $ui-dom-audit skill. No duplicated route list. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { signIn } from './realSession';
import { selectAuditRoutes, matchesAuditLocation } from './ui-dom-audit.routes';
import { pipelineComposerPolicy } from './ui-dom-audit.policies';
import { staticInventory, paramInventory, PARAM_ROUTES, OBSERVED_ROUTES, resolveParam, SWEEP_USER, sourceDigest, type InventoryRoute } from './route-inventory';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const selectors = {
  graphDetailLabels: '[data-ui-text="graph-detail"]', graphMetadataLabels: '[data-ui-text="graph-metadata"]', activePersonCaptions: '[data-ui-text="active-person-caption"]',
  codeLabels: 'button code, button .font-mono:not(kbd), [role="button"] code, [role="button"] .font-mono:not(kbd)',
  railCaptionLabels: '[data-testid="social-chat-rail-scroll"] button[aria-expanded]:not([aria-haspopup]) > span, button[data-heading="label"][data-focus-key^="g:"] > span',
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
  railHeaders: '[data-testid="subnav-group-header"]',
  toolbarControls: '[data-toolbar-variant="collection"] button:not([aria-label="Clear search"]), [data-toolbar-variant="collection"] input',
  collections: '[data-collection-page]', collectionToolbars: '[data-toolbar-variant="collection"]', sectionTitles: '[data-section-title]',
  tables: '[data-shell-nav] table:not([role="presentation"]):not(.ProseMirror table)',
  composers: '[data-composer-surface]', nestedComposers: '[data-composer-surface] [data-composer-surface]',
  // Explicit content hosts, rather than the immediate padded parent: catches
  // an extra wrapper inset that otherwise makes a narrow shelf look correct.
  // Embedded ledgers use their PageSection; full-page ledgers use the actual
  // content column. Never use the ledger/command host as its own boundary.
  composerBoundary: 'section:has(> [data-collection-command-boundary="embedded"]), [data-testid$="-pane-column"], [data-testid="social-chat-pane"], [data-section-content], [data-testid="shell-split-primary"], [data-subnav-content], [data-testid="page-conversation-pane"]',
  rightPane: '[data-testid="page-conversation-pane"]',
  conversationState: '[data-composer-surface], [data-testid="social-channel-not-joined"], [data-testid="social-shared-work"]',
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
  if (new URL(spec.path, 'http://audit.local').pathname === '/pipelines/configuration') {
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
  authenticate: (context: Parameters<typeof signIn>[0], spec: InventoryRoute) => signIn(context, spec.user ?? SWEEP_USER, { tenant: spec.tenant }),
  async resolveCases(context: any, cases: any[]) {
    return Promise.all(cases.map(async spec => {
      if (spec.auditPreservePath) return spec;
      const param = [...PARAM_ROUTES, ...OBSERVED_ROUTES].find(p => p.pattern === spec.pattern);
      if (!param) return spec;
      const path = await resolveParam(param, async url => { const response = await context.request.get(url); if (!response.ok()) throw new Error(`Route discovery ${url}: ${response.status()}`); return response.json(); });
      // Only an actual 404 can classify a missing report, never an arbitrary load failure.
      const report = /^\/pipelines\/decks\/[^/]+$/.test(path) ? await context.request.get(`/api${path}`) : null;
      return { ...spec, path, auditMissingDeck: report?.status() === 404 };
    }));
  },
  async theme(page: Page, theme: string) {
    if (!['light', 'dark'].includes(theme)) throw new Error(`Unknown theme ${theme}`);
    await page.evaluate(value => { localStorage.setItem('theme', value); document.documentElement.dataset.theme = value; }, theme);
  },
  ready,
  async composerExpectation(page: Page, spec: InventoryRoute & { auditMissingDeck?: boolean; composerExpectation?: { mode: 'required' | 'exempt'; reason?: string } }) {
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
  async discoverStates(page: Page) {
    const states: Array<{ name: string; enter: (p: Page) => Promise<void>; required?: string[] }> = [];
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
    return states;
  },
};
