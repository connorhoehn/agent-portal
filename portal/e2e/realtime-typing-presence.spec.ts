import { chooseComposerMode } from './conversationViews';
import { signIn } from './realSession';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Realtime parity gaps 1 and 2 (docs/audit-loop/realtime-parity.md): the
// composer publishes typing on the chat channel and the peer sees the banner,
// which clears when the draft is emptied; a pipelines run announces presence.
// Two real sessions per tenant against the shared app (BFF gateway on /ws).
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

type Person = { page: Page; context: BrowserContext };
const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close())); });

async function person(browser: Browser, baseURL: string | undefined, userId: string, url: string, ready: (p: Page) => Promise<void>): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/');
  await signIn(page, userId);
  await page.goto(url);
  await ready(page);
  return { page, context };
}

/** `composer`: the composer input's test id; typing for the peer is judged from the other page's banner. */
async function typingRoundTrip(writer: Page, reader: Page, composer: string) {
  const input = writer.getByTestId(composer);
  await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
  await input.click();
  await writer.keyboard.type('typing probe');
  await expect(reader.getByTestId('typing-indicator')).toBeVisible({ timeout: 15_000 });
  await writer.keyboard.press('Control+A');
  await writer.keyboard.press('Backspace');
  await expect(reader.getByTestId('typing-indicator')).toHaveCount(0, { timeout: 15_000 });
}

test('pipelines run: peer sees typing, it clears, and both users announce presence', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const boot = await browser.newContext({ baseURL }); contexts.push(boot);
  const bp = await boot.newPage(); await bp.goto('/');
  await signIn(bp, 'u-kofi');
  const runs = (await (await bp.request.get('/api/pipelines/runs')).json()).runs as Array<{ id: string }>;
  const url = `/pipelines/runs/${encodeURIComponent(runs[0]!.id)}`;
  const ready = async (p: Page) => { await expect(p.getByTestId('pipeline-discussion-panel-composer-input')).toBeVisible({ timeout: 20_000 }); };
  const kofi = await person(browser, baseURL, 'u-kofi', url, ready);
  const ines = await person(browser, baseURL, 'u-ines', url, ready);
  await expect(kofi.page.getByTestId('presence-avatar').first()).toBeVisible({ timeout: 15_000 });
  await expect(ines.page.getByTestId('presence-avatar').first()).toBeVisible({ timeout: 15_000 });
  await typingRoundTrip(kofi.page, ines.page, 'pipeline-discussion-panel-composer-input');
});

test('orgiq initiative discussion: peer sees typing and it clears', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const url = '/iq/projects/p-auth-migration?tab=work&item=wi-auth-e2-b3&view=comments';
  // The pane is the thread; the one input is the work item's composer in the content column (2.438.3),
  // which announces typing while a Chat draft addressed to this Discussion has words.
  const composer = (p: Page) => p.getByTestId('initiative-workspace').getByTestId('initiative-composer');
  const ready = async (p: Page) => { await expect(composer(p).getByTestId('rich-chat-composer-input')).toBeVisible({ timeout: 20_000 }); await expect(p.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 }); };
  const nora = await person(browser, baseURL, 'u-nora', url, ready);
  const mia = await person(browser, baseURL, 'u-mia', url, ready);
  await chooseComposerMode(nora.page, composer(nora.page), 'Agent', 'Chat');
  await composer(nora.page).getByTestId('rich-chat-composer-input').click();
  await nora.page.keyboard.press('ControlOrMeta+a'); await nora.page.keyboard.press('Backspace');
  await typingRoundTrip(nora.page, mia.page, 'rich-chat-composer-input');
});

test('assessment document chat: peer sees typing and it clears', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const url = `/assessment/workspace?doc=${encodeURIComponent('page:100002')}`;
  const ready = async (p: Page) => {
    await expect(p.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
    if (!(await p.getByTestId('document-chat-panel').isVisible())) await p.getByTestId('context-column-panel-chat').click();
    await expect(p.getByTestId('document-chat-composer-input')).toBeVisible({ timeout: 20_000 });
  };
  const farah = await person(browser, baseURL, 'u-farah', url, ready);
  const jonas = await person(browser, baseURL, 'u-jonas', url, ready);
  await typingRoundTrip(farah.page, jonas.page, 'document-chat-composer-input');
});

test('assessment document page composer: peer sees typing in the thread-only pane and it clears', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const url = `/assessment/workspace?doc=${encodeURIComponent('page:100002')}`;
  const ready = async (p: Page) => {
    await expect(p.getByTestId('page-composer-input')).toBeVisible({ timeout: 20_000 });
    if (!(await p.getByTestId('document-chat-panel').isVisible())) await p.getByTestId('context-column-panel-chat').click();
    await expect(p.getByTestId('document-chat-panel')).toBeVisible({ timeout: 20_000 });
  };
  const farah = await person(browser, baseURL, 'u-farah', url, ready);
  const jonas = await person(browser, baseURL, 'u-jonas', url, ready);
  // Chat mode first: the dock opens in Agent mode for editors.
  const dock = farah.page.getByTestId('page-composer-dock');
  await dock.getByRole('button', { name: 'Agent', exact: true }).click();
  await dock.getByRole('button', { name: 'Composer mode: Agent' }).click();
  await farah.page.getByRole('menu', { name: 'Composer mode: Agent' }).getByRole('menuitem', { name: 'Chat', exact: true }).click();
  await typingRoundTrip(farah.page, jonas.page, 'page-composer-input');
});

test('social channel: peer sees typing and it clears', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const ready = async (p: Page) => { await expect(p.getByTestId('social-chat-composer-input')).toBeEditable({ timeout: 20_000 }); };
  const mira = await person(browser, baseURL, 'u-mira', '/social/channels/general', ready);
  const sana = await person(browser, baseURL, 'u-sana', '/social/channels/general', ready);
  await typingRoundTrip(mira.page, sana.page, 'social-chat-composer-input');
});
