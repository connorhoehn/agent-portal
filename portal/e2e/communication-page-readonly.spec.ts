import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 }, actionTimeout: 5_000, navigationTimeout: 10_000 });

test('current initiative owner can view Work Communication without mutating its discussion', async ({ page }) => {
  const principal = await signIn(page, 'u-nora', { expectTenant: 'orgiq' });
  const errors: string[] = [], authoredWrites: string[] = [], failedReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Maximum update depth exceeded/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && /\/(?:messages|channels|revisions|revise|bind|join|start|transcribe|reprocess)(?:\/|$)/.test(path)) authoredWrites.push(`${request.method()} ${path}`);
  });
  page.on('response', response => { if (response.status() >= 400 && /\/api\//.test(new URL(response.url()).pathname)) failedReads.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto('/iq/communication?group=initiative:p-observability');
  const group = page.getByTestId('plane-group-pane');
  await expect(group).toBeVisible();
  await expect(page.getByTestId('plane-group-header')).toContainText('Observability Platform');
  await expect(page.getByTestId('scope-discussion-panel')).toBeVisible();
  const footer = page.getByTestId('shell-footer-context');
  await expect(footer).toContainText('Observability Platform');
  const message = footer.getByRole('button', { name: 'Message', exact: true });
  await expect(message).toBeEnabled(); await message.click();
  const editor = page.getByTestId('scope-discussion-panel').getByRole('textbox', { name: 'Message', exact: true });
  await expect(editor).toBeFocused();
  const draft = 'An unsent discussion draft remains while the workspace resizes.';
  await editor.fill(draft);
  const measure = () => page.evaluate(() => {
    const boxes = Object.fromEntries(['communication-page', 'social-chat-workspace', 'social-chat-rail', 'communication-content', 'plane-group-pane', 'plane-group-header', 'scope-discussion-panel'].map(id => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      const rect = element?.getBoundingClientRect();
      return [id, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null];
    }));
    return { boxes, alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(element => (element.textContent ?? '').trim()).filter(Boolean),
      editors: [...document.querySelectorAll('[contenteditable="true"]')].map(element => ({ label: element.getAttribute('aria-label'), text: element.textContent, rect: element.getBoundingClientRect().toJSON() })) };
  });
  const wide = await measure();
  expect(wide.editors).toHaveLength(1);
  expect(wide.editors[0].rect.bottom).toBeGreaterThan(wide.boxes['scope-discussion-panel']!.y + wide.boxes['scope-discussion-panel']!.height - 160);
  await page.screenshot({ path: test.info().outputPath('communication-current-wide.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(group).toBeVisible();
  await expect(editor).toHaveText(draft);
  const narrow = await measure();
  expect(narrow.editors).toHaveLength(1);
  expect(narrow.editors[0].rect.bottom).toBeGreaterThan(narrow.boxes['scope-discussion-panel']!.y + narrow.boxes['scope-discussion-panel']!.height - 160);
  await page.screenshot({ path: test.info().outputPath('communication-current-narrow.png') });
  expect(authoredWrites).toEqual([]); expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('communication-current.json'), JSON.stringify({ principal: { sub: principal.sub, tenant: principal.tenant, role: principal.role }, wide, narrow, failedReads, authoredWrites, errors, noRoleTenantSwitches: true }, null, 2));
});
