import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 }, actionTimeout: 5000 });

// Preparation must preserve the work context without starting a job or a call.
// Both actors use their existing home grants; this never switches their role.
for (const actor of [{ id: 'u-layla', role: 'sme' }, { id: 'u-vera', role: 'member' }]) {
  test(`computer-job preparation keeps work context and ${actor.role} authority`, async ({ page }) => {
    const principal = await signIn(page, actor.id, { expectTenant: 'orgiq', expectRole: actor.role });
    const errors: string[] = [], writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path.startsWith('/api/')) writes.push(`${request.method()} ${path}`);
    });
    await page.goto('/iq/projects/p-observability?tab=work&item=wi-obs-e2-b4');
    const detail = page.getByTestId('work-item-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Stop duplicate alerts during a dependency outage', exact: true })).toBeVisible();
    await detail.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(detail.locator('.work-item-metadata').getByTestId('work-item-prepare-job')).toHaveCount(0);
    await detail.getByTestId('initiative-header-menu-trigger').click();
    const prepare = page.getByTestId('work-item-prepare-job');
    await expect(prepare).toHaveAccessibleName(actor.role === 'sme' ? 'Prepare job' : 'View job setup');
    await prepare.click();
    // No form on the page: the job is a deck in the docked composer (ComposerPromptDeck).
    await expect(detail.getByTestId('run-setup')).toHaveCount(0);
    const deck = page.getByTestId('initiative-composer-prompts');
    await expect(deck).toHaveAttribute('data-composer-prompt-deck', 'expanded');
    const card = deck.getByTestId('initiative-composer-prompts-card');
    await expect(card).toContainText(actor.role === 'member' ? 'The job this item would run with.' : 'Dispatch with these settings?');
    await expect(deck.getByTestId('initiative-composer-prompts-fields')).toContainText('Model');
    await expect(page.getByTestId('initiative-composer')).toHaveCount(1);
    if (actor.role === 'member') {
      await expect(deck.getByTestId('initiative-composer-prompts-read-only')).toContainText('authorizes jobs');
      await expect(deck.getByTestId('initiative-composer-prompts-option-dispatch')).toHaveCount(0);
    } else {
      await expect(deck.getByTestId('initiative-composer-prompts-option-dispatch')).toBeVisible();
    }
    await expect(page).toHaveURL(/item=wi-obs-e2-b4/);
    await page.screenshot({ path: test.info().outputPath(`${actor.role}-job-setup-wide.png`) });
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(deck).toBeVisible();
    await expect(page.getByTestId('initiative-composer')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath(`${actor.role}-job-setup-narrow.png`) });
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    await writeFile(test.info().outputPath('job-preparation-proof.json'), JSON.stringify({ principal,
      selectedWorkItem: 'wi-obs-e2-b4', writes, errors,
      scope: 'Actual home-role sessions; open job preparation from Activity without dispatch, message, invitation, call, reset or role switch.' }, null, 2));
  });
}
