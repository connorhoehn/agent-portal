import { test, expect } from '@playwright/test';
import { signIn } from './realSession';

// `/doc` in the assessment document conversation (docs/agentic-flows-migration.md slice 12):
// the private page card, then "Save as document" creates a draft through the tenant's own
// create route (ManageKnowledge) and the server resolves that id against the actor's current
// document authority before claiming the run. Needs the gateway stack (:3001 realtime on,
// platform-api up); skips otherwise. Leaves the created draft in place (no reset: the app is shared).
test.use({ viewport: { width: 1672, height: 941 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

const DOC = 'page:100002';

test('/doc Save in the assessment document conversation creates a draft the server can read back', async ({ page, request }) => {
  test.setTimeout(90_000);
  const health = await request.get('/api/health').then(r => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
  test.skip(health?.realtime?.gateway !== 'on', 'the middleware is unreachable or REALTIME_GATEWAY is not on');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await signIn(page, 'u-farah');
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
  await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId('document-chat-panel');
  if (!(await panel.isVisible())) await page.getByTestId('context-column-panel-chat').click();
  await expect(panel).toBeVisible();
  const input = panel.getByTestId('document-chat-composer-input');
  await expect(input).toBeEditable({ timeout: 20_000 });
  // The page is written from the readable thread, so the thread needs a line (the draft stays; chat has no delete here).
  await input.click();
  await page.keyboard.type('We agreed the E2E runbook covers the cutover and the rollback steps.');
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('chat-message').filter({ hasText: 'E2E runbook covers' }).first()).toBeVisible({ timeout: 15_000 });
  await input.click();
  await page.keyboard.type('/doc E2E Runbook');
  await page.keyboard.press('Enter');

  const card = panel.getByTestId('conversation-doc-card');
  await expect(card.getByTestId('conversation-doc-preview')).toBeVisible({ timeout: 30_000 });
  // Since ui-components 2.413.0 the private note is the library's, beside the card.
  await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Only you can see this');
  const created = page.waitForResponse(r => r.url().includes('/knowledge/doc/create') && r.request().method() === 'POST');
  const saved = page.waitForResponse(r => /\/doc\/runs\/[^/]+\/save$/.test(r.url()) && r.request().method() === 'POST');
  await card.getByTestId('conversation-doc-save').click();
  const { id } = await (await created).json() as { id: string };
  expect((await saved).status()).toBe(200);
  expect(id).toMatch(/^draft:/);
  await expect(panel.getByTestId('conversation-doc-card')).toHaveCount(0, { timeout: 25_000 });
  // The reference message lands in the open document's thread, and the saved page is readable.
  await expect(panel.getByTestId('chat-message').filter({ hasText: 'E2E Runbook' }).first()).toBeVisible({ timeout: 15_000 });
  const doc = await page.evaluate(async (docId) => (await fetch(`/api/assessment/knowledge/doc?id=${encodeURIComponent(docId)}`, { credentials: 'include' })).json(), id) as { markdown?: string; title?: string };
  expect(doc.title).toBe('E2E Runbook');
  expect(doc.markdown ?? '').toContain('E2E Runbook');
  expect(errors).toEqual([]);
});
