import { test, expect } from '@playwright/test';

test('Search keeps its session menu beside a restored conversation and starts a new search', async ({ page }) => {
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [
    { sessionId: 'stacked-session', actorId: 'me', createdAt: '2026-09-27T12:00:00Z', title: 'Find an expert' },
  ] } }));
  await page.route('**/api/sessions/stacked-session/events', route => route.fulfill({ json: { events: [
    { eventId: 'q1', role: 'USER', text: 'Find an expert' },
    { eventId: 'a1', role: 'ASSISTANT', text: 'Restored answer with evidence.' },
  ] } }));
  await page.goto('/iq/invoke');
  const rail = page.getByTestId('search-explorer-rail');
  await expect(rail).toBeVisible();
  await rail.getByRole('link', { name: /Find an expert/ }).click();
  await expect(page.getByRole('log')).toContainText('Restored answer with evidence.');
  await expect(rail.getByRole('link', { name: /Find an expert/ })).toHaveAttribute('aria-current', 'page');
  const railBox = await rail.boundingBox();
  const chatBox = await page.getByRole('log').boundingBox();
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(chatBox!.x);
  await expect(page.getByTestId('search-composer').locator('[contenteditable=true]')).toBeInViewport();
  await page.getByTestId('search-workspace').getByRole('button', { name: 'New search', exact: true }).click();
  await page.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('log')).not.toContainText('Restored answer with evidence.');
  await rail.getByRole('link', { name: /Find an expert/ }).click();
  await expect(page.getByRole('log')).toContainText('Restored answer with evidence.');
});

test('run detail retains Automate navigation while changing detail tabs', async ({ page }) => {
  await page.goto('/iq/work/job-auth-maint-1');
  const rail = page.getByRole('navigation', { name: 'Automate navigation' });
  await expect(rail.getByRole('link', { name: 'Runs', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Recorded tool results' })).toBeVisible();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(rail).toBeVisible();
  await page.getByRole('link', { name: /Back to runs/ }).click();
  await expect(page).toHaveURL(/\/iq\/work\/queue$/);
  await expect(rail.getByRole('link', { name: 'Runs', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('Agent library uses a table overview and keeps both menus for asset details', async ({ page }) => {
  await page.goto('/iq/library');
  await expect(page.getByTestId('catalog-overview')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Agent library navigation' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Used by', exact: true })).toBeInViewport();
  await expect(page.getByTestId('stacked-catalog-list')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search assets', exact: true }).fill('Stakeholder update email');
  await page.getByTestId('agent-library-table').getByText('Stakeholder update email', { exact: true }).click();
  await expect(page).toHaveURL(/\/iq\/library\/lib-stakeholder-email/);
  await expect(page.getByTestId('stacked-catalog-list')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Agent library navigation' })).toBeVisible();
  await expect(page.getByText('Contract', { exact: true })).toBeVisible();
});
