// The Distillation demo, watched on the three destinations
// (docs/distillation-demo.md).
//
// WHAT IT CHECKS, in story order, signed in as Nora DaSilva (u-nora, sme —
// ManageBots, so she may play the demo and decide samples):
//   0. The landing offers "Play the demo"; pressing it starts the director and
//      the progress line says so.
//   1. Run notes arrive on Knowledge → Run notes, marked New.
//   2. Activity shows the observability pass Retrying after its first
//      delivery fails.
//   3. Review shows the newly sampled patterns marked New; the director decides
//      three, and Nora decides the open one from the queue (Agree).
//   4. The guide: published, with its "when this helps" line, and its Runs tab
//      says the latest run completed all five steps.
//
// WHERE THE STORY COMES FROM. `POST /api/__mock/scenario
// {"scenario":"distillation-demo"}` (middleware/src/mock/distillation-demo.ts).
// The spec waits on the director's milestones at GET /api/__mock/state — never
// on sleeps — and asserts each beat against the UI. After pressing Play it
// restarts the story with a fast pace (`paceMs`) and `autoDecideBeats: 0`, so
// the open pattern waits for the spec's own click.
//
// RUN IT against a PRIVATE BFF + portal pair (the mock world is one world per
// server; starting this replaces it for everyone using that server):
//   cd portal && PARITY_BASE_URL=http://127.0.0.1:5271 npx playwright test e2e/distillation-demo.spec.ts
// DISTILL_DEMO_RESET=0 skips the closing reset (the shared-stack smoke run).

import { test, expect, type APIRequestContext } from '@playwright/test';
import { signIn } from './realSession';

test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });
test.setTimeout(240_000);

const PACE_MS = Number(process.env['DISTILL_DEMO_PACE_MS'] ?? 400);
const FIRST_NOTE = 'Cut over the smallest tenant first — one tenant a day';
const OPEN_PATTERN = 'Clear the shim cookie in the same logout response that ends the Cognito session';
const GUIDE_TITLE = 'Cut over the smallest tenant first — one tenant a day';

interface DemoState {
  phase: string;
  notes: string[];
  milestones: Record<'patternsMinted' | 'sampled' | 'reviewed' | 'retried' | 'guideMinted' | 'published' | 'applied', boolean>;
  samples: Partial<Record<'decision' | 'gotcha' | 'worked' | 'convention' | 'guide', string>>;
  guideId: string | null;
  openDecidedBy: 'person' | 'director' | null;
  errors: string[];
}

async function demoState(request: APIRequestContext): Promise<DemoState> {
  const res = await request.get('/api/__mock/state');
  expect(res.ok(), 'mock control must be on (a dev:mock BFF)').toBe(true);
  return ((await res.json()) as { distillationDemo: DemoState }).distillationDemo;
}

/** Wait on the director, not the clock. */
async function until(request: APIRequestContext, what: string, ready: (s: DemoState) => boolean, timeout = 120_000): Promise<DemoState> {
  let last: DemoState | null = null;
  await expect.poll(async () => {
    last = await demoState(request);
    expect(last.errors, `director errors while waiting for ${what}`).toEqual([]);
    return ready(last);
  }, { message: `waiting for ${what}`, timeout, intervals: [250, 500, 1000] }).toBe(true);
  return last!;
}

test('the Distillation demo plays on Knowledge, Activity and Review', async ({ page, request }) => {
  await page.goto('/');
  await signIn(page, 'u-nora');
  // The spec's own reads (mock state, review, procedures) are cookie-less:
  // the dev BFF reads them as its demo identity, and the control plane needs
  // no session at all.
  const api = request;

  await test.step('0 · the landing offers the demo, and Play starts it', async () => {
    await page.goto('/iq/distillation/knowledge?nav=distillation');
    const panel = page.getByTestId('distillation-demo');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.getByTestId('distillation-demo-play').click();
    await until(api, 'the director to start', (s) => s.phase === 'writing');
    await expect(panel.getByTestId('distillation-demo-line')).toContainText('writing run notes', { timeout: 15_000 });
    // Replay it fast, with the open pattern left for this spec to decide.
    const res = await api.post('/api/__mock/scenario', { data: { scenario: 'distillation-demo', paceMs: PACE_MS, autoDecideBeats: 0 } });
    expect(res.ok()).toBe(true);
  });

  await test.step('1 · run notes arrive live, marked New', async () => {
    await page.goto('/iq/distillation/knowledge?view=notes');
    await expect(page.getByTestId('knowledge-list')).toBeVisible({ timeout: 30_000 });
    await until(api, 'the first notes', (s) => s.notes.length >= 3);
    const list = page.getByTestId('knowledge-list');
    await expect(list.getByText(FIRST_NOTE)).toBeVisible({ timeout: 30_000 });
    await expect(list.getByTestId('knowledge-row-new').first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step('2 · Activity shows a pass retrying after a failed delivery', async () => {
    await until(api, 'the patterns pass', (s) => s.milestones.patternsMinted);
    await page.goto('/iq/distillation/activity');
    await expect(page.getByTestId('activity-runs').getByText('Retrying').first()).toBeVisible({ timeout: 45_000 });
  });

  await test.step('3 · Review: the new samples are marked, and Nora decides the open one', async () => {
    const s = await until(api, 'the scripted verdicts', (x) => x.milestones.sampled && x.phase === 'reviewing'
      && !!x.samples.convention);
    await page.goto('/iq/distillation/review');
    const queue = page.getByTestId('review-queue');
    await expect(queue).toBeVisible({ timeout: 30_000 });
    // Wait until the director has decided its three and only the open one is ours.
    await expect.poll(async () => {
      const r = await api.get('/api/distillation/review?verdict=pending');
      const body = (await r.json()) as { samples: Array<{ id: string }> };
      return body.samples.some((x) => x.id === s.samples.worked)
        && !body.samples.some((x) => x.id === s.samples.convention);
    }, { timeout: 60_000 }).toBe(true);
    await page.goto(`/iq/distillation/review?sample=${encodeURIComponent(s.samples.worked!)}`);
    await expect(page.getByTestId('review-claim')).toContainText(OPEN_PATTERN, { timeout: 30_000 });
    await page.getByTestId('review-agree').click();
    const after = await until(api, 'the open pattern to count as decided by a person', (x) => x.milestones.reviewed);
    expect(after.openDecidedBy).toBe('person');
  });

  await test.step('4 · the guide is published, explains when it helps, and has been run', async () => {
    const s = await until(api, 'the story to finish', (x) => x.phase === 'done', 180_000);
    expect(s.milestones).toMatchObject({ guideMinted: true, published: true, applied: true, retried: true });
    await page.goto(`/iq/distillation/knowledge?item=${encodeURIComponent(s.guideId!)}`);
    const record = page.getByTestId('knowledge-record');
    await expect(record).toContainText(GUIDE_TITLE, { timeout: 30_000 });
    await expect(page.getByTestId('record-when-this-helps')).toContainText('one customer at a time');
    await page.goto(`/iq/distillation/knowledge?item=${encodeURIComponent(s.guideId!)}&tab=runs`);
    await expect(record).toContainText('Latest run completed all 5 steps', { timeout: 30_000 });
    const proc = await (await api.get(`/api/distillation/procedures/${encodeURIComponent(s.guideId!)}`)).json() as { health: { status: string } };
    expect(proc.health.status).toBe('proven');
  });

  if (process.env['DISTILL_DEMO_RESET'] !== '0') {
    await api.post('/api/__mock/reset', { data: {} });
  }
});
