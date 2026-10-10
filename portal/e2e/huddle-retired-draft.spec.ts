import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1280, height: 900 } });

test('ended and failed huddle drafts remain on their disabled original recipient without crossing calls or actors', async ({ page }) => {
  const writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 409, json: { error: 'Inert fixture does not call APIs.' } });
  });
  const source = (path: string) => `**/src/${path}*`;
  await page.route(source('lib/auth.tsx'), route => route.fulfill({ contentType: 'application/javascript', body:
    `export function useSession(){return {session:window.__retiredHuddleFixture?.session??null};} export function SessionProvider({children}){return children;}` }));
  await page.route(source('lib/conversationCall.tsx'), route => route.fulfill({ contentType: 'application/javascript', body:
    `export function useCallHost(){return window.__retiredHuddleFixture?.host??null;} export function useCallBlock(){return {block:null};} export function useCallBlockPageClaimed(){return false;} export function useCallMediaPanel(){return null;} export function useClaimCallBlock(){return false;} export function CallBlock(){return null;} export function callDrawn(){return false;}` }));
  await page.route(source('lib/gatewayFrames.ts'), route => route.fulfill({ contentType: 'application/javascript', body:
    `export function useGatewayFrames(){return window.__retiredHuddleFixture.frames;}` }));
  await page.route('**/__huddle-retired-draft', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/e2e/fixtures/huddle-retired-draft.tsx"></script></body></html>` }));
  await page.goto('/__huddle-retired-draft');
  const composer = page.getByTestId('retired-huddle-composer'), input = composer.getByTestId('rich-chat-composer-input');
  await expect(page.getByTestId('fixture-current-call')).toHaveText('call-one');
  await input.fill('Unsent original huddle inquiry');
  const node = await input.elementHandle();
  await page.getByRole('button', { name: 'Capture current draft callback', exact: true }).click();
  await composer.getByTestId('rich-chat-composer-send').click();
  await expect(input).toHaveText('Unsent original huddle inquiry');
  await page.getByRole('button', { name: 'End fixture call', exact: true }).click();
  await expect(page.getByTestId('fixture-current-call')).toBeEmpty();
  await expect(input).toHaveText('Unsent original huddle inquiry');
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();
  await page.getByRole('button', { name: 'Reject pending fixture receipt', exact: true }).click();
  await expect(input).toHaveText('Unsent original huddle inquiry');
  await page.getByRole('button', { name: 'Replace fixture call', exact: true }).click();
  await expect(input).toHaveText('Unsent original huddle inquiry');
  await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();
  await page.getByRole('button', { name: 'Select current fixture draft', exact: true }).click();
  await expect(input).toBeEmpty(); await input.fill('Unsent new huddle inquiry');
  await page.getByRole('button', { name: 'Run stale fixture callback', exact: true }).click();
  await expect(input).toHaveText('Unsent new huddle inquiry');
  await composer.getByTestId('rich-chat-composer-send').click();
  await page.getByRole('button', { name: 'Write newer fixture draft', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm pending fixture receipt', exact: true }).click();
  await expect(input).toHaveText('Newer draft survives late confirmation');
  await page.getByRole('button', { name: 'Fail fixture call', exact: true }).click();
  await expect(input).toHaveText('Newer draft survives late confirmation');
  await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();
  await expect(page.getByTestId('fixture-retired-call-ids')).toHaveText('call-one,call-two');
  await page.getByRole('button', { name: 'Select original fixture draft', exact: true }).click();
  await expect(input).toHaveText('Unsent original huddle inquiry');
  await page.getByRole('button', { name: 'Discard selected retired draft', exact: true }).click();
  await expect(input).toBeEmpty();
  await expect(page.getByTestId('fixture-retired-call-ids')).toHaveText('call-two');
  await page.getByRole('button', { name: 'Switch fixture actor', exact: true }).click();
  await expect(page.getByTestId('fixture-retired-call-ids')).toBeEmpty();
  await expect(input).toBeEmpty();
  await page.getByRole('button', { name: 'Switch fixture tenant', exact: true }).click();
  await expect(page.getByTestId('fixture-retired-call-ids')).toBeEmpty();
  expect(await page.evaluate(() => (window as any).__retiredHuddleFixture.sends)).toBe(2);
  expect(writes).toEqual([]); expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('retired-huddle-draft.png') });
  await writeFile(test.info().outputPath('verification.json'), JSON.stringify({ writes, errors, localRecipientCalls: 2, realSends: 0,
    actualDraftProvider: true, actualNativeEditor: true, editorRetainedThroughEnd: true,
    originalRecipientDisabled: true, replacementCallBlank: true, staleCallbackRefused: true,
    pendingEndRetained: true, lateConfirmationKeepsNewerDraft: true,
    scope: 'Explicit inert session/call/frame fixture only; no API requests, calls, media, chat or jobs.' }, null, 2));
});
