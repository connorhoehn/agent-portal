import { test, expect, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The assessment activity/work graph (docs/activity-graph-migration.md §9):
// /assessment/activity is realtime-modules' useWorkGraph into ui-components'
// WorkGraph, fed by GET /api/assessment/work-graph/workspace/graph and kept live
// by the gateway's work-graph stream on `assessment:workgraph:workspace`. Real
// BFF, real session, real socket, on the shared dev:mock stack
// (http://127.0.0.1:5183); nothing is reset or restarted.
//
//   1. The canvas draws the teams the API serves, by title; the rail and the
//      team scorecard both reach the graph.
//   2. One live score change: a dimension nobody had assessed is scored, and its
//      card (with the team it belongs to) arrives as this viewer's own delta —
//      no reload, and the content-free hint fallback never subscribed.
//   3. One live evidence-draft change: a drafted summary appears as a `change`
//      node, then settles to waiting-on-an-editor, as deltas on a second
//      assessor's page; an orgiq session is refused the API and the stream.
test.use({ viewport: { width: 1440, height: 1000 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });
test.describe.configure({ mode: 'serial' });

// The shared stack keeps earlier walkers' scores, and the spec needs an
// unassessed dimension, so put the assessment score fixtures back to their
// registered rows (scoped: nothing outside assessment is touched).
test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  for (const fixture of ['assessment-scores', 'assessment-runs', 'assessment-scoring-logs', 'assessment-evidence-log']) {
    expect((await context.request.post('/api/__mock/reset', { data: { fixture } })).status(), `mock reset ${fixture}`).toBe(200);
  }
  await context.close();
});

type Node = { id: string; kind: string; title: string; status: string };
const TEAM = 'TEAM-006';

async function session(browser: Browser, baseURL: string | undefined, userId: string, tenant = 'assessment') {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  await loginAs(context, userId, baseURL, true);
  if (tenant !== 'orgiq') expect((await context.request.post('/api/session/tenant', { data: { tenant } })).status()).toBe(200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const stream: string[] = [];
  const sent: string[] = [];
  page.on('websocket', ws => {
    ws.on('framereceived', f => { const p = String(f.payload); if (p.includes('"work-graph"')) stream.push(p); });
    ws.on('framesent', f => { sent.push(String(f.payload)); });
  });
  return { context, page, errors, stream, sent };
}
function today(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function served(page: Page): Promise<Node[]> {
  const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const res = await page.request.get('/api/assessment/work-graph/workspace/graph', { params: { day: today(timezone), timezone } });
  expect(res.status()).toBe(200);
  return (await res.json()).nodes as Node[];
}
async function openActivity(page: Page) {
  await page.goto('/assessment/activity');
  const root = page.getByTestId('assessment-activity');
  await expect(root.locator('section[aria-label="Shared work graph"]').first()).toBeVisible({ timeout: 20_000 });
  return root;
}

test('the activity page draws the teams the API serves, and the rail and scorecard reach it', async ({ browser, baseURL }) => {
  const asha = await session(browser, baseURL, 'u-asha');
  try {
    const root = await openActivity(asha.page);
    const teams = (await served(asha.page)).filter(n => n.kind === 'project' && n.id.startsWith('team:'));
    expect(teams.length).toBeGreaterThan(0);
    await expect.poll(async () => {
      for (const team of teams.slice(0, 12)) if (await root.getByText(team.title, { exact: true }).count()) return true;
      return false;
    }, { timeout: 20_000 }).toBe(true);
    await root.screenshot({ path: test.info().outputPath('assessment-activity.png') });
    // The rail row sits under Analyze and goes to the page.
    await asha.page.goto('/assessment/teams');
    await asha.page.getByRole('link', { name: 'Work graph' }).first().click();
    await expect(asha.page).toHaveURL(/\/assessment\/activity$/);
    // The team scorecard carries its own team's graph.
    await asha.page.goto('/assessment/teams/TEAM-001?tab=activity');
    const section = asha.page.getByTestId('team-activity');
    await expect(section.locator('section[aria-label="Shared work graph"]').first()).toBeVisible({ timeout: 20_000 });
    await expect(section.locator('[data-work-card="team:TEAM-001"]')).toBeVisible({ timeout: 20_000 });
    await section.screenshot({ path: test.info().outputPath('assessment-team-activity.png') });
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('a score change arrives live as a delta: the dimension and its team', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const asha = await session(browser, baseURL, 'u-asha');
  try {
    const root = await openActivity(asha.page);
    await expect.poll(() => asha.stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
    // A dimension nobody has assessed yet, derived at run time (never a fake score).
    const detail = await (await asha.context.request.get(`/api/assessment/teams/${TEAM}`)).json();
    const open = (detail.dimensions as Array<{ id: string; current_level: number | null; is_na: boolean }>).find(d => d.current_level == null && !d.is_na);
    test.skip(!open, `no unassessed dimension left on ${TEAM} after the scoped assessment reset`);
    const dim = open!.id;
    expect((await served(asha.page)).some(n => n.id === `dim:${TEAM}:${dim}`)).toBe(false);
    const applied = await asha.context.request.post(`/api/assessment/teams/${TEAM}/scores/apply`, {
      data: {
        relevant_dimension_ids: [dim],
        scores: [{ dimension_id: dim, suggested_level: 2, confidence: 'moderate', rationale: 'Activity graph e2e', evidence_excerpts: ['Observed during the e2e walkthrough'] }],
      },
    });
    expect(applied.status(), await applied.text()).toBe(200);
    const card = root.locator(`[data-work-card="dim:${TEAM}:${dim}"]`);
    await expect(card).toHaveAttribute('aria-label', /, completed$/, { timeout: 30_000 });
    expect(asha.stream.some(p => p.includes('"kind":"delta"') && p.includes(`dim:${TEAM}:${dim}`))).toBe(true);
    await expect(root.locator(`[data-work-card="team:${TEAM}"]`)).toBeVisible({ timeout: 30_000 });
    // The content-free hint fallback never subscribed.
    expect(asha.sent.some(p => p.includes('"assessment:workgraph"'))).toBe(false);
    await root.screenshot({ path: test.info().outputPath('assessment-activity-live-score.png') });
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('an evidence draft arrives as a delta on another assessor’s page; an orgiq session is refused', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const asha = await session(browser, baseURL, 'u-asha');
  const farah = await session(browser, baseURL, 'u-farah');
  const nora = await session(browser, baseURL, 'u-nora', 'orgiq');
  try {
    const farahRoot = await openActivity(farah.page);
    await expect.poll(() => farah.stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
    const started = await asha.context.request.post(`/api/assessment/teams/${TEAM}/dimensions/1/drafts/evidence-summary`);
    expect(started.status(), await started.text()).toBe(202);
    const runId = (await started.json()).runId as string;
    const card = farahRoot.locator(`[data-work-card="draft:${runId}"]`);
    // It arrives on the other assessor's socket, then settles to waiting on an editor.
    await expect(card).toHaveAttribute('aria-label', /, (running|waiting)$/, { timeout: 30_000 });
    expect(farah.stream.some(p => p.includes('"kind":"delta"') && p.includes(`draft:${runId}`))).toBe(true);
    await expect(card).toHaveAttribute('aria-label', /, waiting$/, { timeout: 60_000 });
    await farahRoot.screenshot({ path: test.info().outputPath('assessment-activity-live-draft.png') });
    // Never delivered across tenants: the orgiq session is refused the API and has no assessment frames.
    expect((await nora.context.request.get('/api/assessment/work-graph/workspace/graph', { params: { day: '2026-10-06', timezone: 'UTC' } })).status()).toBe(403);
    await nora.page.goto('/iq/activity');
    expect(nora.stream.join('\n')).not.toContain(runId);
    expect(farah.errors).toEqual([]);
  } finally { await asha.context.close(); await farah.context.close(); await nora.context.close(); }
});
