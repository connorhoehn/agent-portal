import { test, expect, type Page } from '@playwright/test';
import { signIn } from './realSession';

// Ask about selection opens the four-pane layout (the user, 2026-10-07, on the
// Connections tab): pane 1 the primary rail, folded at this depth; pane 2 the
// Search rail; pane 3 the graph, with the width priority and its toolbar
// pinned; pane 4 the shell's right pane (the library SidePane)
// holding the conversation thread (the ONE composer with its context chips is
// docked at the bottom of pane 3) and the selected record as a pane tab. Nothing else conversation-related
// stays in pane 3. The trail gets its own row and reads in full.
// Runs against the shared Tilt app (PARITY_BASE_URL, default :5183); the mock
// BFF streams the reply deterministically.

test.use({ ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

const TARA = 'p-016';
const BASE = '/iq/search?scope=p-llm-platform&q=k.kl&tab=connections&type=person';
const SELECTED = `${BASE}&selection=${encodeURIComponent(`person:${TARA}`)}`;

async function signedIn(page: Page, userId = 'u-theo') {
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.removeItem('shell.primary-rail.deep'); localStorage.removeItem('shell.primary-rail.shallow'); } catch { /* */ } });
  await signIn(page, userId);
}
async function box(page: Page, selector: string) {
  const rect = await page.locator(selector).first().boundingBox();
  expect(rect, selector).not.toBeNull();
  return rect!;
}
async function rails(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-shell-nav]');
    const primary = shell?.querySelector(':scope > div > aside')?.getBoundingClientRect();
    const section = document.querySelector('#main-content [data-testid$="rail-scroll"]')?.getBoundingClientRect();
    return { primary: shell?.getAttribute('data-primary-rail'), depth: Number(shell?.getAttribute('data-drill-depth')),
      primaryWidth: Math.round(primary?.width ?? 0), sectionWidth: Math.round(section?.width ?? 0) };
  });
}

test('1440x900: Ask about selection opens the four-pane layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await page.goto(SELECTED);
  // Selected, not yet asked: the record is docked beside the graph, both rails open.
  const card = page.getByTestId('search-person-card');
  await expect(card).toContainText('Tara Wright', { timeout: 20_000 });
  expect((await rails(page)).primary).toBe('open');
  await expect(page.getByTestId('search-person-expand')).toBeVisible();

  await page.getByTestId('search-people-toolbar').getByRole('button', { name: /Ask about selection/ }).click();

  // Pane 4: the conversation thread and the record tab; the ONE composer, with
  // its context chips, docked at the bottom of pane 3 (the user, 2026-10-07).
  const pane = page.getByTestId('page-conversation-pane');
  await expect(pane).toBeVisible({ timeout: 10_000 });
  const dock = page.getByTestId('search-explorer').getByTestId('search-composer-dock');
  await expect(dock).toBeVisible();
  await expect(dock).toContainText('LLM Application Platform');
  await expect(dock).toContainText('Tara Wright');
  await expect(pane.locator('[contenteditable="true"], textarea')).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]:visible, textarea:visible')).toHaveCount(1);
  await expect(pane.getByRole('tab', { name: 'Tara Wright' })).toBeVisible();
  const right = await box(page, '[data-testid="page-conversation-pane"]');
  expect(right.width).toBeGreaterThanOrEqual(318);
  expect(right.width).toBeLessThanOrEqual(382);
  expect(Math.round(right.x + right.width)).toBe(1440);

  // Pane 3: the composer only — no conversation strip, no docked record.
  const content = page.getByTestId('search-explorer');
  await expect(content.getByTestId('search-assistant-strip')).toHaveCount(0);
  await expect(content.getByTestId('search-person-card')).toHaveCount(0);
  await expect(content.getByText('Session history is unavailable')).toHaveCount(0);
  await expect(content.getByTestId('search-start-call')).toHaveCount(0);
  await expect(pane.getByTestId('search-start-call')).toHaveCount(0);

  // Panes 1 and 2: the primary rail folds to its strip; the Search rail stays.
  await expect.poll(async () => (await rails(page)).primary).toBe('collapsed');
  const r = await rails(page);
  expect(r.depth).toBeGreaterThanOrEqual(3);
  expect(r.primaryWidth).toBeLessThanOrEqual(48);
  expect(r.sectionWidth).toBeGreaterThanOrEqual(120);

  // The trail: its own row, every label whole, ending at the selection.
  const trail = page.getByTestId('search-trail');
  const crumbs = (await trail.locator('li').allInnerTexts()).map(t => t.replace(/[›/]/g, '').trim()).filter(Boolean);
  expect(crumbs).toEqual(['Org', 'Search', 'LLM Application Platform', 'k.kl', 'Tara Wright']);
  await expect(trail.locator('[role="tablist"], [role="tab"]')).toHaveCount(0);
  const clipped = await trail.locator('a, span').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
  expect(clipped).toEqual([]);

  // Send the prefilled question from the content composer; the reply streams into the pane.
  await dock.getByRole('button', { name: /^Send$/ }).click();
  await expect(pane.getByTestId('search-pane-transcript').getByTestId('markdown-view').last()).toBeVisible({ timeout: 30_000 });

  // The graph has the width priority and its toolbar stays in view.
  const main = await box(page, '#main-content');
  const graph = await box(page, '[data-testid="search-people-canvas"]');
  console.log(JSON.stringify({ main: Math.round(main.width), graph: Math.round(graph.width), ratio: +(graph.width / main.width).toFixed(2), pane: Math.round(right.width), rails: r }));
  expect(graph.width / main.width).toBeGreaterThanOrEqual(0.55);
  // Opening the pane re-fits the graph (OrgGraph fitAll): every drawn person
  // stays inside the narrower canvas.
  const outside = async () => page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="search-people-canvas-canvas"]')!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('[data-testid="search-org-graph"] [data-person-id]')].map(n => n.getBoundingClientRect()).filter(r => r.width > 0);
    return { nodes: nodes.length, outside: nodes.filter(r => r.left < canvas.left - 1 || r.right > canvas.right + 1 || r.top < canvas.top - 1 || r.bottom > canvas.bottom + 1).length };
  });
  await expect.poll(async () => (await outside()).outside, { timeout: 5_000 }).toBe(0);
  const fitted = await outside();
  console.log(JSON.stringify({ fitted }));
  expect(fitted.nodes).toBeGreaterThan(1);
  const toolbar = await box(page, '[data-testid="search-people-toolbar"]');
  const header = await box(page, '[data-testid="search-header"]');
  expect(toolbar.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(900);

  // Every row of pane 4 shares one left edge.
  const edges = await page.getByTestId('search-pane').evaluate(root => [...root.children]
    .filter(child => child.getBoundingClientRect().height > 0).map(child => Math.round(child.getBoundingClientRect().left)));
  expect(edges.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1);

  // The record tab, then its Open page: the person's own route.
  await pane.getByRole('tab', { name: 'Tara Wright' }).click();
  await expect(pane.getByTestId('search-pane-record')).toContainText('Tara Wright');
  await pane.getByRole('button', { name: 'Open page' }).click();
  await expect(page).toHaveURL(new RegExp(`/iq/search\\?.*selection=person%3A${TARA}`));
  expect(new URL(page.url()).searchParams.get('scope')).toBeNull();
  expect(new URL(page.url()).searchParams.get('pane')).toBeNull();
  expect(errors).toEqual([]);
});

test('the docked record expands: Open in pane pops it right, Open page opens the full page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await page.goto(SELECTED);
  await expect(page.getByTestId('search-person-card')).toContainText('Tara Wright', { timeout: 20_000 });
  await page.getByTestId('search-person-expand').click();
  await page.getByRole('menuitem', { name: 'Open in pane' }).click();
  const pane = page.getByTestId('page-conversation-pane');
  await expect(pane.getByTestId('search-pane-record')).toContainText('Tara Wright');
  await expect(page.getByTestId('search-explorer').getByTestId('search-person-card')).toHaveCount(0);
  // Back to the docked card, then Open page from it.
  await pane.getByRole('button', { name: /Collapse/ }).click();
  await expect(pane).toHaveCount(0);
  await expect(page.getByTestId('search-person-card')).toContainText('Tara Wright');
  await page.getByTestId('search-person-expand').click();
  await page.getByRole('menuitem', { name: 'Open page' }).click();
  await expect(page).toHaveURL(new RegExp(`selection=person%3A${TARA}`));
  expect(new URL(page.url()).searchParams.get('scope')).toBeNull();
});
