import { test, expect, type Page } from '@playwright/test';

// The judge's browser half for docs/assessment-documents-parity-goal.md.
// Runs against a stack whose middleware can mint document grants — start it
// with `node scripts/social-documents.mjs up` and `npm run dev:mock:social`
// (docs/social-calls-local-stack.md) — and point PARITY_BASE_URL at its
// portal when that is not :5183. Without the document env the pane is the
// reader fallback, and this spec fails on purpose: it is measuring the editor.
//
// u-farah lands in the assessment tenant as lead-assessor (ManageKnowledge),
// so no tenant or role switch — and no session-epoch bump — is needed.

const OUT = '../docs/design/documents-parity';
const DOC = 'page:100002';
// The page's canvas — the composer dock under it is a ProseMirror too.
const CANVAS = '.ProseMirror:not(.chat-composer-input)';
// Fake camera/microphone for the in-document call (worker-scoped, so file-level).
test.use({ viewport: { width: 1672, height: 941 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}),
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

async function signIn(page: Page, userId = 'u-farah') {
  await page.goto('/');
  const status = await page.evaluate(async (id) => (await fetch('/api/session/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ userId: id }),
  })).status, userId);
  expect(status, 'demo login').toBe(200);
}

/** The cookie-less demo persona (not in the picker): into the assessment tenant, optionally as another of its roles. */
async function signInAsDemo(page: Page, role?: string) {
  await page.goto('/');
  const post = (path: string, body: object) => page.evaluate(async ({ path, body }) => (await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
  })).status, { path, body });
  expect(await post('/api/session/tenant', { tenant: 'assessment' }), 'demo tenant switch').toBe(200);
  if (role) expect(await post('/api/session/role', { role }), `demo role ${role}`).toBe(200);
  const me = await page.evaluate(async () => (await fetch('/api/session/me', { credentials: 'include' })).json());
  expect(me.sub, 'the demo persona').toBe('demo-user');
}

const PROMPT = 'prompt:classify-transcript.md';

/** Types two characters into body text (never a heading — a heading anchor
 * takes the click) and deletes them, then waits until the page reads exactly
 * as it did: the edit exists only to start the draft. */
async function typeAndUndo(page: Page, target: ReturnType<Page['locator']>) {
  const canvas = page.locator(CANVAS);
  const before = await canvas.innerText();
  await target.click();
  await page.keyboard.type('xy');
  await expect.poll(async () => (await canvas.innerText()) !== before).toBe(true);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => await canvas.innerText(), { message: 'the typed characters are removed again' }).toBe(before);
}
const FALLBACK = 'Document collaboration is unavailable';

test('assessment workspace page opens in the shared document editor frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);

  const shell = page.getByTestId('document-shell');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Document collaboration is unavailable')).toHaveCount(0);
  for (const name of ['Editor', 'Comments', 'Versions', 'History', 'Reviews']) {
    await expect(shell.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${OUT}/parity-journey-reader.png` });

  // Editing by default (decision 7): a synced page is editable on open — no
  // Edit draft step — with the toolbar card and ruler; the first change starts
  // its draft. The edit is typed and removed again, so the page is unchanged.
  await expect(shell.getByRole('button', { name: /^(Edit draft|Edit document|Done editing)$/ })).toHaveCount(0);
  await expect(page.locator(`${CANVAS}[contenteditable="true"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('canvas-document-toolbar')).toBeVisible();
  await expect(page.getByTestId('canvas-document-ruler-row')).toBeVisible();
  const chip = page.getByTestId('document-draft-chip');
  await expect(chip).not.toHaveText('Local draft');
  await typeAndUndo(page, page.locator(CANVAS).getByText('Claimed level', { exact: true }));
  await expect(chip).toHaveText('Local draft');
  await page.screenshot({ path: `${OUT}/parity-journey-edit-draft.png` });

  // Versions is docked in its tab (VersionHistoryPanel docked), not a slide-out over the window.
  await shell.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByTestId('document-tab-versions').getByTestId('document-versions')).toBeVisible();
  await expect(shell.getByRole('tab', { name: /^Versions/ })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(400); // the tab underline and head buttons settle their transitions
  await page.screenshot({ path: `${OUT}/parity-journey-versions.png` });

  for (const tab of ['Comments', 'History', 'Reviews']) {
    await shell.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await expect(page.getByTestId(`document-tab-${tab.toLowerCase()}`)).toBeVisible();
    await page.screenshot({ path: `${OUT}/parity-journey-${tab.toLowerCase()}.png` });
  }
  expect(errors, 'page errors').toEqual([]);
});

// Decision 6: one editor frame on every document page, for every signed-in
// user — the demo persona included. A reader (the demo user lands as
// assessor) gets the canvas and the ruler, read-only; the library draws the
// formatting toolbar only for an editable canvas. The same persona as
// lead-assessor gets the toolbar and edits the prompt through its draft.
test('a prompt page opens in the canvas frame for the demo user, never the reader fallback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signInAsDemo(page);
  await page.goto(`/assessment/prompts?doc=${encodeURIComponent(PROMPT)}`);
  const shell = page.getByTestId('document-shell');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('canvas-document-ruler-row')).toBeVisible();
  await expect(page.getByText(FALLBACK)).toHaveCount(0);
  await expect(page.locator(`${CANVAS}[contenteditable="false"]`)).toBeVisible();
  await page.screenshot({ path: `${OUT}/parity-journey-prompt-demo-reader.png` });

  await signInAsDemo(page, 'lead-assessor');
  await page.goto(`/assessment/prompts?doc=${encodeURIComponent(PROMPT)}`);
  await expect(page.locator(`${CANVAS}[contenteditable="true"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('canvas-document-toolbar')).toBeVisible();
  await expect(page.getByTestId('canvas-document-ruler-row')).toBeVisible();
  await expect(page.getByText(FALLBACK)).toHaveCount(0);
  await expect(shell.getByRole('button', { name: /^(Edit draft|Edit document)$/ })).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/parity-journey-prompt-demo-editor.png` });
  // The first change starts the prompt's draft; it is typed and removed again.
  await typeAndUndo(page, page.locator(CANVAS).getByText('If a required key is missing', { exact: false }));
  await expect(page.getByTestId('document-draft-chip')).toHaveText('Local draft');
  // Rename stays refused for prompts.
  const rename = await page.evaluate(async (id) => (await fetch('/api/assessment/knowledge/doc/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id, title: 'Renamed' }),
  })).status, PROMPT);
  expect(rename, 'prompt rename is refused').toBe(409);
  expect(errors, 'page errors').toEqual([]);
});

// Phases 3–4 (gaps 7, 9, 10): the reference's rail, list page and composer dock.
test('the rail, the All documents list and the document conversation match the reference', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
  const shell = page.getByTestId('document-shell');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });

  // "DOCUMENTS n", the three views, sources as folders on the rail-scale tree.
  const frame = page.getByTestId('knowledge-explorer');
  await expect(frame.getByText(/^Documents$/i).first()).toBeVisible();
  const views = page.getByTestId('document-rail-views');
  for (const name of ['All documents', 'Recent', 'Shared with me']) await expect(views.getByText(name, { exact: true })).toBeVisible();
  const tree = page.getByTestId('document-rail-tree');
  await expect(tree.getByTestId('document-rail-tree-row-section:confluence-eng')).toBeVisible();
  await expect(tree.getByTestId(`document-rail-tree-row-${DOC}`)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('section-pull-confluence-eng').or(tree.getByTestId('document-rail-tree-row-section:confluence-eng'))).toBeVisible();

  // The composer dock: the document chip, the conversation placeholder, Send.
  const dock = page.getByTestId('page-composer-dock');
  await expect(dock).toBeVisible();
  await expect(dock.getByText('Rubric Overview')).toBeVisible();
  // Agent is the default mode (decision 8); Chat is one pick away.
  await dock.getByRole('button', { name: 'Agent', exact: true }).click();
  await dock.getByRole('button', { name: 'Composer mode: Agent' }).click();
  await page.getByRole('menu', { name: 'Composer mode: Agent' }).getByRole('menuitem', { name: 'Chat', exact: true }).click();
  // The placeholder is the editor's empty paragraph, drawn from its data-placeholder.
  await expect(dock.locator('[data-placeholder="Message this document’s conversation…"]')).toHaveCount(1);
  await page.screenshot({ path: `${OUT}/parity-journey-rail-dock.png` });

  // A message goes to the document's conversation on the BFF gateway and comes back in the Chat panel.
  const note = `Parity check ${Date.now()}`;
  await page.getByTestId('page-composer-input').click();
  await page.keyboard.type(note);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('document-chat-panel').getByText(note)).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/parity-journey-chat.png` });

  // Recent and Shared with me swap the tree for their own list.
  await views.getByText('Recent', { exact: true }).click();
  await expect(page.getByTestId('document-rail-recent')).toBeVisible();
  await views.getByText('Shared with me', { exact: true }).click();
  await expect(page.getByTestId('document-rail-shared-empty')).toBeVisible();

  // All documents: PageHeader + Upload + New ▾, search + filter, result rows.
  await views.getByText('All documents', { exact: true }).click();
  const list = page.getByTestId('document-list-page');
  await expect(list).toBeVisible();
  await expect(list.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await expect(page.getByTestId('document-upload')).toBeVisible();
  await expect(page.getByTestId('new-document-btn')).toBeVisible();
  await expect(list.getByRole('button', { name: /Filter documents/ })).toBeVisible();
  const rows = page.getByTestId('document-result-list');
  await expect(rows.getByText('Rubric Overview')).toBeVisible();
  await list.getByRole('searchbox', { name: 'Search documents' }).or(list.getByRole('textbox', { name: 'Search documents' })).first().fill('faq');
  await expect(page.getByTestId('document-result-count')).toHaveText('1 result');
  await page.screenshot({ path: `${OUT}/parity-journey-list.png` });
  expect(errors, 'page errors').toEqual([]);
});

// Phase 4 (gaps 4, 7, 8): platform-api comment threads, the byline from canvas
// awareness, and the in-document call — two people on one page. u-jonas lands
// as assessor (read + comment, no edit); u-farah as lead-assessor.
test.describe('two people on one document', () => {
  test('comments on platform-api threads, participants in the byline, and a call rung from the document', async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const people = await Promise.all(['u-farah', 'u-jonas'].map(async userId => {
      const context = await browser.newContext({ viewport: { width: 1672, height: 941 }, baseURL, permissions: ['camera', 'microphone'] });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await signIn(page, userId);
      await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
      await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });
      return { page, errors, context };
    }));
    const [farah, jonas] = people as [typeof people[0], typeof people[0]];
    const farahShell = farah.page.getByTestId('document-shell');
    const jonasShell = jonas.page.getByTestId('document-shell');

    // The byline: each sees the other from the canvas's awareness.
    await expect(farahShell.getByTestId('presence-avatar').and(farahShell.getByLabel('Jonas Lindqvist'))).toBeVisible({ timeout: 15_000 });
    await expect(jonasShell.getByTestId('presence-avatar').and(jonasShell.getByLabel('Farah Osei'))).toBeVisible({ timeout: 15_000 });
    await farah.page.screenshot({ path: `${OUT}/parity-journey-byline.png` });

    // The imported thread: the legacy Aurora comment keeps its author, words and reply.
    await farahShell.getByRole('tab', { name: /^Comments/ }).click();
    const tab = farah.page.getByTestId('document-comments');
    const imported = tab.getByTestId('document-comment-thread-kc-rubric-01');
    await expect(imported.getByText('Jonas Lindqvist').first()).toBeVisible();
    await expect(imported.getByText(/The "Partially met" band needs an example/)).toBeVisible();
    await expect(imported.getByText(/release-gate example from the payments review/)).toBeVisible();

    // A document-wide comment from Farah reaches Jonas's Comments tab.
    const whole = `Whole-document check ${Date.now()}`;
    await tab.getByRole('textbox', { name: 'Comment on the whole document' }).fill(whole);
    await tab.getByRole('button', { name: 'Post' }).click();
    await expect(tab.getByText(whole)).toBeVisible();
    await jonasShell.getByRole('tab', { name: /^Comments/ }).click();
    await expect(jonas.page.getByTestId('document-comments').getByText(whole)).toBeVisible({ timeout: 20_000 });
    await farah.page.screenshot({ path: `${OUT}/parity-journey-comments-threads.png` });

    // Jonas (a reader) comments on a selection: the anchor pins it to the text, both see the mark and the margin card.
    await jonasShell.getByRole('tab', { name: /^Editor/ }).click();
    await farahShell.getByRole('tab', { name: /^Editor/ }).click();
    await jonas.page.locator(CANVAS).getByText('Claimed level', { exact: true }).click({ clickCount: 3 });
    const commentButton = jonas.page.getByTestId('canvas-comment-button');
    await expect(commentButton).toBeEnabled();
    await commentButton.click();
    const pinned = `Pinned check ${Date.now()}`;
    const composer = jonas.page.getByTestId('canvas-comment-composer');
    await composer.getByRole('textbox', { name: 'Comment' }).fill(pinned);
    await composer.getByRole('button', { name: 'Comment' }).click();
    await expect(jonas.page.getByText(pinned)).toBeVisible();
    await expect(farah.page.getByText(pinned)).toBeVisible({ timeout: 20_000 });
    await expect(farah.page.locator(`${CANVAS} .canvas-comment`).first()).toBeVisible();
    await farah.page.screenshot({ path: `${OUT}/parity-journey-comments-anchored.png` });

    // It is a platform-api thread with an anchor, through the BFF (never a browser-held platform credential).
    const pinnedId = await farah.page.evaluate(async ({ doc, text }) => {
      const body = await (await fetch(`/api/assessment/knowledge/doc/workflows/comments?id=${encodeURIComponent(doc)}`, { credentials: 'include' })).json();
      const row = body.comments.find((c: { text: string }) => c.text === text);
      return row && row.anchor && row.userId === 'u-jonas' ? row.commentId as string : null;
    }, { doc: DOC, text: pinned });
    expect(pinnedId, 'the pinned comment is stored anchored, authored by Jonas').toBeTruthy();

    // Resolve it from Farah's Comments tab; Jonas's tab shows the resolved banner.
    await farahShell.getByRole('tab', { name: /^Comments/ }).click();
    await farah.page.getByTestId(`document-comment-thread-${pinnedId}`).getByRole('button', { name: /Resolve/ }).click();
    await expect(farah.page.getByTestId(`document-comment-thread-${pinnedId}`).getByTestId('comment-resolved-banner')).toBeVisible();
    await jonasShell.getByRole('tab', { name: /^Comments/ }).click();
    await expect(jonas.page.getByTestId(`document-comment-thread-${pinnedId}`).getByTestId('comment-resolved-banner')).toBeVisible({ timeout: 20_000 });
    await jonasShell.getByRole('tab', { name: /^Editor/ }).click();
    await farahShell.getByRole('tab', { name: /^Editor/ }).click();

    // The call: Farah rings the people on the page; Jonas accepts; both have the docked call.
    await farahShell.getByRole('button', { name: /^Call$/ }).click();
    const notice = farah.page.getByTestId('document-call-notice');
    const toast = jonas.page.getByTestId('incoming-call-toast');
    await expect.poll(async () => await toast.isVisible() || await notice.isVisible(), { timeout: 20_000 }).toBe(true);
    // A stack without platform-api / the realtime gateway says why on Call; the call half cannot run there.
    if (await notice.isVisible()) test.skip(true, `Calls are not configured on this stack: ${await notice.innerText()}`);
    await expect(toast).toContainText('Farah Osei is calling');
    await jonas.page.getByTestId('incoming-call-accept').click();
    await expect(jonas.page.getByTestId('document-call-slot')).toBeVisible({ timeout: 20_000 });
    await expect(farah.page.getByTestId('document-call-slot')).toBeVisible({ timeout: 20_000 });
    await expect(farahShell.getByRole('button', { name: 'Leave call' })).toBeVisible();
    await expect(jonas.page.getByTestId('document-call-slot')).toContainText('2 people', { timeout: 20_000 });
    await jonas.page.screenshot({ path: `${OUT}/parity-journey-call.png` });
    // Leave: Jonas first, then Farah (the call may end for whoever is left alone).
    await jonasShell.getByRole('button', { name: 'Leave call' }).click({ timeout: 5_000 });
    await farahShell.getByRole('button', { name: 'Leave call' }).click({ timeout: 5_000 }).catch(() => undefined);
    await expect(jonasShell.getByRole('button', { name: /^Call$/ })).toBeVisible({ timeout: 10_000 });

    for (const person of people) {
      expect(person.errors, 'page errors').toEqual([]);
      await person.context.close();
    }
  });
});

// Decision 8: Agent mode is the dock's default. An instruction goes to the
// assessment drafter with the page as context; `dev:mock` streams the
// drafter's canned edit envelope (middleware/src/mock/document-agent-edits.ts),
// which comes back as a proposal in the library ProposedEditStrip. Apply writes
// it into the canvas at the caret; the edit is then undone so the shared page
// reads as it did.
// A role that may only read (u-asha, assessor) is not offered Agent mode: the
// dock opens in Chat and the agent placeholder never renders (assessment
// journeys defect #17 — a reader used to get a real drafter run and an Apply
// that refused only after the click).
test('a reader gets the dock in Chat, with Agent mode off', async ({ page }) => {
  await signIn(page, 'u-asha');
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${CANVAS}[contenteditable="true"]`)).toHaveCount(0);
  const dock = page.getByTestId('page-composer-dock');
  await expect(dock).toBeVisible();
  await expect(dock.locator('[data-placeholder^="Message this document"]')).toHaveCount(1);
  await expect(dock.locator('[data-placeholder^="Ask the drafter"]')).toHaveCount(0);
  await expect(page.getByTestId('document-agent-edit')).toHaveCount(0);
});

test('an agent-mode instruction lands in the canvas as a proposed edit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
  const canvas = page.locator(CANVAS);
  await expect(page.locator(`${CANVAS}[contenteditable="true"]`)).toBeVisible({ timeout: 20_000 });

  const dock = page.getByTestId('page-composer-dock');
  await expect(dock.locator('[data-placeholder^="Ask the drafter to edit this page"]')).toHaveCount(1);

  // The caret at the end of the first body paragraph; nothing selected.
  await canvas.locator('p').first().click();
  await page.keyboard.press('End');
  const before = await canvas.innerText();

  await page.getByTestId('page-composer-input').click();
  await page.keyboard.type('Add a next step about practice owners');
  await page.keyboard.press('Enter');

  const strip = page.getByTestId('document-agent-edit');
  await expect(strip).toBeVisible({ timeout: 10_000 });
  await expect(strip.getByTestId('document-agent-edit-placement')).toHaveText('Insert at cursor');
  const apply = strip.getByTestId('document-agent-edit-apply');
  await expect(apply).toBeEnabled({ timeout: 20_000 });
  await expect(strip.getByTestId('document-agent-edit-preview')).toContainText('confirm an owner for each practice');
  await page.screenshot({ path: `${OUT}/parity-journey-agent-proposal.png` });

  await apply.click();
  await expect(canvas).toContainText('Next step: confirm an owner for each practice before the scoring window opens.');
  await expect(strip.getByTestId('document-agent-edit-applied')).toBeVisible();
  await page.screenshot({ path: `${OUT}/parity-journey-agent-applied.png` });

  // Undo the applied edit (the editor has focus after Apply).
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => await canvas.innerText(), { message: 'the applied edit is undone' }).toBe(before);
  expect(errors, 'page errors').toEqual([]);
});
