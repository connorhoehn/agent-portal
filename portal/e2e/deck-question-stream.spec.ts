import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { presentationQuestionPreview } from '../../middleware/src/mock/presentation-question';
import type { PresentationQuestionContext } from '../../middleware/src/lib/presentation-context';
test.use({ baseURL: 'http://127.0.0.1:5263', viewport: { width: 1280, height: 800 } });
test('actual deck hook sends selected version/slide and displays scoped answer receipts without unrelated context or writes', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [], forbidden: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path !== '/api/agents/orgiq-supervisor/invoke') { forbidden.push(path); await route.fulfill({ status: 409, json: { error: 'Inert fixture forbids API calls.' } }); return; }
    const body = route.request().postDataJSON(); bodies.push(body);
    const ctx = body.presentationContext;
    const fixture = await page.evaluate(() => (window as any).__deckQuestionStream);
    expect(ctx).toMatchObject({ kind: 'initiative-deck', deckId: fixture.deck.id, revisionId: 'irev-fixture-v7', scope: 'slide' });
    expect(body).not.toHaveProperty('selection'); expect(body.message).toBe('Summarize this slide');
    const slide = fixture.spec.slides.find((value: { id: string }) => value.id === ctx.slideId);
    const context: PresentationQuestionContext = { kind: 'initiative-deck', deckId: fixture.deck.id, revisionId: ctx.revisionId, title: fixture.deck.title,
      scope: 'slide', slideId: ctx.slideId, provenance: 'saved-revision', content: { title: fixture.deck.title, slides: [slide] }, href: '/iq/decks/idk-fixture-question' };
    const response = presentationQuestionPreview(context)!;
    const { content: _content, ...reference } = context;
    const events = [
      { type: 'RUN_STARTED', threadId: 'owned-fixture-session', runId: `fixture-${bodies.length}` },
      { type: 'TOOL_CALL_START', toolCallId: 'context', toolCallName: 'presentation_context' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'context', delta: JSON.stringify(ctx) },
      { type: 'TOOL_CALL_END', toolCallId: 'context' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'context', content: JSON.stringify({ ...reference, slideTitles: [slide.title] }) },
      { type: 'TEXT_MESSAGE_START', messageId: `answer-${bodies.length}`, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: `answer-${bodies.length}`, delta: response.response },
      { type: 'TEXT_MESSAGE_END', messageId: `answer-${bodies.length}` }, { type: 'RUN_FINISHED' },
    ];
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.route('**/src/lib/auth.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `export function useSession(){return {session:window.__deckReviewRuntimeExports.runtime.session};} export function SessionProvider({children}){return children;}` }));
  await page.route('**/src/lib/capabilities.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `export function useCapabilities(){return {ready:true,can:(action)=>action==='Search'};}` }));
  await page.route('**/src/lib/conversationCall.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `export const useCallHost=(...args)=>window.__deckReviewRuntimeExports.calls.useCallHost(...args); export const useCallBlock=(...args)=>window.__deckReviewRuntimeExports.calls.useCallBlock(...args); export const useCallBlockPageClaimed=(...args)=>window.__deckReviewRuntimeExports.calls.useCallBlockPageClaimed(...args); export const useCallMediaPanel=(...args)=>window.__deckReviewRuntimeExports.calls.useCallMediaPanel(...args); export const useClaimCallBlock=(...args)=>window.__deckReviewRuntimeExports.calls.useClaimCallBlock(...args); export const CallBlock=(...args)=>window.__deckReviewRuntimeExports.calls.CallBlock(...args); export const callDrawn=()=>false;` }));
  await page.route('**/src/lib/gatewayFrames.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `export function useGatewayFrames(){return window.__deckReviewRuntimeExports.runtime.frames;}` }));
  await page.route('**/__deck-question-stream*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/deck-question-stream.tsx"></script></body></html>` }));
  await page.goto('/__deck-question-stream?pane=agent');
  await expect(page.getByTestId('question-stream-reader-position')).toHaveText('Slide 1 of 2');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(page.getByTestId('question-stream-reader-position')).toHaveText('Slide 2 of 2');
  const dock = page.getByTestId('deck-composer-dock'), panel = page.getByTestId('initiative-agent-panel');
  const input = dock.getByRole('textbox', { name: 'Presentation message', exact: true });
  await input.fill('Summarize this slide'); await dock.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('presentation-read-receipt')).toContainText('Sprints · irev-fixture-v7');
  await expect(panel).toContainText('Delivered: 18 · 5'); await expect(panel).toContainText('Validate span metrics before decommissioning.');
  await expect(panel).not.toContainText('summary-only figure'); await expect(panel).not.toContainText('ORG-OBS-');
  await expect(panel).toContainText('Offline presentation preview');
  await expect(panel).toContainText('Complete');
  await expect(page.getByTestId('question-stream-reader-stage').getByRole('img')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('selected-sprints-answer.png') });
  await page.getByRole('button', { name: 'Previous slide', exact: true }).click();
  await input.fill('Summarize this slide'); await dock.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('presentation-read-receipt')).toHaveCount(2);
  await expect(panel.getByText('Observability review fixture › Sprints · v7', { exact: true })).toBeVisible();
  await expect(panel.getByText('Observability review fixture › Summary · v7', { exact: true }).last()).toBeVisible();
  expect(bodies.map(body => (body.presentationContext as { slideId: string }).slideId)).toEqual(['sprints', 'summary']);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
  const fixture = await page.evaluate(() => (window as any).__deckQuestionStream);
  expect(fixture.proof.writes).toBe(0); expect(fixture.proof.head).toBe('irev-fixture-v7'); expect(JSON.stringify(fixture.spec)).toBe(fixture.proof.initialSpec);
  await page.screenshot({ path: test.info().outputPath('retained-two-slide-history.png') });
  await writeFile(test.info().outputPath('verification.json'), JSON.stringify({ bodies, forbidden, errors, writes: fixture.proof.writes,
    headUnchanged: true, contextHistoryRetained: true, selectedSlideReceipts: true, scope: 'Actual shared hook/composer/native stream and pane with inert saved deck + isolated intercepted SSE built by the actual offline preview helper. No live agent/deck/message/call APIs.' }, null, 2));
});
