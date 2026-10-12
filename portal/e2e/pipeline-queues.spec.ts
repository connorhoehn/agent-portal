import { test, expect } from '@playwright/test';
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5263', viewport: { width: 1440, height: 1000 } });
const queues = [
  { name: 'distill-compact-l1', purpose: 'L0 → L1 compaction', deadLetter: false, redriveTo: 'distill-compact-l1-dlq', maxReceives: 3, state: 'available', reason: null, snapshot: { ready: 7, inFlight: 2, delayed: 0, visibilityTimeoutSeconds: 60, fifo: null } },
  { name: 'distill-compact-l1-dlq', purpose: 'Failed distillation deliveries', deadLetter: true, redriveTo: null, maxReceives: null, state: 'available', reason: null, snapshot: { ready: 3, inFlight: 0, delayed: 0, visibilityTimeoutSeconds: 60, fifo: null } },
  { name: 'distill-compact-l2', purpose: 'L1 → L2 compaction', deadLetter: false, redriveTo: 'distill-compact-l2-dlq', maxReceives: 3, state: 'unavailable', reason: 'Queue service refused the metadata read.', snapshot: null },
];

test('metadata-only queue view keeps partial failures visible and transport distinct from realtime', async ({ page }) => {
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  let backend = 'http';
  await page.route('**/api/**', route => route.request().url().endsWith('/api/pipelines/queues') ? route.fulfill({ json: { backend, observedAt: '2026-10-10T14:00:00Z', queues } }) : route.abort());
  await page.route('**/__pipeline-queues', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/pipeline-queues.tsx"></script></body></html>` }));
  await page.goto('/__pipeline-queues');
  const root = page.getByTestId('pipelines-queues');
  await expect(root.getByText('Message-queue service', { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'About queue delivery' }).click();
  await expect(root.getByText('Realtime disconnected', { exact: true })).toBeVisible();
  await expect(root.getByText('Unavailable', { exact: true })).toBeVisible();
  await root.getByText('distill-compact-l2', { exact: true }).click();
  await expect(page.getByTestId('pipeline-queue-details')).toContainText('Queue service refused the metadata read.');
  await root.getByText('distill-compact-l1', { exact: true }).click();
  await expect(page.getByTestId('pipeline-queue-details')).toContainText('Not reported by service');
  await page.screenshot({ path: test.info().outputPath('queue-metadata-desktop.png') });
  await root.getByRole('textbox', { name: 'Search queues' }).fill('l1-dlq');
  await expect(root.getByTestId('pipeline-queues-table').getByText('distill-compact-l2', { exact: true })).toHaveCount(0);
  backend = 'memory';
  await root.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(root.getByText('Their messages do not survive a restart.', { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 960, height: 768 });
  await page.screenshot({ path: test.info().outputPath('queue-metadata-narrow.png') });
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
