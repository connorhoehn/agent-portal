// The layout cascade on every route (docs/layout-cascade.md), per tenant:
//
//   rails         at most two navigation columns start at the content top —
//                 the primary rail and one section rail; a page's list rail
//                 (the library ListRailLayout) is the page's list, not a third nav
//   list-rail     a list rail is flush: its left is the previous rail's right,
//                 it starts at the content top and runs its full height, no
//                 ancestor inside <main> rounds it (no floating box), and it
//                 is the Initiatives rail's 264px
//   crumbs-first  the breadcrumb trail is the content column's first row
//   gutter        the trail sits at the standard 24px gutter from the
//                 content column's left edge — one value on every route
//   title         the page title (or a VisuallyHidden h1) follows the trail,
//                 left-aligned with it
//   footer        exactly one shell footer
//   hscroll       no horizontal page scroll at 1680×940 and 1280×720
//
// Runs against the shared dev stack (http://127.0.0.1:5183); it restarts
// nothing. One sign-in per tenant. LAYOUT_CASCADE_ONLY=<substring> narrows
// the sweep for a quick look. A complete run records what it measured on each
// route as the cascade half of the routes' rendered contract
// (docs/journeys/contracts/cascade.json, docs/journeys.md).
import { test, expect, type Page } from '@playwright/test';
import {
  DEPTH_PAIRS, LIST_PAGES, OBSERVED_ROUTES, PARAM_ROUTES, SWEEP_USER, TENANTS, exemptions, resolveParam, routeKey, sourceDigest, staticInventory,
  type Invariant, type InventoryRoute, type Tenant,
} from './route-inventory';
import { LAYOUT_CASCADE_BASELINE } from './layout-cascade-baseline';
import { finishParts, recordPart } from './contracts';
import { signIn as signInAs } from './realSession';

const BASE = process.env.LAYOUT_CASCADE_BASE ?? 'http://127.0.0.1:5183';
const GUTTER = 24;
// The Initiatives rail (ExplorerLayout railWidth="ms"): every list rail shares it.
const LIST_RAIL_WIDTH = 264;
const TOL = 2;
// EditorShell's head carries a fixed 20px inset (docs/ui-components-queue.md),
// so a loaded editor's h1 sits that far right of the trail until the library
// takes a prop. Only the deck editor route has it.
const EDITOR_HEAD_INSET = 20;
const insetFor = (route: string) => (/^\/(iq|assessment|social|pipelines)\/(.+\/)?decks\/[^/?]+$/.test(route.split('?')[0]!) ? EDITOR_HEAD_INSET : 0);
const ONLY = process.env.LAYOUT_CASCADE_ONLY ?? '';

test.use({ baseURL: BASE, viewport: { width: 1680, height: 940 } });

interface Measure {
  landed: string;
  mainLeft: number; mainTop: number; mainHeight: number;
  rails: Array<{ left: number; right: number; label: string; list?: boolean }>;
  listRail: { left: number; right: number; top: number; height: number; width: number; radius: number } | null;
  crumb: { left: number; top: number; bottom: number; text: string } | null;
  title: { left: number; top: number; hidden: boolean; text: string } | null;
  footers: number;
  scrollW: number; innerW: number;
}

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const visible = (e: Element) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const main = document.querySelector('[data-shell-nav] main') ?? document.querySelector('main');
    const m = main?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    // Navigation columns: tall nav/aside landmarks that START at the content
    // top (beside the trail). A list pane opens under the trail and title.
    const cols = [...document.querySelectorAll('aside, nav, [role="navigation"]')].filter(visible).map((e) => {
      const b = e.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), top: b.top, height: b.height, width: b.width, label: e.getAttribute('aria-label') ?? e.getAttribute('data-testid') ?? e.tagName.toLowerCase() };
    }).filter((c) => c.width >= 120 && c.width <= 480 && c.height >= m.height * 0.6 && c.top <= m.top + 4 && c.left < m.right - 200);
    const byLeft = new Map<number, typeof cols[number]>();
    for (const c of cols) if (![...byLeft.keys()].some((x) => Math.abs(x - c.left) <= 2)) byLeft.set(c.left, c);
    const rails: Array<{ left: number; right: number; label: string; list?: boolean }> = [...byLeft.values()].sort((a, b) => a.left - b.left).map(({ left, right, label }) => ({ left, right, label }));
    // The page's list rail (the library ListRailLayout): the Explorer rail inside
    // [data-list-rail]. It counts as the page's list, not a navigation
    // column, and must be flush.
    const listEl = [...(main ?? document).querySelectorAll('[data-list-rail] nav[aria-label="Explorer"]')].find(visible) ?? null;
    let listRail: Measure['listRail'] = null;
    if (listEl) {
      const b = listEl.getBoundingClientRect();
      let radius = 0;
      for (let el: Element | null = listEl; el && el !== main; el = el.parentElement) radius = Math.max(radius, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
      listRail = { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), height: Math.round(b.height), width: Math.round(b.width), radius };
      for (const r of rails) if (Math.abs(r.left - listRail.left) <= 2) r.list = true;
    }
    const crumbEl = [...(main ?? document).querySelectorAll('nav[aria-label="Breadcrumb"], nav[aria-label="breadcrumb"], nav[aria-label*="readcrumb"]')].find(visible) ?? null;
    const cb = crumbEl?.getBoundingClientRect();
    const crumb = cb ? { left: Math.round(cb.left), top: Math.round(cb.top), bottom: Math.round(cb.bottom), text: (crumbEl!.textContent ?? '').slice(0, 80) } : null;
    // The title: the first h1 after the trail in document order.
    const h1s = [...(main ?? document).querySelectorAll('h1')];
    const after = crumbEl ? h1s.filter((h) => crumbEl.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) : h1s;
    const h = after[0] ?? null;
    let title: Measure['title'] = null;
    if (h) {
      const b = h.getBoundingClientRect();
      const cs = getComputedStyle(h);
      const hidden = b.width <= 1 || b.height <= 1 || cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)';
      // A compact PageHeader may lead with its back control. The header
      // group aligns to the trail; its title text naturally follows the icon.
      // Measure that real leading control, not a hard-coded pixel exemption.
      const row = h.closest('[data-testid$="-row"]');
      const leading = row?.firstElementChild;
      const backLink = leading?.matches('a[aria-label]') ? leading : leading?.querySelector('a[aria-label]');
      const back = backLink && leading?.nextElementSibling?.contains(h) ? backLink : null;
      title = { left: Math.round(back?.getBoundingClientRect().left ?? b.left), top: Math.round(b.top), hidden, text: (h.textContent ?? '').slice(0, 60) };
    }
    return {
      landed: location.pathname + location.search,
      mainLeft: Math.round(m.left), mainTop: Math.round(m.top), mainHeight: Math.round(m.height),
      rails, listRail, crumb, title,
      footers: document.querySelectorAll('[data-testid="shell-footer"]').length,
      scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
    };
  });
}

interface Violation { inv: Invariant; line: string }

function judge(route: string, m: Measure, skip: Set<Invariant>): Violation[] {
  const out: Array<{ inv: Invariant; msg: string }> = [];
  const bad = (inv: Invariant, msg: string) => { if (!skip.has(inv)) out.push({ inv, msg: `${inv}: ${msg}` }); };
  const nav = m.rails.filter((r) => !r.list);
  if (nav.length > 2) bad('rails', `${nav.length} navigation columns at the content top (${nav.map((r) => `${r.label}@${r.left}`).join(', ')})`);
  if (m.listRail) {
    const l = m.listRail;
    const before = Math.max(m.mainLeft, ...nav.filter((r) => r.left < l.left).map((r) => r.right));
    if (l.left - before < -1 || l.left - before > 2) bad('list-rail', `list rail at x=${l.left}, ${l.left - before}px from the rail beside it (ends ${before}) — not stacked flush`);
    if (Math.abs(l.top - m.mainTop) > 2) bad('list-rail', `list rail starts ${l.top - m.mainTop}px below the content top`);
    if (l.height < m.mainHeight - 4) bad('list-rail', `list rail ${l.height}px of ${m.mainHeight} — not full height`);
    if (l.radius > 2) bad('list-rail', `list rail floats in a rounded box (radius ${l.radius}px)`);
    if (Math.abs(l.width - LIST_RAIL_WIDTH) > 2) bad('list-rail', `list rail ${l.width}px wide, the Initiatives rail is ${LIST_RAIL_WIDTH}`);
  }
  // The content column's left edge: right of the last rail beside the trail.
  const contentLeft = Math.max(m.mainLeft, ...m.rails.filter((r) => !m.crumb || r.left < m.crumb.left).map((r) => r.right));
  if (!m.crumb) {
    bad('crumbs-first', 'no breadcrumb trail');
  } else {
    if (m.crumb.top - m.mainTop > 24) bad('crumbs-first', `trail starts ${m.crumb.top - m.mainTop}px below the content top`);
    const g = m.crumb.left - contentLeft;
    if (Math.abs(g - GUTTER) > TOL) bad('gutter', `trail at x=${m.crumb.left}, ${g}px from the content edge ${contentLeft} (want ${GUTTER})`);
  }
  if (!m.title) bad('title', 'no h1 after the trail');
  else if (!m.title.hidden && m.crumb) {
    if (Math.abs(m.title.left - m.crumb.left - insetFor(m.landed)) > TOL) bad('title', `title "${m.title.text}" at x=${m.title.left}, trail at x=${m.crumb.left}`);
    if (m.title.top < m.crumb.bottom) bad('title', `title "${m.title.text}" above the trail`);
    if (m.title.top - m.crumb.bottom > 64) bad('title', `title "${m.title.text}" ${m.title.top - m.crumb.bottom}px under the trail`);
  }
  if (m.footers !== 1) bad('footer', `${m.footers} shell footers`);
  if (m.scrollW > m.innerW + 1) bad('hscroll', `scrollWidth ${m.scrollW} > ${m.innerW} at 1680`);
  return out.map((f) => ({ inv: f.inv, line: `${route} -> ${m.landed}  ${f.msg}` }));
}

const signIn = (page: Page, tenant: Tenant) => signInAs(page, SWEEP_USER, { tenant });
const apiGet = (page: Page) => async (url: string) => { const res = await page.request.get(url); return res.ok() ? res.json() : null; };

async function resolveParams(page: Page, tenant: Tenant): Promise<InventoryRoute[]> {
  const out: InventoryRoute[] = [];
  for (const r of PARAM_ROUTES.filter((p) => p.tenant === tenant)) {
    out.push({ tenant, path: await resolveParam(r, apiGet(page)), source: 'param', pattern: r.pattern });
  }
  return out;
}

async function settle(page: Page) {
  await page.getByTestId('shell-footer').first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.locator('main h1, main nav[aria-label="Breadcrumb"]').first().waitFor({ timeout: 8_000 }).catch(() => {});
  // Let lazy panes and count fetches land before measuring.
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

const inventory = staticInventory();

test('inventory covers every tenant', () => {
  for (const t of TENANTS) expect(inventory.filter((r) => r.tenant === t).length, t).toBeGreaterThan(0);
  expect(PARAM_ROUTES.length).toBeGreaterThanOrEqual(15);
});

const swept: Record<string, number> = {};
// The cascade half of each route's rendered contract: which invariants it
// breaks (baselined or not) and where it lands. Written only after a complete run.
const contract: Record<string, { violations: Invariant[]; lands: string | null }> = {};
const startDigest = sourceDigest();

for (const tenant of TENANTS) {
  test(`layout cascade on every ${tenant} route`, async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await signIn(page, tenant);
    const routes = [...inventory.filter((r) => r.tenant === tenant), ...await resolveParams(page, tenant)]
      .filter((r) => !ONLY || r.path.includes(ONLY));
    const failures: string[] = [];
    const known: string[] = [];
    // Journey-walked routes outside the judged inventory: measured for their contract, never judged.
    const observed = ONLY ? [] : await Promise.all(OBSERVED_ROUTES.filter((o) => o.tenant === tenant).map(async (o) => ({ tenant, path: await resolveParam(o, apiGet(page)), source: 'param' as const, pattern: o.pattern, observe: true })));
    for (const r of [...routes, ...observed] as Array<InventoryRoute & { observe?: boolean }>) {
      const key = r.pattern ?? r.path;
      const allowed = new Set(LAYOUT_CASCADE_BASELINE[key] ?? []);
      const seen = new Set<Invariant>();
      const record = (v: Violation) => { seen.add(v.inv); if (!r.observe) (allowed.has(v.inv) ? known : failures).push(v.line); };
      await page.setViewportSize({ width: 1680, height: 940 });
      await page.goto(r.path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      // The shared dev stack: another session's tenant switch for the same
      // seeded user bumps its epoch and drops this cookie (≤120s). Sign in
      // again and retry the route once rather than measure the picker.
      if (/^\/(select|login)/.test(new URL(page.url()).pathname)) {
        await signIn(page, tenant);
        await page.goto(r.path, { waitUntil: 'domcontentloaded' });
        await settle(page);
      }
      const m = await measure(page);
      // A redirect lands on another page: its exemptions apply too.
      const skip = new Set([...exemptions(r.path), ...exemptions(m.landed)]);
      judge(r.path, m, skip).forEach(record);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(250);
      const narrow = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, i: innerWidth }));
      if (narrow.w > narrow.i + 1 && !skip.has('hscroll')) record({ inv: 'hscroll', line: `${r.path} -> ${m.landed}  hscroll: scrollWidth ${narrow.w} > ${narrow.i} at 1280` });
      contract[key] = { violations: [...seen].sort(), lands: routeKey(m.landed) === key ? null : (routeKey(m.landed) ?? new URL(m.landed, 'http://x').pathname) };
      // The ratchet: a baselined violation that no longer occurs must go.
      if (!r.observe) for (const inv of allowed) if (!seen.has(inv)) failures.push(`${key}  baseline: '${inv}' no longer occurs — remove it from layout-cascade-baseline.ts`);
    }
    if (known.length) console.log(`${tenant}: ${known.length} baselined violations (layout-cascade-baseline.ts)`);
    swept[tenant] = routes.length;
    if (!ONLY) recordPart('cascade', tenant, Object.fromEntries(Object.entries(contract).filter(([k]) => [...routes, ...observed].some((r) => (r.pattern ?? r.path) === k))), startDigest);
    console.log(`${tenant}: swept ${routes.length} routes, ${failures.length} violations`);
    if (failures.length) console.log(failures.join('\n'));
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

// A loaded deck editor (the sweep only reaches a not-found deck): created
// through the real mock BFF as a seeded assessor, then measured. The trail is
// the shell's alone — the editor draws none of its own — and the deck title is
// the one h1 under it.
test('a loaded deck editor carries one trail, first, and one h1', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, 'u-asha', { tenant: 'assessment' });
  const created = await page.request.post('/api/assessment/teams/TEAM-001/decks', { data: {} });
  expect(created.status(), 'create deck').toBe(202);
  const { deckId } = await created.json() as { deckId: string };
  await page.goto(`/assessment/decks/${encodeURIComponent(deckId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('deck-editor')).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(300);
  const m = await measure(page);
  const crumbs = await page.locator('main nav[aria-label*="readcrumb"]').count();
  const h1s = await page.locator('main h1').count();
  console.log(`deck editor: crumbs=${crumbs} h1=${h1s} ${JSON.stringify({ crumb: m.crumb, title: m.title, rails: m.rails.length, mainLeft: m.mainLeft })}`);
  expect(crumbs, 'breadcrumb navs in main').toBe(1);
  expect(h1s, 'h1s in main').toBe(1);
  expect(judge(m.landed, m, new Set()).map((v) => v.line)).toEqual([]);
});

// Rule 8: which rail gives way. Depth 1–2 keeps both rails open; from three
// levels down the primary rail folds to its strip and the section rail stays
// open (the library rail model: railDepth + useRailFold, declared in Layout.tsx).
// DEPTH_PAIRS: the shallow/deep pairs live in the route inventory.

async function railFrame(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-shell-nav]');
    const primary = shell?.querySelector(':scope > div > aside')?.getBoundingClientRect();
    const main = shell?.querySelector(':scope > div > main')?.getBoundingClientRect();
    // The section rail: a tall navigation column starting at the content's left edge.
    const section = [...document.querySelectorAll('main aside, main nav, main [role="navigation"]')].map((e) => e.getBoundingClientRect())
      .find((b) => main && Math.abs(b.left - main.left) <= 2 && b.width >= 120 && b.height >= main.height * 0.6);
    return {
      primaryState: shell?.getAttribute('data-primary-rail'), sectionState: shell?.getAttribute('data-section-rail'),
      depth: Number(shell?.getAttribute('data-drill-depth')), primaryWidth: Math.round(primary?.width ?? 0),
      sectionWidth: section ? Math.round(section.width) : null,
    };
  });
}

for (const pair of DEPTH_PAIRS) {
  test(`rail collapse priority: ${pair.name}`, async ({ page }) => {
    await signIn(page, pair.tenant);
    await page.goto(pair.shallow, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const shallow = await railFrame(page);
    expect(shallow.depth, `${pair.shallow} depth`).toBeLessThanOrEqual(2);
    expect(shallow.primaryState, `${pair.shallow}: primary rail open at depth ${shallow.depth}`).toBe('open');
    expect(shallow.primaryWidth).toBeGreaterThanOrEqual(180);
    const deepPath = typeof pair.deep === 'string' ? pair.deep : await resolveParam(pair.deep, apiGet(page));
    await page.goto(deepPath, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const deep = await railFrame(page);
    expect(deep.depth, `${deepPath} depth`).toBeGreaterThanOrEqual(3);
    expect(deep.primaryState, `${deepPath}: primary rail collapses at depth ${deep.depth}`).toBe('collapsed');
    expect(deep.primaryWidth, 'primary rail folds to its strip').toBeLessThanOrEqual(48);
    expect(deep.sectionState, 'section rail stays open').toBe('open');
    if (deep.sectionWidth != null) expect(deep.sectionWidth, 'section rail is not a bare strip').toBeGreaterThanOrEqual(120);
    // The trail is still the content column's first row.
    const m = await measure(page);
    if (!exemptions(deepPath).has('crumbs-first') && !(LAYOUT_CASCADE_BASELINE[pair.key ?? deepPath.split('?')[0]!]?.includes('crumbs-first'))) {
      expect(m.crumb, `${deepPath}: breadcrumb trail`).not.toBeNull();
    }
  });
}

test('rail collapse: the reader can re-expand the primary rail, remembered per device', async ({ page }) => {
  await signIn(page, 'orgiq');
  await page.goto('/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e2-b4', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.getByTestId('shell-rail-toggle').click();
  expect((await railFrame(page)).primaryState).toBe('open');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page);
  expect((await railFrame(page)).primaryState, 'the choice survives a reload').toBe('open');
  await page.getByTestId('shell-rail-toggle').click();
  expect((await railFrame(page)).primaryState).toBe('collapsed');
  // A narrow window folds the primary rail first; the section rail stays.
  await page.evaluate(() => { try { localStorage.removeItem('shell.primary-rail.shallow'); } catch { /* */ } });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/iq/projects/p-observability', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const narrow = await railFrame(page);
  expect(narrow.primaryState).toBe('collapsed');
  expect(narrow.sectionState).toBe('open');
});

test('rail collapse: a legacy hand-set section fold never folds a deep page', async ({ page }) => {
  await signIn(page, 'orgiq');
  // The device state in the user's screenshot: the work list folded by hand
  // under the legacy, depth-less key.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('initiatives.rail-collapsed', '1');
      localStorage.removeItem('initiatives.rail-collapsed.deep');
      localStorage.removeItem('shell.primary-rail.deep');
    } catch { /* */ }
  });
  await page.goto('/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e2-b4', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const deep = await railFrame(page);
  expect(deep.primaryState, 'primary rail folds at depth 3').toBe('collapsed');
  expect(deep.sectionWidth, 'the work list (section rail) is open despite the legacy key').not.toBeNull();
  expect(deep.sectionWidth!).toBeGreaterThanOrEqual(120);
  const m = await measure(page);
  expect(m.crumb, 'trail is still the content column’s first row').not.toBeNull();
  expect(m.crumb!.top - m.mainTop).toBeLessThanOrEqual(24);
});

test('rail collapse: a selection explored in the right pane is deep (Search › Ask about selection)', async ({ page }) => {
  await signIn(page, 'orgiq');
  await page.addInitScript(() => { try { localStorage.removeItem('shell.primary-rail.deep'); localStorage.removeItem('shell.primary-rail.shallow'); } catch { /* */ } });
  await page.goto('/iq/search?scope=p-llm-platform&q=k.kl&tab=connections&type=person&selection=person%3Ap-016', { waitUntil: 'domcontentloaded' });
  await settle(page);
  // A selection alone is a highlight: both rails stay open.
  const selected = await railFrame(page);
  expect(selected.depth).toBeLessThanOrEqual(2);
  expect(selected.primaryState).toBe('open');
  await page.getByTestId('search-people-toolbar').getByRole('button', { name: /Ask about selection/ }).click();
  await expect(page.getByTestId('page-conversation-pane')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await railFrame(page)).primaryState).toBe('collapsed');
  const deep = await railFrame(page);
  expect(deep.depth).toBeGreaterThanOrEqual(3);
  expect(deep.primaryWidth).toBeLessThanOrEqual(48);
  expect(deep.sectionState).toBe('open');
  // Closing the pane gives the depth back.
  await page.getByTestId('page-conversation-pane').getByRole('button', { name: /Collapse/ }).click();
  await expect.poll(async () => (await railFrame(page)).primaryState).toBe('open');
});

// Rule 5: every page with a list draws it as a flush list rail beside the
// section rail (the library ListRailLayout) — the sweep above judges a list rail where
// one exists; this case requires one on each list page, so a list cannot
// drift back into a bordered pane inside the content. Distillation's content
// header carries no repository button: the repository is in the list rail's
// filter popover beside its search (docs/distillation-redesign-spec.md §1).
// `record`: a record is open beside the list rail — the selection level, so
// the primary rail folds to its strip (the library rail model) while the section
// rail and the list rail stay open. `editor`: the record is an EditorShell
// whose header, body sections and docked composer share one left edge.
// LIST_PAGES: the list pages live in the route inventory (validate-rail-parity.sh measures the same list).

test('list pages draw a flush list rail beside the section rail, trail first after it', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await signIn(page, 'orgiq');
  // The default band behaviour, not a reader's remembered toggle.
  await page.addInitScript(() => { try { localStorage.removeItem('shell.primary-rail.deep'); localStorage.removeItem('shell.primary-rail.shallow'); } catch { /* */ } });
  const problems: string[] = [];
  for (const entry of LIST_PAGES) {
    const path = entry.path ?? await resolveParam(entry.param!, apiGet(page));
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const m = await measure(page);
    const lines = judge(path, m, new Set()).filter((v) => v.inv === 'list-rail' || v.inv === 'gutter' || v.inv === 'crumbs-first').map((v) => v.line);
    if (!m.listRail) lines.push(`${path}  no list rail ([data-list-rail] nav[aria-label="Explorer"])`);
    else if (m.crumb && m.crumb.left < m.listRail.right) lines.push(`${path}  the trail (x=${m.crumb.left}) is not right of the list rail (ends ${m.listRail.right})`);
    if (path.startsWith('/iq/distillation')) {
      if (await page.locator('main [data-testid="section-crumbs"] select, main [data-testid="distillation-repo"]').count()) lines.push(`${path}  a repository control sits in the content header`);
      if (await page.locator('main').getByRole('combobox', { name: 'Repository' }).count()) lines.push(`${path}  a "Repository" select outside the rail's filter popover`);
    }
    if (entry.repoInRail) {
      const rail = page.locator('[data-list-rail] nav[aria-label="Explorer"]').first();
      await rail.getByRole('button', { name: /^Filter/ }).first().click();
      const hasRepo = await page.getByText('Repository', { exact: true }).first().isVisible().catch(() => false);
      if (!hasRepo) lines.push(`${path}  the list rail's filter popover has no Repository facet`);
      await page.keyboard.press('Escape');
    }
    if (entry.record) {
      const f = await railFrame(page);
      if (f.primaryState !== 'collapsed' || f.primaryWidth > 48) lines.push(`${path}  a record is open beside the list rail (depth ${f.depth}) but the primary rail is ${f.primaryState} (${f.primaryWidth}px)`);
      if (f.sectionState !== 'open') lines.push(`${path}  the section rail folded`);
    }
    if (entry.editor) {
      const inset = await page.evaluate(() => {
        const pane = document.querySelector('[data-list-rail] [data-testid$="-pane"]');
        if (!pane) return null;
        const textLeft = (el: Element | null | undefined) => {
          if (!el) return null;
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t: Node | null;
          while ((t = w.nextNode())) { if ((t.textContent ?? '').trim().length > 2) { const r = document.createRange(); r.selectNodeContents(t); return Math.round(r.getBoundingClientRect().left); } }
          return null;
        };
        const heading = [...pane.querySelectorAll('h1, h2')].find((e) => e.getBoundingClientRect().width > 1);
        const section = [...pane.querySelectorAll('h2, h3, [role="heading"]')].find((e) => e !== heading && e.getBoundingClientRect().width > 1);
        const dock = pane.querySelector('[data-testid="distillation-composer"]');
        const frame = dock ? [...dock.querySelectorAll('*')].find((e) => parseFloat(getComputedStyle(e).borderLeftWidth) > 0 && e.getBoundingClientRect().width > 300) : null;
        const crumbs = [...pane.querySelectorAll('nav[aria-label*="readcrumb"]')].map((e) => (e.textContent ?? '').trim());
        return { header: textLeft(heading), body: textLeft(section), composer: frame ? Math.round(frame.getBoundingClientRect().left) : null, crumbs };
      });
      if (!inset) lines.push(`${path}  no record pane`);
      else {
        if (inset.crumbs.length) lines.push(`${path}  a second breadcrumb inside the record: ${inset.crumbs.join(' | ')}`);
        const xs = [inset.header, inset.body, inset.composer];
        if (xs.some((x) => x == null) || Math.max(...(xs as number[])) - Math.min(...(xs as number[])) > 1) lines.push(`${path}  record pane insets differ: header ${inset.header}, body ${inset.body}, composer ${inset.composer}`);
        console.log(`${path}: record insets ${JSON.stringify(inset)}`);
      }
    }
    console.log(`${path}: ${JSON.stringify({ listRail: m.listRail, crumb: m.crumb && { left: m.crumb.left, top: m.crumb.top } })}`);
    problems.push(...lines);
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test.afterAll(() => {
  // Written once every tenant's part of this run is on disk; a filtered or interrupted run records nothing.
  if (!ONLY) finishParts('cascade', TENANTS);
});
