import { test, expect, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The pipelines activity/work graph (docs/activity-graph-migration.md §8):
// /pipelines/activity is realtime-modules' useWorkGraph into ui-components'
// WorkGraph, fed by GET /api/pipelines/work-graph/workspace/graph and kept live
// by the gateway's work-graph stream on `pipelines:workgraph:workspace`. Real
// BFF, real session, real socket, on the shared dev:mock stack
// (http://127.0.0.1:5183); nothing is reset or restarted.
//
//   1. The canvas draws the in-day runs the API serves, by title.
//   2. One live run status change: a runbook dry-run appears, then is cancelled
//      — both arrive as this viewer's own deltas on the socket (no reload, and
//      the content-free hint fallback never subscribed).
//   3. One approval arriving, and leaving: an operator (ApproveStep) sees the
//      pending consult as an approval card as a delta; an author on the same
//      page is never sent it — not in the snapshot, not on her socket.
test.use({ viewport: { width: 1440, height: 1000 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });
test.describe.configure({ mode: 'serial' });

const RUNBOOK = 'runbook:promo-aurora-cold-start';
type Node = { id: string; kind: string; title: string; status: string };

async function session(browser: Browser, baseURL: string | undefined, userId: string, tenant = 'pipelines') {
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
  const res = await page.request.get('/api/pipelines/work-graph/workspace/graph', { params: { day: today(timezone), timezone } });
  expect(res.status()).toBe(200);
  return (await res.json()).nodes as Node[];
}
async function openActivity(page: Page) {
  await page.goto('/pipelines/activity');
  const root = page.getByTestId('pipelines-activity');
  await expect(root.locator('section[aria-label="Shared work graph"]').first()).toBeVisible({ timeout: 20_000 });
  return root;
}

test('the activity page draws the in-day runs the API serves', async ({ browser, baseURL }) => {
  const kofi = await session(browser, baseURL, 'u-kofi');
  try {
    const root = await openActivity(kofi.page);
    const runs = (await served(kofi.page)).filter(n => n.kind === 'run');
    expect(runs.length).toBeGreaterThan(0);
    // The canvas shows the newest runs inside the default window; at least one served title is on screen.
    await expect.poll(async () => {
      for (const run of runs.slice(0, 12)) if (await root.getByText(run.title, { exact: true }).count()) return true;
      return false;
    }, { timeout: 20_000 }).toBe(true);
    await root.screenshot({ path: test.info().outputPath('pipelines-activity.png') });
    expect(kofi.errors).toEqual([]);
  } finally { await kofi.context.close(); }
});

test('a run appears and changes status live, as deltas on the stream', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const kofi = await session(browser, baseURL, 'u-kofi');
  let runId: string | null = null;
  try {
    const root = await openActivity(kofi.page);
    await expect.poll(() => kofi.stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
    const started = await kofi.context.request.post(`/api/pipelines/definitions/${encodeURIComponent(RUNBOOK)}/dry-run`, {
      data: { confirmOverRunBudget: true, confirmOverAllocation: true, confirmOverEnvelope: true },
    });
    expect(started.status(), 'a dry-run accepted (202)').toBe(202);
    runId = (await started.json()).run.id as string;
    const card = root.locator(`[data-work-card="prun:${runId}"]`);
    // The new run arrives without a reload, as a delta naming it.
    await expect(card).toHaveAttribute('aria-label', /, (idle|running|waiting)$/, { timeout: 30_000 });
    expect(kofi.stream.some(p => p.includes('"kind":"delta"') && p.includes(`prun:${runId}`))).toBe(true);
    // Cancelling moves its status; the card follows on the same stream.
    const cancelled = await kofi.context.request.post(`/api/pipelines/runs/${encodeURIComponent(runId)}/cancel`);
    expect(cancelled.status()).toBe(200);
    await expect(card).toHaveAttribute('aria-label', /, stopped$/, { timeout: 30_000 });
    expect(kofi.stream.some(p => p.includes('"kind":"delta"') && p.includes(`prun:${runId}`) && p.includes('stopped'))).toBe(true);
    // The content-free hint fallback never subscribed.
    expect(kofi.sent.some(p => p.includes('"pipelines:workgraph"'))).toBe(false);
    await root.screenshot({ path: test.info().outputPath('pipelines-activity-live-run.png') });
    expect(kofi.errors).toEqual([]);
  } finally { await kofi.context.close(); }
});

test('an approval arrives for an operator as a delta, never for an author, and leaves when answered', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const kofi = await session(browser, baseURL, 'u-kofi');
  const ines = await session(browser, baseURL, 'u-ines');
  const nora = await session(browser, baseURL, 'u-nora', 'orgiq');
  const question = `E2E activity approval ${Date.now()}`;
  let consultId: string | null = null;
  try {
    const kofiRoot = await openActivity(kofi.page);
    const inesRoot = await openActivity(ines.page);
    for (const who of [kofi, ines]) await expect.poll(() => who.stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);

    // A pending consult is an approval waiting on a person (GET /api/pipelines/approvals).
    const opened = await kofi.context.request.post('/api/lab/consults', { data: { question, context: 'pipelines activity graph e2e' } });
    expect(opened.status()).toBe(201);
    consultId = (await opened.json()).consult.id as string;
    const approval = kofiRoot.locator(`[data-work-card="approval:consult:${consultId}"]`);
    await expect(approval).toHaveAttribute('aria-label', /, waiting$/, { timeout: 30_000 });
    expect(kofi.stream.some(p => p.includes('"kind":"delta"') && p.includes(`approval:consult:${consultId}`))).toBe(true);
    await kofiRoot.screenshot({ path: test.info().outputPath('pipelines-activity-approval-operator.png') });

    // The author is served runs but no approval — in her snapshot, on her page and on her socket.
    expect((await served(ines.page)).filter(n => n.id.startsWith('approval:'))).toEqual([]);
    expect((await served(kofi.page)).some(n => n.id === `approval:consult:${consultId}`)).toBe(true);
    await expect(inesRoot.getByText(question)).toHaveCount(0);
    expect(ines.stream.join('\n')).not.toContain('approval:');
    expect(ines.stream.join('\n')).not.toContain(question);

    // Answering it (DispatchAgentRun holder) removes the approval live.
    const answered = await nora.context.request.post(`/api/lab/consults/${encodeURIComponent(consultId)}/answer`, { data: { answer: 'Smallest first.' } });
    expect(answered.status()).toBe(200);
    consultId = null;
    await expect(approval).toHaveCount(0, { timeout: 30_000 });
    expect(kofi.errors).toEqual([]); expect(ines.errors).toEqual([]);
  } finally {
    if (consultId) await nora.context.request.post(`/api/lab/consults/${encodeURIComponent(consultId)}/answer`, { data: { answer: 'cleanup' } });
    await kofi.context.close(); await ines.context.close(); await nora.context.close();
  }
});

test('a run page carries its own activity graph: the run, its definition and its steps', async ({ browser, baseURL }) => {
  const kofi = await session(browser, baseURL, 'u-kofi');
  try {
    const list = await (await kofi.context.request.get('/api/pipelines/runs?limit=200')).json();
    const runs = list.runs as Array<{ id: string; startedAt: string | null }>;
    let target: { id: string; stepIds: string[] } | null = null;
    for (const r of runs.filter(x => x.startedAt).slice(0, 25)) {
      const steps = (await (await kofi.context.request.get(`/api/pipelines/runs/${encodeURIComponent(r.id)}/steps`)).json()).steps as Array<{ stepId: string }>;
      if (steps.length > 1) { target = { id: r.id, stepIds: steps.map(s => s.stepId) }; break; }
    }
    expect(target, 'a run with steps').toBeTruthy();
    await kofi.page.goto(`/pipelines/runs/${encodeURIComponent(target!.id)}?tab=activity`);
    const section = kofi.page.getByTestId('pipeline-run-activity');
    await section.scrollIntoViewIfNeeded({ timeout: 20_000 });
    await expect(section.locator('section[aria-label="Shared work graph"]').first()).toBeVisible({ timeout: 20_000 });
    await expect(section.locator(`[data-work-card="prun:${target!.id}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(section.locator(`[data-work-card="step:${target!.id}:${target!.stepIds[0]}"]`)).toBeVisible({ timeout: 20_000 });
    await section.screenshot({ path: test.info().outputPath('pipelines-run-activity.png') });
    expect(kofi.errors).toEqual([]);
  } finally { await kofi.context.close(); }
});
