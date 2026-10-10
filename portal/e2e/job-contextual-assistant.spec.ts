import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 }, actionTimeout: 5000 });

test('computer job keeps questions, progress and source work in context', async ({ page }) => {
  const principal = await signIn(page, 'u-layla', { expectTenant: 'orgiq', expectRole: 'sme' });
  const jobId = 'job-owned-context-fixture';
  const job = { id: jobId, kind: 'computer', title: 'Review duplicate-alert validation', status: 'done', priority: 1,
    payload: { prompt: 'Review the dependency-map validation checklist.', workItemId: 'wi-obs-e2-b4', workItemTitle: 'Stop duplicate alerts during a dependency outage', initiativeId: 'p-observability', initiativeName: 'Observability Platform' },
    boxId: 'owned-worker-fixture', sessionId: null, attempts: 1, maxAttempts: 1,
    result: { summary: 'The checklist is ready for review.', transcript: [] }, error: null,
    createdBy: 'u-layla', createdAt: '2026-10-09T22:00:00.000Z', claimedAt: null, startedAt: null, finishedAt: '2026-10-09T22:01:00.000Z',
    botId: null, botName: null, botTrigger: null };
  // One rendering fixture, never persisted or dispatched. Session, capability
  // and the read-only supervisor route remain the real configured local APIs.
  await page.route(`**/api/work/jobs/${jobId}`, route => route.request().method() === 'GET'
    ? route.fulfill({ json: job }) : route.abort());
  const writes: string[] = [], errors: string[] = [], questions: Record<string, unknown>[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/agents/orgiq-supervisor/invoke') questions.push(request.postDataJSON());
    else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path.startsWith('/api/')) writes.push(`${request.method()} ${path}`);
  });
  await page.goto(`/iq/work/${jobId}`);
  await expect(page.getByTestId('run-detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open computer' })).toBeVisible();
  const composer = page.getByTestId('job-conversation');
  await expect(composer).toHaveCount(1);
  const editor = composer.locator('[contenteditable="true"]');
  await editor.fill('Explain the next validation step without changing the job.');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  const panel = page.getByTestId('initiative-agent-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Complete', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(new RegExp(`/iq/work/${jobId}(?:\\?|$)`));
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({ selection: { records: [{ type: 'initiative', id: 'p-observability' }, { type: 'work', id: 'wi-obs-e2-b4' }] } });
  expect(String(questions[0].message)).toContain('Run snapshot at submission:');
  expect(String(questions[0].message)).toContain('The checklist is ready for review.');
  await page.screenshot({ path: test.info().outputPath('job-assistant-wide.png') });
  await page.getByRole('button', { name: 'Collapse run assistant' }).click();
  await editor.fill('This unsent job question stays while resizing.');
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(editor).toContainText('This unsent job question stays while resizing.');
  await expect(composer).toHaveCount(1);
  const sendBounds = await composer.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  expect(sendBounds).not.toBeNull();
  expect(sendBounds!.y + sendBounds!.height).toBeLessThan(722);
  await page.screenshot({ path: test.info().outputPath('job-assistant-narrow.png') });
  await page.getByRole('button', { name: 'Open work item' }).click();
  await expect(page).toHaveURL(/\/iq\/projects\/p-observability\?tab=work&item=wi-obs-e2-b4/);
  await expect(page.getByTestId('work-item-detail')).toBeVisible();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('verification.json'), JSON.stringify({ principal, jobData: 'Nonpersisted GET rendering fixture',
    actualReadOnlySupervisor: true, questions, writes, errors, routeRetainedDuringQuestion: true, workItemNavigation: true,
    noJobsDispatchedOrMessagesSent: true }, null, 2));
});
