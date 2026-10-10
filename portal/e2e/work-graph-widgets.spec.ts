import { test, expect, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// Every mount of the work graph (components/work-graph/WorkGraphActivity.tsx)
// carries the same header widgets, through ui-components' own slots
// (WorkActivityPresentation title / subtitle / kindLegend, 2.438.2):
//
//   - the header names the subject and the day (the caption: "<scope> · <day> · <live>");
//   - the kinds legend lists every node kind in the snapshot with its count, and
//     the counts strip matches the snapshot's node and edge counts;
//   - clicking a card opens the library inspector with its title and its
//     "<Kind> · <Status>" line;
//   - the header is one row and the time window's control row is one line.
//
// Real BFF, real sessions, on the shared dev:mock stack; nothing is reset.
test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });
test.describe.configure({ mode: 'serial' });

type Node = { id: string; kind: string; title: string; status: string };
type Snapshot = { nodes: Node[]; edges: unknown[] };

const KIND_LABELS: Record<string, string> = {
  project: 'Project', task: 'Task', run: 'Run', agent: 'Agent', change: 'Change',
  document: 'Document', conversation: 'Conversation', meeting: 'Meeting', transcript: 'Transcript', terminal: 'Terminal',
};
const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle', running: 'Running', waiting: 'Waiting', completed: 'Completed', error: 'Failed', stopped: 'Stopped', stale: 'Stale',
};

interface Mount {
  name: string;
  user: string;
  tenant: string;
  /** The page's own route, or a function that reaches it. */
  open: (page: Page) => Promise<void>;
  /** The snapshot request this mount makes. */
  snapshot: RegExp;
  /** The subject as the header must name it. */
  title: RegExp;
  scope: string;
}

async function firstRunId(page: Page): Promise<string> {
  const body = await (await page.request.get('/api/pipelines/runs')).json();
  const runs = (body.runs ?? body) as Array<{ id: string }>;
  expect(runs.length, 'a pipelines run to open').toBeGreaterThan(0);
  return runs[0]!.id;
}

const MOUNTS: Mount[] = [
  { name: '/assessment/activity', user: 'u-asha', tenant: 'assessment', open: p => p.goto('/assessment/activity').then(() => undefined),
    snapshot: /\/api\/assessment\/work-graph\/workspace\/graph/, title: /^All assessments$/, scope: 'Work graph' },
  { name: 'scorecard Activity tab', user: 'u-asha', tenant: 'assessment', open: p => p.goto('/assessment/teams/TEAM-001?tab=activity').then(() => undefined),
    snapshot: /\/api\/assessment\/work-graph\/teams\/TEAM-001\/graph/, title: /\S/, scope: 'Assessment team' },
  { name: '/pipelines/activity', user: 'u-ines', tenant: 'pipelines', open: p => p.goto('/pipelines/activity').then(() => undefined),
    snapshot: /\/api\/pipelines\/work-graph\/workspace\/graph/, title: /^All pipeline runs$/, scope: 'Work graph' },
  { name: 'pipelines run Activity tab', user: 'u-ines', tenant: 'pipelines',
    open: async p => { await p.goto(`/pipelines/runs/${encodeURIComponent(await firstRunId(p))}?tab=activity`); },
    snapshot: /\/api\/pipelines\/work-graph\/runs\//, title: /\S/, scope: 'Pipeline run' },
  { name: 'initiative Activity tab', user: 'u-rachel', tenant: 'orgiq', open: p => p.goto('/iq/projects/p-auth-migration?tab=activity').then(() => undefined),
    snapshot: /\/api\/work-graph\/initiatives\/p-auth-migration\/graph/, title: /^Auth Migration$/, scope: 'Initiative' },
  { name: '/iq/communication shared work', user: 'u-vera', tenant: 'orgiq',
    open: async p => { await p.goto('/iq/communication'); await p.getByTestId('communication-my-work').click({ timeout: 20_000 }); },
    snapshot: /\/api\/social\/plane\/people\/u-vera\/shared-work/, title: /^Your work today$/, scope: 'Shared work' },
  { name: 'Social ?view=graph', user: 'u-mira', tenant: 'social', open: p => p.goto('/social/channels/general?view=graph').then(() => undefined),
    snapshot: /\/api\/social\/work-graph\/conversations\/.*\/graph/, title: /general/, scope: 'Conversation' },
];

async function session(browser: Browser, baseURL: string | undefined, userId: string, tenant: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  await loginAs(context, userId, baseURL, true);
  if (tenant !== 'orgiq') expect((await context.request.post('/api/session/tenant', { data: { tenant } })).status()).toBe(200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return { context, page, errors };
}

function readSnapshot(body: unknown): Snapshot {
  const value = body as { nodes?: Node[]; edges?: unknown[]; snapshot?: { nodes: Node[]; edges: unknown[] } };
  const snap = value.snapshot ?? value;
  return { nodes: snap.nodes ?? [], edges: snap.edges ?? [] };
}

for (const mount of MOUNTS) {
  test(`work graph widgets: ${mount.name}`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const { context, page, errors } = await session(browser, baseURL, mount.user, mount.tenant);
    const reply = page.waitForResponse(r => mount.snapshot.test(new URL(r.url()).pathname) && r.request().method() === 'GET' && r.status() === 200, { timeout: 30_000 });
    await mount.open(page);
    const snapshot = readSnapshot(await (await reply).json());
    expect(snapshot.nodes.length, 'the snapshot has work to draw').toBeGreaterThan(0);

    const graph = page.getByRole('region', { name: 'Shared work graph' }).first();
    await expect(graph).toBeVisible({ timeout: 30_000 });
    const header = graph.getByTestId('work-activity-header').first();
    await expect(header).toBeVisible();

    // The caption names the subject and the day.
    const { day, label } = await page.evaluate(() => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const label = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${day}T12:00:00Z`));
      return { day, label };
    });
    await expect(header.getByTestId('work-activity-header-title')).toHaveText(mount.title);
    const subtitle = header.getByTestId('work-activity-header-subtitle');
    await expect(subtitle).toContainText(`${mount.scope} · Today, ${label}`);
    await expect(subtitle).toContainText(/Live|Not live/);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The legend lists every kind in the snapshot, with its count.
    const legend = header.getByTestId('work-kind-legend');
    const kinds = new Map<string, number>();
    for (const n of snapshot.nodes) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
    await expect.poll(async () => legend.getByTestId('work-kind-legend-kind').evaluateAll(items =>
      items.map(i => `${i.getAttribute('data-kind')}:${i.getAttribute('data-count')}`).sort()), { timeout: 10_000 })
      .toEqual([...kinds].map(([k, c]) => `${k}:${c}`).sort());
    for (const kind of kinds.keys()) {
      await expect(legend.locator(`[data-kind="${kind}"]`)).toHaveAttribute('aria-label', new RegExp(`${KIND_LABELS[kind]}$`));
    }
    // The counts strip matches the snapshot.
    const counts = legend.getByTestId('work-kind-legend-counts');
    await expect(counts).toHaveAttribute('data-nodes', String(snapshot.nodes.length));
    await expect(counts).toHaveAttribute('data-edges', String(snapshot.edges.length));
    await expect(counts).toHaveText(new RegExp(`^${snapshot.nodes.length} items? · ${snapshot.edges.length} links?$`));

    // One header row; the time window's controls on one line.
    const bar = await header.boundingBox();
    expect(bar!.height, 'header title row is one row').toBeLessThanOrEqual(52);
    const controls = graph.getByLabel('Work time window').locator('> div').first();
    const row = await controls.boundingBox();
    expect(row!.height, 'time window controls on one line').toBeLessThanOrEqual(36);
    const follow = await graph.getByRole('button', { name: /Following now|Back to now/ }).boundingBox();
    const range = await graph.getByRole('combobox', { name: 'Interval duration' }).boundingBox();
    expect(Math.abs(follow!.y + follow!.height / 2 - (range!.y + range!.height / 2)), 'follow and range share the row').toBeLessThanOrEqual(4);

    // Clicking a card opens the inspector with its title and kind/status.
    const card = graph.locator('.react-flow__node:has(header span[title])').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const cardTitle = (await card.locator('header span[title]').first().getAttribute('title'))!;
    await card.locator('header').first().click();
    const inspector = graph.getByTestId('activity-inspector');
    await expect(inspector).toBeVisible({ timeout: 10_000 });
    await expect(inspector.getByTestId('activity-inspector-title')).toHaveText(cardTitle);
    const node = snapshot.nodes.find(n => n.title === cardTitle);
    expect(node, `the clicked card "${cardTitle}" is a snapshot node`).toBeTruthy();
    await expect(inspector.getByTestId('activity-inspector-subtitle')).toContainText(`${KIND_LABELS[node!.kind]} · ${STATUS_LABELS[node!.status]}`);

    expect(errors, 'page errors').toEqual([]);
    await context.close();
  });
}
