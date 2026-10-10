import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1024, height: 900 } });
test('codebase refresh preserves the unsent plan, cap and readable choice', async ({ page }) => {
  const requests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.route('**/__run-draft-refresh', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/run-draft-refresh.tsx"></script></body></html>` }));
  await page.goto('/__run-draft-refresh');
  const instruction = page.getByTestId('run-draft-instruction');
  await instruction.fill('Review the dependency map before changing alerts.');
  await page.getByTestId('run-draft-budget-input').fill('2.5');
  await page.getByRole('button', { name: 'Load one codebase', exact: true }).click();
  await expect(instruction).toHaveValue('Review the dependency map before changing alerts.');
  await expect(page.getByTestId('run-choice')).toContainText('"capUsd":2.5');
  await expect(page.getByTestId('run-choice')).toContainText('"agentProjectId":"fixture-first"');
  await page.getByRole('button', { name: 'Refresh codebases', exact: true }).click();
  await page.getByLabel('Codebase', { exact: true }).selectOption('fixture-second');
  await page.getByRole('button', { name: 'Reorder codebases', exact: true }).click();
  await expect(page.getByLabel('Codebase', { exact: true })).toHaveValue('fixture-second');
  await expect(instruction).toHaveValue('Review the dependency map before changing alerts.');
  await page.getByRole('button', { name: 'Remove codebases', exact: true }).click();
  await expect(page.getByTestId('run-choice')).toContainText('"agentProjectId":null');
  await expect(page.getByTestId('run-choice')).toContainText('"capUsd":2.5');
  await expect(instruction).toHaveValue('Review the dependency map before changing alerts.');
  await page.screenshot({ path: test.info().outputPath('retained-plan.png') });
  await page.getByRole('button', { name: 'Change work item', exact: true }).click();
  await expect(page.getByTestId('run-choice')).toContainText('"instruction":""');
  await expect(page.getByTestId('run-choice')).toContainText('"capUsd":null');
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('verification.json'), JSON.stringify({ requests, errors,
    scope: 'Actual RunDraft and native form primitives; explicit inert work/codebase fixtures, no service requests or dispatch.',
    lateLoad: 'plan and cap retained', refresh: 'readable explicit selection retained', removal: 'plan retained, unavailable selection cleared',
    workItemChange: 'new empty plan' }, null, 2));
});
