import { expect, test, type Page } from '@playwright/test';
import { openAsClone } from './realSession';

async function navigateDocument(page: Page, id: string) {
  const workspace = page.getByTestId(`${id}-workspace`);
  const contents = page.getByTestId(`${id}-contents`);
  await expect(contents).toBeVisible();
  const buttons = contents.getByRole('button');
  expect(await buttons.count()).toBeGreaterThan(3);
  const last = buttons.last();
  const title = await last.locator('.doc-reading-contents-label').innerText();
  await last.click();
  await expect(workspace.locator('[data-reading-number]').filter({ hasText: title }).last()).toBeFocused();
  await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await expect(page.getByTestId(`${id}-back-to-top`)).toBeVisible();
  await page.getByTestId(`${id}-back-to-top`).click();
  await expect(contents).toBeFocused();
  await expect.poll(() => workspace.evaluate(el => el.scrollTop)).toBe(0);
  await expect(workspace.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
  expect(await workspace.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const theme of ['light', 'dark']) test(`document reading in page and pane: ${theme}`, async ({ browser }) => {
  test.setTimeout(120_000);
  const writes: string[] = [];
  const person = await openAsClone(browser, 'u-release', {
    role: 'org-leader', expectTenant: 'orgiq', landing: null, viewport: { width: 1440, height: 1000 },
    prepare: async context => {
      await context.addInitScript(value => { localStorage.setItem('theme', value); localStorage.setItem('shell.conversation-pane.open', '0'); }, theme);
      await context.route('**/api/**', route => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
        writes.push(route.request().url()); return route.abort();
      });
    },
  });
  try {
    const page = person.page;
    await page.goto('/iq/runbooks/rb-ui-components-release');
    await expect(page.getByRole('heading', { name: 'Library release and consumer updates', exact: true }).first()).toBeVisible();
    await navigateDocument(page, 'runbook-reader');
    await page.screenshot({ path: test.info().outputPath(`runbook-${theme}.png`) });
    await page.getByText('Files and provenance', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Where it came from', exact: true })).toBeVisible();
    await page.getByText('Files and provenance', { exact: true }).click();
    await page.setViewportSize({ width: 900, height: 1000 });
    await navigateDocument(page, 'runbook-reader');
    await page.screenshot({ path: test.info().outputPath(`runbook-900-${theme}.png`) });
    await page.goto('/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e2-b4');
    await page.getByTestId('work-item-brief-preview').getByRole('button').click();
    await expect(page.getByTestId('brief-markdown-workspace')).toHaveAttribute('data-reading-presentation', 'pane');
    await expect(page.getByTestId('brief-markdown-body').getByRole('heading', { level: 1 })).toHaveText('Session brief');
    await navigateDocument(page, 'brief-markdown');
    await page.screenshot({ path: test.info().outputPath(`brief-900-${theme}.png`) });
    await page.getByTestId('brief-markdown-contents').getByRole('button', { name: /^\d+\. Sources$/ }).click();
    await expect(page.getByTestId('brief-markdown-body').getByRole('heading', { name: /^\d+\. Sources$/ })).toBeFocused();
    await expect(page.getByTestId('brief-markdown-body').getByRole('heading', { name: /^\d+\. Sources$/ })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`brief-sources-${theme}.png`) });
    await page.getByTestId('brief-markdown-back-to-top').click();
    await page.getByTestId('brief-markdown-contents').getByRole('button', { name: /Assembly details$/ }).click();
    await expect(page.getByTestId('brief-markdown-body').getByRole('heading', { name: /^\d+\. Assembly details$/ })).toBeFocused();
    await expect(page.getByTestId('brief-markdown-body').getByRole('heading', { name: /^\d+\. Assembly details$/ })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`brief-assembly-${theme}.png`) });
    await page.setViewportSize({ width: 1680, height: 1050 });
    await navigateDocument(page, 'brief-markdown');
    await page.screenshot({ path: test.info().outputPath(`brief-${theme}.png`) });
    await page.goto('/iq/runbooks/proposals/prop-tenant-cutover-callback');
    await expect(page.getByTestId('proposal-review-title')).toHaveText('SAML to Cognito migration');
    const proposalContents = page.getByTestId('proposal-contents');
    await expect(proposalContents).toBeVisible();
    await expect(proposalContents).toHaveAttribute('aria-label', 'On this page');
    await expect(page.getByText('Runbook proposal', { exact: true })).toBeVisible();
    const contentsHeading = page.getByTestId('proposal-section-contents').getByRole('heading');
    const firstHeading = page.getByTestId('proposal-section-summary').getByRole('heading').first();
    expect(await contentsHeading.evaluate(el => getComputedStyle(el).fontSize)).toBe(await firstHeading.evaluate(el => getComputedStyle(el).fontSize));
    expect(await page.getByTestId('proposal-review').locator('.doc-page').count()).toBe(0);
    await page.screenshot({ path: test.info().outputPath(`proposal-${theme}.png`) });
    await proposalContents.getByRole('button', { name: /Document changes$/ }).click();
    await expect(page.getByTestId('proposal-section-changes').getByRole('heading', { level: 2 })).toBeFocused();
    await page.getByTestId('proposal-back-to-contents').click();
    await expect(page.getByTestId('proposal-section-contents').getByRole('heading')).toBeFocused();
    await proposalContents.getByRole('button', { name: /Proposed runbook$/ }).click();
    await expect(page.getByTestId('proposal-section-preview').getByRole('heading', { level: 2 }).first()).toBeFocused();
    await page.getByTestId('proposal-back-to-contents').click();
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(proposalContents).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`proposal-900-${theme}.png`) });
    expect(writes).toEqual([]);
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});
