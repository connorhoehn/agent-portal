import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_DEVBOX_MODEL, DEVBOX_MODELS } from '../src/lib/devboxModels';

// Prepare job as a composer deck (ui-components 2.444.0 ComposerPromptDeck):
// the job derived from the item, one header card, only the questions that need
// a human, keyboard answers, and the unchanged dispatch contract with its
// accumulating confirm flags.

const forecast = { basis: 'model', sampleCount: 4, costUsdP25: 0.5, costUsdP75: 1.5,
  minutesP25: 2, minutesP75: 5, points: 2, scaled: true };
const envelopes = { personId: 'p-1', resolved: true, attributionAvailable: true, envelopes: [{ grantId: 'g', orgProjectId: 'p-observability',
  orgProjectName: 'Observability', sprintId: 's', sprintName: 'Sprint 14', sprintStatus: 'active', startsOn: null, endsOn: null,
  allocatedUsd: 30, spentUsd: 2, remainingUsd: 28, attributionAvailable: true }] };
type Captured = { method: string; path: string; body: unknown };

async function fixture(page: Page, query = '', dispatchAnswers: Array<{ status: number; json: unknown }> = []) {
  const requests: Captured[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.method() === 'POST' ? request.postDataJSON() as unknown : null;
    requests.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === '/api/bots/estimate' && request.method() === 'GET') return route.fulfill({ json: forecast });
    if (url.pathname === '/api/bots/work-items/fixture-item/job-draft' && request.method() === 'GET') return route.fulfill({ json: { draft: null } });
    if (url.pathname === '/api/access-requests/mine' && request.method() === 'GET') return route.fulfill({ json: { items: [] } });
    if (url.pathname === '/api/sprints/envelopes') return route.fulfill({ json: envelopes });
    if (url.pathname === '/api/bots/dispatch-work' && request.method() === 'POST') {
      const answer = dispatchAnswers.shift();
      if (answer) return route.fulfill({ status: answer.status, json: answer.json });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.route('**/__prepare-job*', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/prepare-job.tsx"></script></body></html>' }));
  await page.goto(`/__prepare-job${query}`);
  return { requests, unexpected, errors };
}

const deck = (page: Page) => page.getByTestId('prepare-job-deck');
const card = (page: Page) => page.getByTestId('prepare-job-deck-card');

test('the compact prompt owns focus and bare cap shortcuts; only custom dollars reveal an input', async ({ page }) => {
  const result = await fixture(page, '?composer=1');
  const input = page.getByTestId('prepare-job-conversation-prompts-answer');
  const editor = page.getByTestId('prepare-job-editor');
  const prompt = page.getByTestId('prepare-job-conversation-prompts-card');
  await expect(prompt.locator('[data-composer-prompt-option]:focus')).toHaveCount(1);
  await page.keyboard.press('3');
  await expect(prompt).toContainText('Run cap');
  await expect(prompt.locator('[data-composer-prompt-option]:focus')).toHaveCount(1);
  await page.keyboard.press('2');
  await expect(prompt).toContainText('Dispatch with these settings?');
  await expect(prompt).toContainText('$1.50');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Message formatting' })).toHaveCount(0);
  await page.keyboard.press('3');
  await expect(prompt).toContainText('Run cap');
  await page.keyboard.press('3');
  await expect(prompt).toHaveAttribute('data-composer-prompt-kind', 'number');
  await expect(input).toBeFocused();
  await page.keyboard.type('2.50');
  await expect(input).toHaveValue('2.50');
  await page.keyboard.press('Enter');
  await expect(prompt).toContainText('Dispatch with these settings?');
  await expect(prompt).toContainText('$2.50');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Message formatting' })).toHaveCount(0);
  expect(result.requests.every(request => request.method === 'GET')).toBe(true);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('a dispatcher sees the derived job on one card and dispatches from the keyboard, through a gate', async ({ page }) => {
  const result = await fixture(page, '', [
    { status: 409, json: { gate: 'envelope', error: 'over your sprint envelope', envelope: { sprintName: 'Sprint 14', allocatedUsd: 30, attributedSpentUsd: 29, remainingUsd: 1, attributionAvailable: true } } },
    { status: 202, json: { run: { id: 'run-1', status: 'running' } } },
  ]);
  await expect(deck(page)).toHaveAttribute('data-composer-prompt-deck', 'expanded');
  await expect(card(page)).toHaveAttribute('data-composer-prompt-kind', 'choice');
  await expect(page.getByRole('group', { name: 'Reduce duplicate alerts' })).toBeVisible();
  const fields = page.getByTestId('prepare-job-deck-fields');
  for (const text of ['OBS-14', 'fixture/alerts', DEVBOX_MODELS.find(m => m.id === DEFAULT_DEVBOX_MODEL)!.label, 'No cap', '$0.50–$1.50 · 2–5 min', '$28.00 left of $30.00']) {
    await expect(fields).toContainText(text);
  }
  await expect(card(page)).toContainText('Dispatch with these settings?');
  await page.getByTestId('prepare-job-deck-option-dispatch').focus();
  // 2 → Change model; 3 → the third model.
  await page.keyboard.press('2');
  await expect(page.getByRole('group', { name: 'Model' })).toBeVisible();
  await page.getByTestId(`prepare-job-deck-option-${DEVBOX_MODELS[0]!.id}`).focus();
  await page.keyboard.press('3');
  await expect(page.getByTestId('prepare-job-deck-receipt')).toContainText(`Model → ${DEVBOX_MODELS[2]!.label}`);
  await expect(fields).toContainText(DEVBOX_MODELS[2]!.label);
  // 1 → Dispatch; the envelope gate answers 409.
  await page.getByTestId('prepare-job-deck-option-dispatch').focus();
  await page.keyboard.press('1');
  await expect(card(page)).toHaveAttribute('data-composer-prompt-kind', 'confirm');
  await expect(card(page)).toContainText('Budget gate · confirmOverEnvelope');
  await expect(card(page)).toContainText('Dispatch anyway?');
  await page.getByTestId('prepare-job-deck-option-confirm').focus();
  await page.keyboard.press('1');
  await expect(page.getByTestId('prepare-job-deck-receipt')).toContainText('Dispatched · "Reduce duplicate alerts" is in progress');
  await expect(page.getByTestId('dispatched-run')).toContainText('run-1');
  const posts = result.requests.filter(r => r.method === 'POST').map(r => r.body);
  const job = { workItemId: 'fixture-item', model: DEVBOX_MODELS[2]!.id, agentProjectId: 'fixture-second' };
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject(job);
  expect(posts[0]).not.toHaveProperty('confirmOverEnvelope');
  expect(posts[1]).toMatchObject({ ...job, confirmOverEnvelope: true });
  expect(posts[1]).not.toHaveProperty('confirmOverRunBudget');
  expect(posts[1]).not.toHaveProperty('confirmOverAllocation');
  expect((posts[0] as { instruction: string }).instruction).toMatch(/^Reduce duplicate alerts\. One page per outage\./);
  await page.screenshot({ path: test.info().outputPath('prepare-job-deck.png') });
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('Esc hides the deck without answering; the menu re-asks', async ({ page }) => {
  const result = await fixture(page);
  await page.getByTestId('prepare-job-deck-option-dispatch').focus();
  await page.keyboard.press('Escape');
  await expect(deck(page)).toHaveAttribute('data-composer-prompt-deck', 'collapsed');
  await expect(deck(page)).toContainText('1 question waiting');
  await page.getByTestId('initiative-header-menu-trigger').click();
  await page.getByTestId('work-item-prepare-job').click();
  await expect(deck(page)).toHaveAttribute('data-composer-prompt-deck', 'expanded');
  expect(result.requests.every(r => r.method === 'GET')).toBe(true);
  expect(result.errors).toEqual([]);
});

test('a refusal that cannot be confirmed stays on the card', async ({ page }) => {
  const result = await fixture(page, '', [{ status: 403, json: { error: 'This work item is not available for dispatch.' } }]);
  await page.getByTestId('prepare-job-deck-option-dispatch').click();
  await expect(page.getByTestId('prepare-job-deck-error')).toHaveText('This work item is not available for dispatch.');
  await expect(card(page)).toContainText('Dispatch with these settings?');
  expect(result.errors).toEqual([]);
});

test('a missing sprint grant routes to the funding choices without dispatching again', async ({ page }) => {
  const result = await fixture(page, '', [{ status: 403, json: { error: 'You hold no active sprint grant on this initiative.' } }]);
  await page.getByTestId('prepare-job-deck-option-dispatch').click();
  await expect(card(page)).toContainText('This job needs a sprint envelope');
  await expect(page.getByTestId('prepare-job-deck-option-request')).toBeVisible();
  await expect(page.getByTestId('prepare-job-deck-option-save')).toBeVisible();
  expect(result.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('a reader asks to view the setup: read-only card, no answers, no forecast or envelope requests', async ({ page }) => {
  const result = await fixture(page, '?role=member');
  await expect(deck(page)).toHaveCount(0);
  await page.getByTestId('initiative-header-menu-trigger').click();
  await expect(page.getByTestId('work-item-prepare-job')).toHaveAccessibleName('View job setup');
  await page.getByTestId('work-item-prepare-job').click();
  await expect(page.getByTestId('prepare-job-deck-read-only')).toContainText('authorizes jobs');
  await expect(page.getByTestId('prepare-job-deck-option-dispatch')).toHaveCount(0);
  await expect(page.getByTestId('prepare-job-deck-fields')).toContainText('Needs dispatch rights');
  expect(result.requests).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('the card fits 900px and 390px without horizontal scroll', async ({ page }) => {
  const result = await fixture(page);
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card(page)).toBeVisible();
    expect(await card(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const box = await card(page).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    await card(page).screenshot({ path: test.info().outputPath(`prepare-job-deck-${width}.png`) });
  }
  expect(result.errors).toEqual([]);
});

test('an accepted dispatch stays in the box as a run card; a stopped run retries in place', async ({ page }) => {
  const run = (id: string) => ({ status: 202, json: { run: { id, status: 'running', costUsd: null } } });
  const result = await fixture(page, '?runStatus=failed&runReason=Run%20cap%20reached', [run('run-1'), run('run-2')]);
  await page.getByTestId('prepare-job-deck-option-dispatch').click();
  await expect(card(page)).toContainText('Stopped while the agent was working');
  await expect(card(page)).toContainText('Run cap reached');
  await expect(deck(page)).toContainText('Dispatched');
  await expect(deck(page)).toContainText('Agent working');
  await expect(deck(page)).toContainText('Result ready');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await card(page).screenshot({ path: test.info().outputPath('prepare-job-run-stopped.png') });
  await page.getByTestId('prepare-job-deck-option-retry').click();
  await expect(page.getByTestId('dispatched-run')).toContainText('run-2');
  await expect(card(page)).toContainText('Stopped while the agent was working');
  const posts = result.requests.filter(r => r.method === 'POST' && r.path === '/api/bots/dispatch-work');
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toMatchObject({ workItemId: 'fixture-item' });
  await page.getByTestId('prepare-job-deck-option-back').click();
  await expect(card(page)).toContainText('Dispatch with these settings?');
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('a running dispatch shows the agent working, and Dismiss closes the card', async ({ page }) => {
  const result = await fixture(page, '', [{ status: 202, json: { run: { id: 'run-1', status: 'running', costUsd: null } } }]);
  await page.getByTestId('prepare-job-deck-option-dispatch').click();
  await expect(card(page)).toContainText('The agent is working on this item');
  await expect(page.getByTestId('prepare-job-deck-option-dismiss')).toBeVisible();
  await page.getByTestId('prepare-job-deck-option-dismiss').click();
  await expect(card(page)).toHaveCount(0);
  expect(result.unexpected).toEqual([]);
  expect(result.errors).toEqual([]);
});

test('a finished run completes the path with its result', async ({ page }) => {
  const result = await fixture(page, '?runStatus=done', [{ status: 202, json: { run: { id: 'run-1', status: 'running', costUsd: 0.84 } } }]);
  await page.getByTestId('prepare-job-deck-option-dispatch').click();
  await expect(card(page)).toContainText('Result ready');
  await expect(card(page)).toContainText('$0.84');
  await expect(page.getByTestId('prepare-job-deck-option-retry')).toHaveCount(0);
  expect(result.errors).toEqual([]);
});
