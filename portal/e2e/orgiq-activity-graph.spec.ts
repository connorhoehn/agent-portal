import { test, expect, type Browser, type Page } from '@playwright/test';
import { workDayWindow } from '@connorhoehnslalom/realtime-modules/work-graph';
import { loginAs } from './realSession';

// The orgiq activity/work graph (docs/activity-graph-migration.md): the
// initiative overview's Activity section is realtime-modules' useWorkGraph into
// ui-components' WorkGraph, fed by GET /api/work-graph/initiatives/:id/graph.
// Headless, against the running dev:mock stack (http://localhost:5183).
//
//   1. The canvas draws the initiative's real in-day rows — every run node the
//      API serves this viewer appears by title.
//   2. A member (no bots read gate) is served no run nodes and sees none.
//   3. Another user's work-item status change appears live over the gateway's
//      work-graph stream (realtime-modules 0.108): this viewer's own delta
//      arrives on the socket, with no reload and no hint-channel fallback.
//   4. (slice 2) A sprint node and a decision node appear for a budgets-tier
//      viewer — the sprint on the overview, the decision on its own day.
//   6-7. (slice 3) A sprint move and an own flow run reach an open graph as stream deltas.
//   5. (slice 2) The person selector narrows /iq/activity to one person's day:
//      the URL carries ?person=, their work stays, others' work goes.
test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: 'serial' });

const INITIATIVE = 'p-auth-migration';
type Snapshot = { nodes: Array<{ id: string; kind: string; title: string }>; details: Array<{ nodeId: string; badge?: string }> };

async function session(browser: Browser, baseURL: string | undefined, userId: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  await loginAs(context, userId, baseURL);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors };
}
function today(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function snapshot(page: Page): Promise<Snapshot> {
  const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const res = await page.request.get(`/api/work-graph/initiatives/${INITIATIVE}/graph`, { params: { day: today(timezone), timezone } });
  expect(res.status()).toBe(200);
  const v1 = await res.json();
  return { nodes: v1.nodes, details: [] };
}
async function openOverview(page: Page) {
  await page.goto(`/iq/projects/${INITIATIVE}?tab=activity`);
  const section = page.getByTestId('initiative-activity');
  await section.scrollIntoViewIfNeeded({ timeout: 20_000 });
  await expect(section.getByRole('region', { name: 'Shared work graph' }).or(section.locator('section[aria-label="Shared work graph"]')).first()).toBeVisible({ timeout: 20_000 });
  await expect(section.getByText('Auth Migration', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return section;
}

test('the initiative overview draws the in-day runs the API serves', async ({ browser, baseURL }) => {
  const nora = await session(browser, baseURL, 'u-nora');
  try {
    const section = await openOverview(nora.page);
    const served = await snapshot(nora.page);
    const runs = served.nodes.filter(n => n.kind === 'run');
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) await expect(section.getByText(run.title, { exact: true }).first()).toBeVisible();
    await section.screenshot({ path: test.info().outputPath('initiative-activity-sme.png') });
    expect(nora.errors).toEqual([]);
  } finally { await nora.context.close(); }
});

test('a member is served no run nodes and sees none', async ({ browser, baseURL }) => {
  const theo = await session(browser, baseURL, 'u-theo');
  try {
    const section = await openOverview(theo.page);
    const served = await snapshot(theo.page);
    expect(served.nodes.filter(n => n.kind === 'run' || n.kind === 'agent')).toEqual([]);
    await expect(section.getByText('auth-dep-watch run')).toHaveCount(0);
    expect(theo.errors).toEqual([]);
  } finally { await theo.context.close(); }
});

test('another user’s work-item status change appears live', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const nora = await session(browser, baseURL, 'u-nora');
  const eli = await session(browser, baseURL, 'u-eli');
  let restore: { id: string; status: string } | null = null;
  try {
    const tree = await (await eli.page.request.get(`/api/graph/projects/${INITIATIVE}/work`)).json() as Array<{ id: string; title: string; status: string; children: unknown[] }>;
    const flat: Array<{ id: string; title: string; status: string }> = [];
    const walk = (rows: Array<{ id: string; title: string; status: string; children: unknown[] }>) => { for (const r of rows) { flat.push(r); walk(r.children as never); } };
    walk(tree);
    const target = flat.find(i => i.status === 'open');
    expect(target, 'an open work item to start').toBeTruthy();

    // Every work-graph frame and any fallback hint subscription on nora's socket.
    const stream: string[] = [];
    const sentFrames: string[] = [];
    nora.page.on('websocket', ws => {
      ws.on('framereceived', f => { const p = String(f.payload); if (p.includes('"work-graph"')) stream.push(p); });
      ws.on('framesent', f => { sentFrames.push(String(f.payload)); });
    });
    const section = await openOverview(nora.page);
    // The stream opens from the snapshot's cursor once the gateway connects.
    await expect.poll(() => stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
    const response = await eli.page.request.patch(`/api/graph/work-items/${target!.id}`, { data: { status: 'in_progress' } });
    expect(response.status()).toBe(200);
    restore = { id: target!.id, status: 'open' };
    // Changed today, so it is no longer folded context: its card appears, with
    // the row's own status word, without a reload. (An in-progress item is not a
    // process, so the card's status is `idle`; the badge carries the word.)
    const card = section.getByRole('button', { name: `${target!.title}, idle` });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('In progress');
    // It came as a delta on the stream, and the hint fallback never subscribed.
    expect(stream.some(p => p.includes('"kind":"delta"') && p.includes(target!.id))).toBe(true);
    expect(sentFrames.some(p => p.includes('"orgiq:workgraph"'))).toBe(false);
    await section.screenshot({ path: test.info().outputPath('initiative-activity-live.png') });
    expect(nora.errors).toEqual([]);
  } finally {
    if (restore) await eli.page.request.patch(`/api/graph/work-items/${restore.id}`, { data: { status: restore.status } });
    await nora.context.close(); await eli.context.close();
  }
});

type Wide = { nodes: Array<{ id: string; kind: string; title: string }>; details: Array<{ nodeId: string; participants?: Array<{ id: string; label: string }> }> };
const v2 = (timezone: string, day: string) => { const w = workDayWindow(day, timezone); return { day, timezone, schemaVersion: '2', mode: 'live', windowStart: w.start, windowEnd: w.end }; };
async function zone(page: Page) { return page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone); }

test('a sprint and a decision appear on the activity graph for a budgets-tier viewer', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const rachel = await session(browser, baseURL, 'u-rachel');
  try {
    const timezone = await (async () => { await rachel.page.goto('/iq/projects'); return zone(rachel.page); })();
    // The sprint: on today's initiative overview, named by the API's own sprint row.
    const sprints = (await (await rachel.page.request.get('/api/sprints', { params: { initiative: INITIATIVE, scope: 'all' } })).json()).sprints as Array<{ id: string; name: string; startsOn: string; endsOn: string }>;
    const day = today(timezone);
    const live = sprints.find(sp => sp.startsOn <= day && day <= sp.endsOn);
    expect(live, 'a sprint spanning today').toBeTruthy();
    const section = await openOverview(rachel.page);
    await section.screenshot({ path: test.info().outputPath('overview-sprint.png') });
    await expect(section.getByText(live!.name, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    // The decision: on the day it was escalated, from the decisions route's own row.
    const decisions = await (await rachel.page.request.get(`/api/graph/projects/${INITIATIVE}/decisions`)).json() as Array<{ topic: string; escalatedAt: string | null }>;
    const escalated = decisions.find(d => d.escalatedAt);
    expect(escalated, 'an escalated decision').toBeTruthy();
    const escalatedDay = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(escalated!.escalatedAt!));
    const served = await (await rachel.page.request.get(`/api/work-graph/initiatives/${INITIATIVE}/graph`, { params: { day: escalatedDay, timezone } })).json() as Wide;
    expect(served.nodes.some(n => n.kind === 'change' && n.title === escalated!.topic)).toBe(true);
    await rachel.page.goto(`/iq/activity?initiative=${INITIATIVE}&day=${escalatedDay}`);
    const page = rachel.page.getByTestId('iq-activity');
    await expect(page.getByText(escalated!.topic, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath('activity-decision.png') });
    expect(rachel.errors).toEqual([]);
  } finally { await rachel.context.close(); }
});

test('the person selector narrows the workspace graph to one person’s day', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const rachel = await session(browser, baseURL, 'u-rachel');
  try {
    await rachel.page.goto('/iq/activity');
    const timezone = await zone(rachel.page);
    const day = today(timezone);
    const ws = await (await rachel.page.request.get('/api/work-graph/workspace/graph', { params: v2(timezone, day) })).json() as Wide;
    const worked = ws.nodes.filter(n => n.id.startsWith('work:'));
    const owner = new Map(ws.details.filter(d => d.nodeId.startsWith('work:') && d.participants?.[0]).map(d => [d.nodeId, d.participants![0]!]));
    const person = [...owner.values()][0]!;
    const mine = worked.filter(n => owner.get(n.id)?.id === person.id);
    const others = worked.filter(n => owner.get(n.id)?.id !== person.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(others.length, 'someone else has work in the day').toBeGreaterThan(0);

    const region = rachel.page.getByTestId('iq-activity');
    await expect(region.getByRole('region', { name: 'Shared work graph' }).or(region.locator('section[aria-label="Shared work graph"]')).first()).toBeVisible({ timeout: 20_000 });
    await region.getByTestId('iq-activity-person').selectOption(person.id);
    await expect(rachel.page).toHaveURL(new RegExp(`person=${person.id}`));
    await expect(region.getByText(mine[0]!.title, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    for (const other of others.filter(o => !mine.some(m => m.title === o.title)).slice(0, 3)) await expect(region.getByText(other.title, { exact: true })).toHaveCount(0);
    // The API agrees: the person's graph is a subset of the workspace's.
    const one = await (await rachel.page.request.get(`/api/work-graph/people/${person.id}/graph`, { params: v2(timezone, day) })).json() as Wide;
    expect(one.nodes.filter(n => n.id.startsWith('work:')).map(n => n.id).sort()).toEqual(mine.map(n => n.id).sort());
    await region.screenshot({ path: test.info().outputPath('activity-person.png') });
    expect(rachel.errors).toEqual([]);
  } finally { await rachel.context.close(); }
});

// 6/7 (slice 3) A sprint move and an own flow run's status change reach an open
// graph as this viewer's own stream deltas — no reload, no hint-channel fallback.
async function openWithStream(page: Page) {
  const stream: string[] = [];
  const sentFrames: string[] = [];
  page.on('websocket', ws => {
    ws.on('framereceived', f => { const p = String(f.payload); if (p.includes('"work-graph"')) stream.push(p); });
    ws.on('framesent', f => { sentFrames.push(String(f.payload)); });
  });
  const section = await openOverview(page);
  await expect.poll(() => stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
  return { section, stream, sentFrames };
}

test('a live sprint move arrives as a stream delta', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const rachel = await session(browser, baseURL, 'u-rachel');
  const eli = await session(browser, baseURL, 'u-rachel'); // a second org-leader session moves the item
  let restore: { sprintId: string; itemId: string } | null = null;
  try {
    await rachel.page.goto('/iq/projects');
    const timezone = await zone(rachel.page);
    const day = today(timezone);
    const sprints = (await (await rachel.page.request.get('/api/sprints', { params: { initiative: INITIATIVE, scope: 'all' } })).json()).sprints as Array<{ id: string; name: string; startsOn: string; endsOn: string; itemCount: number }>;
    const live = sprints.find(sp => sp.startsOn <= day && day <= sp.endsOn);
    expect(live, 'a sprint spanning today').toBeTruthy();
    const tree = await (await eli.page.request.get(`/api/graph/projects/${INITIATIVE}/work`)).json() as Array<{ id: string; sprintId?: string | null; children: unknown[] }>;
    const flat: Array<{ id: string; sprintId?: string | null }> = [];
    const walk = (rows: Array<{ id: string; sprintId?: string | null; children: unknown[] }>) => { for (const r of rows) { flat.push(r); walk(r.children as never); } };
    walk(tree);
    const target = flat.find(i => i.sprintId !== live!.id);
    expect(target, 'an item outside the sprint').toBeTruthy();
    const { section, stream, sentFrames } = await openWithStream(rachel.page);
    const before = stream.length;
    const moved = await eli.page.request.patch(`/api/sprints/${live!.id}/items`, { data: { workItemId: target!.id } });
    expect(moved.status()).toBe(200);
    restore = { sprintId: live!.id, itemId: target!.id };
    // The sprint card's own rollup changes as a delta on the open socket.
    await expect.poll(() => stream.slice(before).some(p => p.includes('"kind":"delta"') && p.includes(`sprint:${live!.id}`)), { timeout: 20_000 }).toBe(true);
    await expect(section.getByText(live!.name, { exact: true }).first()).toBeVisible();
    expect(sentFrames.some(p => p.includes('"orgiq:workgraph"'))).toBe(false);
    expect(rachel.errors).toEqual([]);
  } finally {
    if (restore) await eli.page.request.delete(`/api/sprints/${restore.sprintId}/items/${restore.itemId}`);
    await rachel.context.close(); await eli.context.close();
  }
});

test('an own flow run’s status change arrives as a stream delta', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const nora = await session(browser, baseURL, 'u-nora');
  try {
    const { section, stream, sentFrames } = await openWithStream(nora.page);
    const before = stream.length;
    const started = await nora.page.request.post('/api/conversations/summarize/run', { data: { channel: `orgiq:initiative:${INITIATIVE}` } });
    expect(started.status()).toBe(202);
    const { runId } = await started.json() as { runId: string };
    await expect.poll(() => stream.slice(before).some(p => p.includes('"kind":"delta"') && p.includes(`flow:${runId}`)), { timeout: 30_000 }).toBe(true);
    await expect(section.getByText('Conversation summary', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    // The run finishes: a later delta carries the completed state, still without the fallback.
    await expect.poll(async () => (await (await nora.page.request.get(`/api/conversations/summarize/runs/${runId}`)).json()).phase, { timeout: 60_000 }).toMatch(/done|ready|complete/i);
    await expect.poll(() => stream.slice(before).filter(p => p.includes('"kind":"delta"') && p.includes(`flow:${runId}`)).length, { timeout: 20_000 }).toBeGreaterThan(1);
    expect(sentFrames.some(p => p.includes('"orgiq:workgraph"'))).toBe(false);
    expect(nora.errors).toEqual([]);
  } finally { await nora.context.close(); }
});
