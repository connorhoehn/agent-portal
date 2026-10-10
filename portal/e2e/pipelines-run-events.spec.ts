import { loginAs } from './realSession';
import { test, expect } from './cdpTest';

// Operator journey defect #1 (docs/pipelines-journeys/operator/DEFECTS.md):
// the run page's Events feed (the gateway's activity feed) must carry the
// run's recorded history on load, and the Run header must follow a live status
// frame without a reload. Real BFF + session; no mock reset (shared stack).

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

test('a finished run shows its recorded events on load, and a moving run updates its header live', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await loginAs(context, 'u-kofi', baseURL, true);
    expect((await context.request.post('/api/session/tenant', { data: { tenant: 'pipelines' } })).status()).toBe(200);

    const list = await (await context.request.get('/api/pipelines/runs?limit=200')).json();
    const done = (list.runs as Array<{ id: string; status: string }>).find(r => r.status === 'completed' || r.status === 'failed');
    expect(done, 'a finished seeded run').toBeTruthy();
    await page.goto(`/pipelines/runs/${encodeURIComponent(done!.id)}`);
    const events = page.getByTestId('pipeline-events');
    await expect(events).toBeVisible();
    await expect(events).not.toContainText('No recent activity');
    await expect(events).toContainText(/run\.(completed|failed)|completed|failed/i);

    // A runbook dry-run starts "pending" and finishes while the page is open.
    const defs = await (await context.request.get('/api/pipelines/definitions')).json();
    const runbooks = (defs.definitions as Array<{ id: string; kind: string }>).filter(d => d.kind === 'runbook');
    expect(runbooks.length, 'a runbook definition').toBeGreaterThan(0);
    // A runbook with a dry-run already in flight answers 409; take the first that accepts.
    let run: { id: string } | undefined;
    for (const rb of runbooks) {
      const started = await context.request.post(`/api/pipelines/definitions/${encodeURIComponent(rb.id)}/dry-run`, { data: { confirmOverRunBudget: true, confirmOverAllocation: true, confirmOverEnvelope: true } });
      if (started.status() === 202) { run = (await started.json()).run; break; }
    }
    expect(run, 'a dry-run accepted (202)').toBeTruthy();
    await page.goto(`/pipelines/runs/${encodeURIComponent(run!.id)}`);
    const header = page.getByTestId('pipeline-run');
    const statusOf = async () => (await (await context.request.get(`/api/pipelines/runs/${encodeURIComponent(run!.id)}`)).json()).run.status as string;
    const initial = await statusOf();
    await expect(header).toContainText(new RegExp(initial.replace(/_/g, '[ _]'), 'i'));
    // The record moves on its own (the dispatcher claims the job); the header
    // must follow it with no reload. It leaves the first status, then agrees
    // with the stored record.
    await expect.poll(async () => (await statusOf()) !== initial, { timeout: 90_000 }).toBe(true);
    await expect.poll(async () => {
      const now = (await statusOf()).replace(/_/g, ' ');
      return ((await header.innerText()).toLowerCase().includes(now));
    }, { timeout: 30_000 }).toBe(true);
  } finally {
    await context.close();
  }
});
