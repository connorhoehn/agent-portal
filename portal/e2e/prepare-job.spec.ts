import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_DEVBOX_MODEL, DEVBOX_MODELS } from '../src/lib/devboxModels';

const forecast = { basis: 'prior', sampleCount: 0, costUsdP25: 0.5, costUsdP75: 1.5,
  minutesP25: 2, minutesP75: 5, points: 2, scaled: false, confidence: 'prior' };
type Captured = { method: string; path: string; body: unknown };

async function fixture(page: Page, query = '', forecastError = false) {
  const requests: Captured[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.method() === 'POST' ? request.postDataJSON() as unknown : null;
    requests.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === '/api/bots/estimate' && request.method() === 'GET') {
      return route.fulfill({ status: forecastError ? 503 : 200, json: forecastError
        ? { error: 'Fixture forecast unavailable' } : forecast });
    }
    if (url.pathname === '/api/bots/work-items/fixture-item/estimate' && request.method() === 'POST') {
      const saved = body as { model: string; estimate: typeof forecast };
      return route.fulfill({ json: { item: { estimateModel: saved.model,
        estimatedAt: '2026-10-10T12:00:00Z', estimatedByName: 'Fixture reviewer', estimateForecast: saved.estimate } } });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.route('**/__prepare-job*', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/prepare-job.tsx"></script></body></html>' }));
  await page.goto(`/__prepare-job${query}`);
  await expect(page.locator('.work-item-metadata').getByTestId('work-item-prepare-job')).toHaveCount(0);
  await page.getByTestId('initiative-header-menu-trigger').click();
  const prepare = page.getByTestId('work-item-prepare-job');
  await expect(prepare).toBeVisible();
  await prepare.click();
  const setup = page.getByTestId('run-setup');
  await expect(page.getByRole('tab', { name: 'Brief', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(setup.getByTestId('run-setup-summary')).toBeFocused();
  await expect(page.getByTestId('run-draft-instruction')).toBeVisible();
  return { setup, requests, unexpected, errors };
}

test('instruction is visible and compact configuration adapts to narrow width', async ({ page }) => {
  const result = await fixture(page);
  const panel = page.getByTestId('run-draft-panel');
  await expect(panel.getByRole('button', { name: 'Review & authorize', exact: true })).toBeVisible();
  await expect(page.getByTestId('run-draft-advanced-summary')).toHaveCount(0);
  await expect(page.getByLabel('Codebase', { exact: true })).toBeVisible();
  const codebase = await page.getByLabel('Codebase', { exact: true }).boundingBox();
  const model = await page.getByLabel('Model', { exact: true }).boundingBox();
  expect(codebase && model && Math.abs(codebase.y - model.y)).toBeLessThan(2);
  await expect(panel.getByTestId('run-draft-forecast')).toContainText('Prior forecast · low confidence');
  expect((await panel.boundingBox())!.height).toBeLessThan(400);
  const type = await panel.getByRole('button', { name: 'Review & authorize', exact: true }).evaluate(element => ({
    size: getComputedStyle(element).fontSize, weight: getComputedStyle(element).fontWeight,
  }));
  // The native small button is 12px/600 across the application.
  expect(type).toEqual({ size: '12px', weight: '600' });
  await result.setup.screenshot({ path: test.info().outputPath('prepare-job-wide.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  const narrow = await panel.boundingBox();
  expect(narrow!.width).toBeLessThanOrEqual(358);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(narrow!.height).toBeLessThan(560);
  const narrowCodebase = await page.getByLabel('Codebase', { exact: true }).boundingBox();
  const narrowModel = await page.getByLabel('Model', { exact: true }).boundingBox();
  expect(narrowModel!.y).toBeGreaterThan(narrowCodebase!.y);
  await result.setup.screenshot({ path: test.info().outputPath('prepare-job-narrow.png') });
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.requests.every(request => request.method === 'GET')).toBe(true);
});

test('estimate saving preserves the plan and review receives exact choices without dispatch', async ({ page }) => {
  const result = await fixture(page);
  const instruction = 'Review the dependency map, change alert grouping, and verify one page per outage.';
  await page.getByLabel('Instruction', { exact: true }).fill(instruction);
  await page.getByLabel('Codebase', { exact: true }).selectOption('fixture-second');
  await page.getByLabel('Model', { exact: true }).selectOption(DEVBOX_MODELS[1]!.id);
  await page.getByLabel('Run cap', { exact: true }).fill('1');
  await expect(page.getByText('Below forecast; review will ask you to confirm.')).toBeVisible();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.getByTestId('initiative-header-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Prepare job', exact: true }).click();
  await expect(page.getByLabel('Instruction', { exact: true })).toHaveValue(instruction);
  await expect(page.getByLabel('Run cap', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Save estimate', exact: true }).click();
  await expect(page.getByTestId('run-draft-forecast')).toContainText('Recorded estimate');
  await expect(page.getByLabel('Instruction', { exact: true })).toHaveValue(instruction);
  await expect(page.getByText('Draft saved', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review & authorize', exact: true }).click();
  await expect(page.getByTestId('review-choice')).toHaveText(JSON.stringify({
    model: DEVBOX_MODELS[1]!.id, agentProjectId: 'fixture-second', capUsd: 1, instruction,
  }));
  const writes = result.requests.filter(request => request.method !== 'GET');
  expect(writes).toEqual([{ method: 'POST', path: '/api/bots/work-items/fixture-item/estimate',
    body: { model: DEVBOX_MODELS[1]!.id, estimate: forecast } }]);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('read-only role has one concise access cue and makes no forecast requests', async ({ page }) => {
  const result = await fixture(page, '?role=member');
  await expect(page.getByTestId('run-draft-access')).toContainText('An SME or leader authorizes jobs');
  for (const label of ['Instruction', 'Run cap']) {
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review & authorize', exact: true })).toBeDisabled();
  // A reader can inspect the recorded model, without fetching new forecasts.
  await expect(page.getByLabel('Model', { exact: true })).toBeEnabled();
  await result.setup.screenshot({ path: test.info().outputPath('prepare-job-read-only.png') });
  expect(result.requests).toEqual([]);
  await expect(page.getByLabel('Status', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Priority', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('work-patch')).toHaveText('null');
  expect(result.errors).toEqual([]);
});

test('native status and priority fields keep exact work patch semantics', async ({ page }) => {
  const result = await fixture(page);
  await expect(page.getByRole('button', { name: 'Change work status', exact: true })).toHaveCount(0);
  const status = page.getByLabel('Status', { exact: true });
  const priority = page.getByLabel('Priority', { exact: true });
  await status.selectOption('in_progress');
  await expect(page.getByTestId('work-patch')).toHaveText('{"status":"in_progress"}');
  await expect(status).toHaveValue('in_progress');
  await priority.selectOption('high');
  await expect(page.getByTestId('work-patch')).toHaveText('{"priority":"high"}');
  await expect(priority).toHaveValue('high');
  await expect(status).toHaveValue('in_progress');
  await expect(page.getByRole('button', { name: 'Review & authorize', exact: true })).toBeDisabled();
  await expect(page.getByText('Only work that is up next can be dispatched.', { exact: true })).toBeVisible();
  expect(await status.evaluate(element => element.tagName)).toBe('SELECT');
  expect(await priority.evaluate(element => element.tagName)).toBe('SELECT');
  // Both use the shared neutral field, not a portal pill/menu reconstruction.
  const chrome = (element: Element) => {
    const style = getComputedStyle(element);
    return { radius: style.borderRadius, border: style.borderStyle, background: style.backgroundColor };
  };
  expect(await priority.evaluate(chrome)).toEqual(await status.evaluate(chrome));
  expect((await priority.evaluate(chrome)).radius).toBe('6px');
  await page.getByTestId('initiative-header-menu-trigger').click();
  await expect(page.getByRole('menuitem', { name: 'Prepare job', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('native-work-controls.png') });
  expect(result.requests.every(request => request.method === 'GET')).toBe(true);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('reader can inspect a stored estimate for its exact model without new forecast authority', async ({ page }) => {
  const result = await fixture(page, '?role=member&estimate=stored');
  await expect(page.getByTestId('run-draft-forecast')).not.toContainText('Recorded estimate');
  await page.getByLabel('Model', { exact: true }).selectOption(DEVBOX_MODELS[1]!.id);
  await expect(page.getByTestId('run-draft-forecast')).toContainText('Recorded estimate');
  await expect(page.getByTestId('run-draft-forecast')).toContainText('$0.50 – $1.50');
  await expect(page.getByRole('button', { name: 'Review & authorize', exact: true })).toBeDisabled();
  expect(result.requests).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('native optional run cap clears and clamps on blur before review', async ({ page }) => {
  const result = await fixture(page);
  const cap = page.getByLabel('Run cap', { exact: true });
  await cap.fill('-1');
  await page.getByLabel('Instruction', { exact: true }).focus();
  await expect(cap).toHaveValue('0');
  await cap.fill('2.5');
  await expect(page.getByTestId('prepared-choice')).toContainText('"capUsd":2.5');
  await cap.fill('');
  await expect(page.getByTestId('prepared-choice')).toContainText('"capUsd":null');
  expect(result.requests.every(request => request.method === 'GET')).toBe(true);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('missing sprint grant remains a review cue and never authorizes automatically', async ({ page }) => {
  const result = await fixture(page, '?grant=missing');
  await expect(page.getByTestId('run-draft-access')).toContainText('Sprint access required');
  await expect(page.getByRole('link', { name: 'Open sprints', exact: true })).toHaveAttribute('href', '/iq/sprints');
  await expect(page.getByRole('button', { name: 'Review & authorize', exact: true })).toBeEnabled();
  await expect(page.getByTestId('review-choice')).toHaveText('null');
  await expect(page.getByTestId('default-model')).toHaveText(DEFAULT_DEVBOX_MODEL);
  expect(result.requests.every(request => request.method === 'GET')).toBe(true);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('failed forecast is explicit once and estimate saving remains disabled', async ({ page }) => {
  const result = await fixture(page, '', true);
  await expect(page.getByRole('alert')).toHaveText('Fixture forecast unavailable');
  await expect(page.getByText('Fixture forecast unavailable', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('run-draft-forecast')).toContainText('Forecast unavailable');
  await expect(page.getByRole('button', { name: 'Save estimate', exact: true })).toBeDisabled();
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});
