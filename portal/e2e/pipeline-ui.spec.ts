import { test, expect, type Page } from '@playwright/test';
import type { PipelineRun } from '../src/lib/pipelineRuns';
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5283' });
const definitions = Array.from({ length: 28 }, (_, i) => ({
  id: `runbook:owned-${i}`, tenant: 'pipelines', contextTenant: 'orgiq', kind: 'runbook', title: `Release readiness ${String(i + 1).padStart(2, '0')}`,
  description: 'Check the release before promotion.', owner: 'Release team', version: 2, source: { table: 'runbooks', id: `owned-${i}` },
  steps: [{ id: 'check', label: 'Review release' }], triggers: [{ type: 'manual', detail: 'Started by a reviewer' }], approverRoles: [], effectiveApproverRoles: ['operator'],
  approversDefaulted: true, enabled: true, recorded: true, orphaned: false, meta: { model: 'Codex', status: 'healthy', tools: [] }, runCount: 3, lastRun: null,
}));
const runs: PipelineRun[] = definitions.map((d, i) => ({ id: `run-${i}`, definitionId: d.id, context: { title: d.title, kind: 'runbook', tenant: 'orgiq', trigger: 'manual', table: 'agent_jobs', id: 'owned', sourceStatus: 'running', sources: [] },
  tenant: 'pipelines', triggeredBy: 'owned-ui-reader', finishedAt: null, status: 'running', triggerType: 'manual', costUsd: 0.02, startedAt: '2026-10-12T13:00:00Z' }));
const approval = { id: 'approval-one', source: 'agent_jobs', title: 'Review release', question: 'Is this release ready?', requiredRoles: ['operator'], rolesDefaulted: true,
  runId: 'run-0', definitionId: definitions[0].id, stepId: 'check', decidedThrough: 'Job review', requestedAt: '2026-10-12T13:00:00Z' };
const pages = ['definitions', 'runs', 'approvals', 'artifacts', 'runbooks', 'queues', 'agents', 'bots', 'commands', 'configuration', 'activity'];
async function prepare(page: Page, theme: string, role = 'pipeline-admin') {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(theme => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; }); }, theme);
  // Use the actual page compositions; media is inactive and all HTTP authority/data is isolated.
  await page.route('**/pipelines/**', route => route.request().resourceType() === 'document' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/pipeline-ui.tsx"></script></body></html>' }) : route.fallback());
  await page.route('**/api/**', route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (req.method() !== 'GET') writes.push(`${req.method()} ${path}`);
    let json: unknown = {};
    if (path === '/api/session/me') json = { sub: 'owned-ui-reader', name: 'UI Reviewer', tenant: 'pipelines', role, grants: { pipelines: [role] }, availableTenants: ['pipelines'], availableRoles: [role] };
    else if (path === '/api/session/capabilities') json = { role, tenant: 'pipelines', degraded: false, actions: { ViewPipelines: true, RunPipeline: true, AuthorDefinition: true, CancelRun: role !== 'author', ApproveStep: role !== 'author', ManagePipelineConfig: role === 'pipeline-admin' } };
    else if (path === '/api/pipelines/definitions') json = { definitions, unavailable: [], total: definitions.length, defaultApproverRole: 'operator' };
    else if (path.startsWith('/api/pipelines/definitions/')) json = { definition: definitions[0], runs: [], dryRuns: [], approverRoleOptions: ['operator', 'pipeline-admin'] };
    else if (path === '/api/pipelines/runs') json = { runs, unavailable: [], unlinked: {}, total: runs.length };
    else if (path === '/api/pipelines/approvals') json = { approvals: [approval], unavailable: [], total: 1 };
    else if (path === '/api/pipelines/artifacts') json = { artifacts: definitions.map((d, i) => ({ id: `artifact-${i}`, kind: 'document', title: d.title, runId: `run-${i}`, runStatus: 'completed', contextTenant: 'orgiq' })), unavailable: [], total: 28 };
    else if (path === '/api/pipelines/runbooks') json = { runbooks: [{ ...definitions[0], runbook: { candidateId: 'owned', proposedKind: 'RUNBOOK', dryRunCount: 0, lastDryRun: null, promotionToSkill: { ok: false, reason: 'No completed dry-run' } } }], unavailable: [], total: 1 };
    else if (path === '/api/pipelines/configuration') json = { defaultApproverRole: 'operator', updatedBy: 'UI Reviewer', approverRoleOptions: ['operator', 'pipeline-admin'] };
    else if (path === '/api/pipelines/queues') json = { backend: 'http', observedAt: '2026-10-12T13:00:00Z', queues: [{ name: 'release-review', purpose: 'Review queued releases', state: 'available', snapshot: { ready: 3, inFlight: 1, delayed: 0 } }] };
    else if (path === '/api/pipelines/runs/run-0') json = { run: runs[0], artifacts: [] };
    else if (path.endsWith('/steps')) json = { steps: [] };
    else if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: '' });
    else if (path.endsWith('/decks')) return route.fulfill({ status: 503, json: { error: 'Owned unavailable report fixture' } });
    else if (path.includes('/work-graph/')) json = { nodes: [], edges: [], revision: 0, participants: [] };
    else if (path === '/api/people/shared') json = { people: [], me: null };
    else return route.fulfill({ status: 503, json: { error: 'Unconfigured isolated fixture' } });
    return route.fulfill({ json });
  });
  return { errors, writes };
}
for (const theme of ['light', 'dark']) for (const width of [1280, 480]) {
  test(`${theme} ${width}: tenant headers, toolbars and tables remain consistent`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const { errors, writes } = await prepare(page, theme);
    for (const route of pages) {
      await page.goto('/pipelines/' + route);
      const header = page.getByTestId('page-header');
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute('data-density', 'compact');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect(await header.locator('h1').evaluate(el => getComputedStyle(el).fontSize)).toBe('14px');
      const toolbar = page.getByRole('toolbar');
      if (route !== 'activity' && route !== 'configuration') {
        await expect(toolbar).toHaveCount(1);
        const refresh = toolbar.getByRole('button', { name: 'Refresh', exact: true });
        await expect(refresh).toBeVisible(); await expect(refresh).toBeEnabled();
        expect(await refresh.textContent()).toBe('');
        await refresh.focus(); await expect(page.getByRole('tooltip').filter({ hasText: 'Refresh' })).toBeVisible();
      }
      await page.screenshot({ path: test.info().outputPath(`${route}.png`) });
    }
    expect(errors).toEqual([]); expect(writes).toEqual([]);
  });
}
test('search, keyboard pagination, folded back navigation and permission-sensitive actions', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const { errors, writes } = await prepare(page, 'dark');
  await page.goto('/pipelines/definitions');
  await page.getByRole('button', { name: 'Next page', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('datatable-page-summary')).toHaveText('Page 2 of 2 · 28 total');
  await page.getByRole('textbox', { name: 'Search definitions' }).fill('readiness 01');
  await expect(page.getByTestId('pipelines-definitions-table').locator('tbody tr')).toHaveCount(1);
  await page.getByText('Release readiness 01', { exact: true }).click();
  await expect(page.getByTestId('pipelines-definition-drawer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry-run', exact: true })).toBeVisible();
  await page.goto('/pipelines/runs/run-0');
  const header = page.getByTestId('page-header'); await expect(header).toBeVisible();
  const before = await header.boundingBox();
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
  await expect(page.getByTestId('pipeline-run-decks')).toContainText('Report decks could not be loaded');
  await expect(page.getByTestId('pipeline-run-decks')).not.toContainText('No report decks yet');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  const after = await header.boundingBox(); expect(after?.height).toBe(before?.height);
  await header.getByRole('button', { name: 'Collapse header' }).click();
  await header.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/runs$/);
  await test.info().attach('pipeline-ui-cdp-metrics', { body: JSON.stringify(await cdp.send('Performance.getMetrics')), contentType: 'application/json' });
  await cdp.detach();
  expect(errors).toEqual([]); expect(writes).toEqual([]);
});
test('authors can inspect approvals but cannot approve or cancel', async ({ page }) => {
  const { errors, writes } = await prepare(page, 'light', 'author');
  await page.goto('/pipelines/approvals'); await page.getByText('Review release', { exact: true }).click();
  await expect(page.getByTestId('pipelines-approval-drawer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await page.goto('/pipelines/runs/run-0');
  await expect(page.getByTestId('pipeline-run')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]); expect(writes).toEqual([]);
});
