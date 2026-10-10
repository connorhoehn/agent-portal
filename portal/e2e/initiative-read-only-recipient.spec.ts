import { test, expect } from './cdpTest';
import { signIn } from './realSession';

// Real member authority; no world reset, posted message, call, or role switch.
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://localhost:5183', viewport: { width: 1440, height: 900 } });

test('a readable initiative keeps its disabled posting destination instead of silently selecting a DM', async ({ page }) => {
  await page.goto('/');
  await signIn(page, 'u-theo', { expectTenant: 'orgiq', expectRole: 'member' });
  await page.goto('/iq/projects/p-observability?tab=work&item=wi-obs-e2-b4');
  await expect(page.getByTestId('scope-discussion-panel-read-only')).toContainText('You can read and filter messages.');
  const dock = page.getByTestId('initiative-composer');
  const mode = dock.getByRole('button', { name: /^Composer mode:/ });
  await mode.click();
  await page.getByRole('menuitem', { name: 'Chat', exact: true }).click();
  await expect(dock.getByRole('button', { name: 'Choose chat destination', exact: true })).toContainText('Initiative');
  await expect(dock.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(dock.getByRole('button', { name: /^Send/ })).toBeDisabled();
  await expect(dock).toContainText('Your current role cannot post to this discussion.');
  await expect(dock.locator('[data-placeholder*="Message Asha"]')).toHaveCount(0);

  // A person destination is available only after an explicit choice.
  await dock.getByRole('button', { name: 'Choose chat destination', exact: true }).click();
  const target = page.getByRole('menuitem', { name: 'Asha Nair', exact: true });
  await expect(target).toBeEnabled();
  await target.click();
  await expect(dock.getByRole('button', { name: 'Choose chat destination', exact: true })).toContainText('Asha Nair');
  await expect(dock.locator('[contenteditable="true"]')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('initiative-member-explicit-recipient.png') });
});
