import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { chooseOption } from './selectOption';
test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1280, height: 900 }, actionTimeout: 5_000, navigationTimeout: 10_000 });

async function evidence(name: string, fileName: string, body: string, contentType: string) {
  const path = test.info().outputPath(fileName);
  await writeFile(path, body);
  await test.info().attach(name, { path, contentType });
}

async function mountReader(page: Page) {
  await page.route('**/__deck-reader', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/deck-reader.tsx"></script></body></html>` }));
  await page.goto('/__deck-reader');
}

test('read-only deck keeps modern chrome and pinned composer with functional viewing controls', async ({ page }) => {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await mountReader(page);
  const original = await page.evaluate(() => (window as typeof window & { __deckFixtureSpec: string }).__deckFixtureSpec);
  const position = page.getByTestId('fixture-reader-position');
  await expect(position).toHaveText('Slide 1 of 3');
  await expect(page.getByTestId('fixture-reader-filmstrip-select-sources')).toBeVisible();
  await expect(page.getByRole('button', { name: /Add slide|New slide|Save as|Duplicate|Delete slide/ })).toHaveCount(0);
  await page.getByTestId('fixture-reader-filmstrip-select-details').click();
  await expect(position).toHaveText('Slide 2 of 3');
  await expect(page.getByTestId('fixture-reader-notes')).toHaveValue('Keep the affected services visible.');
  await expect(page.getByTestId('fixture-reader-notes')).toHaveAttribute('readonly', '');
  await page.getByTestId('fixture-reader-notes').focus();
  await expect(page.getByTestId('fixture-reader-notes')).toBeFocused();
  await expect(page.getByTestId('fixture-reader-notes')).not.toBeEditable();
  await expect(page.getByTestId('fixture-footer')).toHaveAttribute('data-slide', 'details');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');
  await expect(page.getByTestId('fixture-footer')).toHaveAttribute('data-slide', 'sources');
  await expect(page.getByRole('button', { name: 'Next slide', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  const outline = page.getByRole('navigation', { name: 'Presentation outline' });
  await expect(outline).toContainText('Confirm the dependency map');
  await outline.getByRole('button', { name: /Summary/ }).click();
  await expect(position).toHaveText('Slide 1 of 3');
  await page.getByTestId('fixture-reader-viewport').press('End');
  await expect(position).toHaveText('Slide 3 of 3');
  await page.getByTestId('fixture-reader-viewport').press('Home');
  await chooseOption(page.getByRole('combobox', { name: 'Slide zoom' }), '100');
  await expect(page.locator('.deck-reader-slide-frame')).toHaveCSS('width', '960px');
  await chooseOption(page.getByRole('combobox', { name: 'Slide zoom' }), 'fit');
  const frame = await page.getByTestId('fixture-reader-stage').boundingBox();
  expect(frame).toBeTruthy(); expect(Math.abs(frame!.width / frame!.height - 16 / 9)).toBeLessThan(0.02);
  const input = page.getByTestId('fixture-question-input').locator('[contenteditable="true"]');
  const draft = 'Keep this question draft while presenting.';
  await input.fill(draft);
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Present Read-only presentation' })).toBeVisible();
  const present = page.getByTestId('fixture-reader-present');
  await present.press('ArrowRight');
  await expect(page.getByTestId('fixture-reader-present-position')).toHaveText('Slide 2 of 3');
  await page.getByRole('button', { name: 'Exit presentation', exact: true }).click();
  await expect(position).toHaveText('Slide 2 of 3');
  await expect(input).toHaveText(draft);
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await present.press('End');
  await expect(page.getByTestId('fixture-reader-present-position')).toHaveText('Slide 3 of 3');
  await present.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(position).toHaveText('Slide 3 of 3');
  await expect(input).toHaveText(draft);
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chat & agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveText(draft);
  await expect(position).toHaveText('Slide 3 of 3');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByTestId('fixture-reader-notes')).toHaveCount(0);
  await page.getByRole('button', { name: 'Follow last slide', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');
  await page.getByRole('button', { name: 'Chat & agent', exact: true }).click();
  await expect(page.getByTestId('fixture-question-input').locator('[contenteditable="true"]')).toBeFocused();
  const footer = await page.getByTestId('fixture-footer').boundingBox();
  expect(footer).toBeTruthy(); expect(footer!.y + footer!.height).toBeLessThanOrEqual(901);
  await page.screenshot({ path: test.info().outputPath('read-only-deck-wide.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  const compactFooter = await page.getByTestId('fixture-footer').boundingBox();
  expect(compactFooter).toBeTruthy(); expect(compactFooter!.y + compactFooter!.height).toBeLessThanOrEqual(769);
  await page.screenshot({ path: test.info().outputPath('read-only-deck-compact.png') });
  expect(await page.evaluate(() => (window as typeof window & { __deckFixtureSpec: string }).__deckFixtureSpec)).toBe(original);
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('manual reader navigation stops Follow while teammate moves remain programmatic', async ({ page }) => {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Maximum update depth exceeded/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await mountReader(page);
  const root = page.getByTestId('fixture-root'), position = page.getByTestId('fixture-reader-position');
  const follow = page.getByRole('button', { name: 'Follow teammate', exact: true });
  await follow.click();
  await expect(root).toHaveAttribute('data-following', 'true');
  await page.getByRole('button', { name: 'Teammate: Sources', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');
  await expect(root).toHaveAttribute('data-following', 'true');
  // Even selecting the currently followed Sources slide is manual intent.
  await page.getByTestId('fixture-reader-filmstrip-select-sources').click();
  await expect(root).toHaveAttribute('data-following', 'false');
  await page.getByRole('button', { name: 'Teammate: Summary', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');

  await follow.click();
  await expect(position).toHaveText('Slide 1 of 3');
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await page.getByRole('navigation', { name: 'Presentation outline' }).getByRole('button', { name: /Sources/ }).click();
  await expect(root).toHaveAttribute('data-following', 'false');
  await page.getByRole('button', { name: 'Teammate: Details', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');

  await follow.click();
  await expect(position).toHaveText('Slide 2 of 3');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(root).toHaveAttribute('data-following', 'false');
  await page.getByRole('button', { name: 'Teammate: Summary', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');

  await follow.click();
  await expect(position).toHaveText('Slide 1 of 3');
  await page.getByTestId('fixture-reader-viewport').press('End');
  await expect(root).toHaveAttribute('data-following', 'false');
  await page.getByRole('button', { name: 'Teammate: Details', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');

  await follow.click();
  await expect(position).toHaveText('Slide 2 of 3');
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(root).toHaveAttribute('data-following', 'true');
  await page.getByTestId('fixture-reader-present').press('End');
  await expect(root).toHaveAttribute('data-following', 'false');
  await expect(page.getByTestId('fixture-reader-present-position')).toHaveText('Slide 3 of 3');
  await page.getByRole('button', { name: 'Exit presentation', exact: true }).click();
  await page.getByRole('button', { name: 'Teammate: Summary', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('Stop Follow and avatar jumps preserve deliberate reader navigation', async ({ page }) => {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Maximum update depth exceeded/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await mountReader(page);
  const root = page.getByTestId('fixture-root'), position = page.getByTestId('fixture-reader-position');
  const header = page.getByTestId('fixture-shell-header');
  const avatar = header.locator('[data-testid="presence-avatar"][data-presence-user-id="fixture-peer"]');
  const peerCard = header.getByTestId('presence-card');
  await page.getByTestId('fixture-reader-filmstrip-select-sources').click();
  await avatar.hover();
  await peerCard.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(root).toHaveAttribute('data-following', 'true');
  await page.getByRole('button', { name: 'Teammate: Details', exact: true }).click();
  await expect(position).toHaveText('Slide 2 of 3');
  await expect(root).toHaveAttribute('data-following', 'true');
  await page.getByTestId('follow-bar-stop').click();
  await expect(root).toHaveAttribute('data-following', 'false');
  await page.getByRole('button', { name: 'Teammate: Summary', exact: true }).click();
  await expect(position).toHaveText('Slide 2 of 3');

  await page.getByTestId('fixture-reader-filmstrip-select-sources').click();
  await avatar.hover();
  await peerCard.getByRole('button', { name: 'Follow', exact: true }).click();
  await page.getByRole('button', { name: 'Teammate: Summary', exact: true }).click();
  await expect(position).toHaveText('Slide 1 of 3');
  await avatar.hover();
  await peerCard.getByRole('button', { name: 'Stop following', exact: true }).click();
  await expect(root).toHaveAttribute('data-following', 'false');
  await page.getByRole('button', { name: 'Teammate: Details', exact: true }).click();
  await expect(position).toHaveText('Slide 1 of 3');

  await avatar.hover();
  await peerCard.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(root).toHaveAttribute('data-following', 'true');
  await expect(position).toHaveText('Slide 2 of 3');
  await header.locator('[data-testid="presence-avatar"][data-presence-user-id="fixture-other"]').click();
  await expect(root).toHaveAttribute('data-following', 'false');
  await expect(position).toHaveText('Slide 3 of 3');
  await page.getByRole('button', { name: 'Teammate: Summary', exact: true }).click();
  await expect(position).toHaveText('Slide 3 of 3');
  await page.screenshot({ path: test.info().outputPath('reader-follow-stop-and-jump.png') });
  expect(writes).toEqual([]); expect(errors).toEqual([]);
  await evidence('reader-follow-stop-and-jump', 'reader-follow-stop-and-jump.json', JSON.stringify({
    fixtureOnly: true, usesExistingCollaborationHook: true, stopBarRetainedCurrentSlide: 'details',
    avatarToggleRetainedCurrentSlide: 'summary', otherParticipantJumpStoppedFollow: 'sources',
    subsequentPeerMoveDidNotOverride: true, writes, errors,
  }, null, 2), 'application/json');
});

test('reader hides old version images until the current preview is ready', async ({ page }) => {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Maximum update depth exceeded/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await mountReader(page);
  const stage = page.getByTestId('fixture-reader-stage');
  await expect(stage.locator('img')).toBeVisible();
  await page.getByRole('button', { name: 'Load next saved version', exact: true }).click();
  await expect(page.getByTestId('fixture-reader-preview-loading')).toBeVisible();
  await expect(stage.locator('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Finish current preview', exact: true }).click();
  await expect(stage.getByRole('img', { name: 'Updated summary', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Present Read-only presentation v2' })).toBeVisible();
  const currentImage = page.getByTestId('fixture-reader-present-stage').getByRole('img', { name: 'Updated summary', exact: true });
  await expect(currentImage).toBeVisible();
  await expect.poll(() => currentImage.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Exit presentation', exact: true }).click();
  await page.getByRole('button', { name: 'Fail current preview', exact: true }).click();
  await expect(stage).toContainText('Current render failed');
  await expect(stage.locator('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeDisabled();
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('real Work member can view the saved deck and focus its composer without editing it', async ({ page }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const deckId = 'idk-42e8a3f0-0595-40d7-9afd-65f79cfaf843';
  await page.goto('/');
  await signIn(page, 'u-theo', { expectTenant: 'orgiq', expectRole: 'member' });
  const principal = await (await page.request.get('/api/session/me')).json();
  const beforeResponse = await page.request.get(`/api/initiative-decks/${deckId}`);
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  expect(before.activeRevisionId).toBe('irev-1f41698f-42ff-4052-8f21-0eb16834db1d');
  const documentWrites: string[] = [], errors: string[] = [], questions: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/initiative-decks\/[^/]+\/(?:revisions|revise)(?:\/|$)/.test(new URL(request.url()).pathname)) documentWrites.push(new URL(request.url()).pathname);
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/orgiq-supervisor/invoke') questions.push(request.postDataJSON());
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Maximum update depth exceeded/.test(message.text())) errors.push(message.text()); });
  await page.goto(`/iq/decks/${deckId}`);
  const reader = page.getByTestId('initiative-deck-reader');
  await expect(reader).toBeVisible();
  await expect(page.getByTestId('initiative-deck-shell')).toContainText('View only');
  await expect(page.getByTestId('initiative-deck-save')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(New slide|Insert|Theme|Layout)$/ })).toHaveCount(0);
  await expect(page.getByTestId('initiative-deck-reader-position')).toHaveText('Slide 1 of 7');
  const image = page.getByTestId('initiative-deck-reader-stage').locator('img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const dock = page.getByTestId('deck-composer-dock');
  await expect(dock).toBeVisible();
  const message = dock.getByRole('textbox', { name: 'Presentation message', exact: true });
  await expect(message).toBeEditable();
  await page.getByRole('button', { name: 'Chat & agent', exact: true }).click();
  await expect(message).toBeFocused();
  const draft = 'A read-only presentation question draft survives navigation.';
  await message.fill(draft);
  await page.getByTestId('initiative-deck-reader-viewport').press('ArrowRight');
  await expect(page.getByTestId('initiative-deck-reader-position')).toHaveText('Slide 2 of 7');
  await expect(message).toHaveText(draft);
  await chooseOption(page.getByRole('combobox', { name: 'Slide zoom' }), '100');
  await expect(message).toHaveText(draft);
  await chooseOption(page.getByRole('combobox', { name: 'Slide zoom' }), 'fit');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(message).toHaveText(draft);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const present = page.getByTestId('initiative-deck-reader-present');
  await expect(present).toBeVisible();
  await expect(page.getByTestId('initiative-deck-reader-present-position')).toHaveText('Slide 2 of 7');
  await present.press('ArrowRight');
  await expect(page.getByTestId('initiative-deck-reader-present-position')).toHaveText('Slide 3 of 7');
  const presentingImage = page.getByTestId('initiative-deck-reader-present-stage').locator('img');
  await expect(presentingImage).toBeVisible();
  await expect.poll(() => presentingImage.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const presentingBounds = await page.getByTestId('initiative-deck-reader-present-stage').boundingBox();
  await page.screenshot({ path: test.info().outputPath('work-member-deck-present.png') });
  await page.getByRole('button', { name: 'Exit presentation', exact: true }).click();
  await expect(page.getByTestId('initiative-deck-reader-position')).toHaveText('Slide 3 of 7');
  await expect(message).toHaveText(draft);
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Chat & agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(message).toBeFocused();
  await expect(message).toHaveText(draft);
  await expect(page.getByTestId('initiative-deck-reader-position')).toHaveText('Slide 3 of 7');
  await page.getByTestId('initiative-deck-reader-filmstrip-select-summary').click();
  await expect(page.getByTestId('initiative-deck-reader-position')).toHaveText('Slide 2 of 7');
  const notes = page.getByTestId('initiative-deck-reader-notes');
  await expect(notes).toHaveAttribute('readonly', '');
  await expect(notes).not.toBeEditable();
  const originalNotes = await notes.inputValue();
  await notes.focus(); await notes.press('End'); await page.keyboard.type('This must not edit a saved note.');
  await expect(notes).toHaveValue(originalNotes);
  const ask = 'Explain the next validation step for this slide without changing it.';
  const response = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/agents/orgiq-supervisor/invoke');
  await message.fill(ask); await message.press('Enter');
  const result = await response;
  expect(result.status()).toBe(200);
  expect(await result.text()).toContain('RUN_FINISHED');
  await expect(page.getByTestId('deck-assistant-pane')).toBeVisible();
  await expect(page.getByTestId('initiative-agent-panel')).toContainText('Presentation assistant');
  await expect(page.getByTestId('initiative-agent-panel')).toContainText('Complete');
  await expect(page.getByTestId('initiative-agent-panel')).toContainText('Waiting on the dependency map.');
  await expect(page).toHaveURL(new RegExp(`/iq/decks/${deckId}(?:\\?|$)`));
  await expect(message).toHaveText('');
  expect(questions).toHaveLength(1);
  expect(questions[0].message).toContain(`Visible saved version: ${before.activeRevisionId}`);
  expect(questions[0].message).toContain('Scope: selected slide summary');
  expect(questions[0].message).toContain('Observability: validation next');
  expect(questions[0].selection).toEqual({ records: [{ type: 'initiative', id: 'p-observability' }] });
  await evidence('member-presentation-question-sse', 'member-presentation-question.sse', await result.text(), 'text/plain');
  const divider = page.getByTestId('shell-split-divider');
  await expect(divider).toBeVisible();
  const dividerBefore = await divider.boundingBox();
  const secondaryBefore = await page.getByTestId('shell-split-secondary').boundingBox();
  expect(dividerBefore).toBeTruthy(); expect(secondaryBefore).toBeTruthy();
  const dividerX = dividerBefore!.x + dividerBefore!.width / 2;
  const dividerY = dividerBefore!.y + dividerBefore!.height / 2;
  await page.mouse.move(dividerX, dividerY); await page.mouse.down();
  await page.mouse.move(dividerX - 180, dividerY, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => (await page.getByTestId('shell-split-secondary').boundingBox())!.width - secondaryBefore!.width).toBeGreaterThan(32);
  const secondaryResized = await page.getByTestId('shell-split-secondary').boundingBox();
  const dividerResized = await divider.boundingBox();
  await page.mouse.move(dividerResized!.x + dividerResized!.width / 2, dividerY); await page.mouse.down();
  await page.mouse.move(dividerX, dividerY, { steps: 4 }); await page.mouse.up();
  // Restore a usable workspace through the native bounded gesture. An
  // initially auto-fit pane can be narrower than its later drag minimum.
  await expect.poll(async () => (await page.getByTestId('shell-split-secondary').boundingBox())!.width).toBeLessThanOrEqual(500);
  await expect.poll(async () => secondaryResized!.width - (await page.getByTestId('shell-split-secondary').boundingBox())!.width).toBeGreaterThan(32);
  const secondaryRestored = await page.getByTestId('shell-split-secondary').boundingBox();
  await expect.poll(async () => (await page.getByTestId('initiative-deck-reader-stage').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(400);
  const canvas = await page.getByTestId('initiative-deck-reader-stage').boundingBox();
  expect(canvas).toBeTruthy(); expect(Math.abs(canvas!.width / canvas!.height - 16 / 9)).toBeLessThan(0.02);
  const composer = await dock.boundingBox();
  expect(composer).toBeTruthy(); expect(composer!.y + composer!.height).toBeLessThanOrEqual(901);
  await page.screenshot({ path: test.info().outputPath('work-member-deck-wide.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  // The native shell collapses its pane on a compact breakpoint. A new
  // question must reveal the same assistant at this width, above the dock.
  await page.getByRole('button', { name: 'Chat & agent', exact: true }).click();
  await expect(message).toBeFocused();
  await dock.getByRole('button', { name: /^Remove .* from this draft$/ }).click();
  const unscoped = 'Answer this read-only question without attached presentation context.';
  const plainResponse = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/agents/orgiq-supervisor/invoke');
  await message.fill(unscoped); await message.press('Enter');
  const plain = await plainResponse;
  expect(plain.status()).toBe(200); expect(await plain.text()).toContain('RUN_FINISHED');
  await expect(page.getByTestId('initiative-agent-panel')).toContainText('Complete');
  await expect(page).toHaveURL(new RegExp(`/iq/decks/${deckId}(?:\\?|$)`));
  expect(questions).toHaveLength(2);
  expect(questions[1].message).toBe(unscoped); expect(questions[1].selection).toBeUndefined();
  const compactDraft = 'Keep this question draft while returning to the slides.';
  await message.fill(compactDraft);
  await expect(page.getByTestId('deck-assistant-pane')).toBeVisible();
  await expect.poll(async () => {
    const pane = await page.getByTestId('deck-assistant-pane').boundingBox();
    return pane?.height ?? 0;
  }).toBeGreaterThanOrEqual(200);
  await expect.poll(async () => {
    const pane = await page.getByTestId('deck-assistant-pane').boundingBox();
    const inputDock = await dock.boundingBox();
    return pane && inputDock ? pane.y + pane.height - inputDock.y : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(1);
  const compactAssistant = await page.getByTestId('deck-assistant-pane').boundingBox();
  const compactStageWithAssistant = await page.getByTestId('initiative-deck-reader-stage').boundingBox();
  await page.screenshot({ path: test.info().outputPath('work-member-deck-compact-assistant.png') });
  await page.getByRole('button', { name: 'Collapse presentation assistant', exact: true }).click();
  await expect(page.getByTestId('deck-assistant-pane')).not.toBeVisible();
  await expect(message).toHaveText(compactDraft);
  await expect.poll(async () => (await page.getByTestId('initiative-deck-reader-stage').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(400);
  const compactStage = await page.getByTestId('initiative-deck-reader-stage').boundingBox();
  expect(compactStage).toBeTruthy(); expect(compactStage!.width).toBeGreaterThanOrEqual(400);
  const compactNotes = await notes.boundingBox();
  expect(compactNotes).toBeTruthy(); expect(compactNotes!.y).toBeGreaterThanOrEqual(0);
  expect(compactNotes!.y + compactNotes!.height).toBeLessThanOrEqual(769);
  const compactInput = await message.boundingBox();
  expect(compactInput).toBeTruthy(); expect(compactInput!.y + compactInput!.height).toBeLessThanOrEqual(769);
  const compact = await dock.boundingBox();
  expect(compact).toBeTruthy(); expect(compact!.y + compact!.height).toBeLessThanOrEqual(769);
  await page.screenshot({ path: test.info().outputPath('work-member-deck-compact.png') });
  // Explicitly asking to focus chat may reveal the native assistant again;
  // the back-to-slides screenshot above records the collapsed viewing state.
  await page.getByRole('button', { name: 'Chat & agent', exact: true }).click();
  await expect(message).toBeFocused();
  await expect(message).toHaveText(compactDraft);
  await expect(page.getByTestId('deck-assistant-pane')).toBeVisible();
  const shelf = page.locator('.deck-composer-backdrop');
  const card = dock.getByTestId('deck-composer');
  await expect(card).toBeVisible();
  await expect.poll(async () => {
    const outer = await shelf.boundingBox();
    const inner = [await card.boundingBox(), await message.boundingBox()];
    return !!outer && inner.every(rect => !!rect && rect.x >= outer.x && rect.x + rect.width <= outer.x + outer.width);
  }).toBe(true);
  const focusedHorizontal = { shelf: await shelf.boundingBox(), card: await card.boundingBox(), input: await message.boundingBox() };
  await evidence('member-presentation-layout', 'layout-geometry.json', JSON.stringify({
    present: { slide: '3 of 7', stage: presentingBounds, imageDecoded: true },
    wide: { viewport: { width: 1440, height: 900 }, stage: canvas, composer,
      nativeDivider: { before: secondaryBefore, resized: secondaryResized, restored: secondaryRestored,
        nativeDragRatioReservePx: 480, dividerWidthPx: dividerBefore!.width,
        initialAutoFitCanBeNarrower: true } },
    compact: { viewport: { width: 1024, height: 768 }, assistant: compactAssistant, stageWithAssistant: compactStageWithAssistant,
      stageAfterCollapse: compactStage, notes: compactNotes, input: compactInput, composer: compact,
      focusedHorizontal },
  }, null, 2), 'application/json');
  const afterResponse = await page.request.get(`/api/initiative-decks/${deckId}`);
  expect(afterResponse.status()).toBe(200);
  const after = await afterResponse.json();
  expect(after.activeRevisionId).toBe(before.activeRevisionId);
  expect(after.revisions).toEqual(before.revisions);
  expect(documentWrites).toEqual([]); expect(errors).toEqual([]);
  const authority = { sub: principal.sub, tenant: principal.tenant, role: principal.role };
  await evidence('member-presentation-questions', 'member-presentation-questions.json', JSON.stringify({
    authority, url: page.url(), configuredAgentRuntime: 'local mock',
    questions: [{ request: questions[0], status: result.status(), responseBody: await result.text() },
      { request: questions[1], status: plain.status(), responseBody: await plain.text() }],
  }, null, 2), 'application/json');
  const head = (value: typeof before) => ({ deckId, activeRevisionId: value.activeRevisionId,
    revisions: value.revisions.map((revision: { id: string; seq?: number; label?: string; createdAt?: string }) => ({
      id: revision.id, seq: revision.seq, label: revision.label, createdAt: revision.createdAt,
    })) });
  await evidence('member-original-v7-head-preservation', 'original-head-preservation.json', JSON.stringify({
    authority, before: head(before), after: head(after), fullRevisionMetadataEqual: true, documentWrites, errors,
  }, null, 2), 'application/json');
});
