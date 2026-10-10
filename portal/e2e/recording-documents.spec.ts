import { test, expect, type Page } from '@playwright/test';
import { conversationChannelForDoc } from '../src/pages/assessment/knowledge/knowledgeFormat';
import { documentCallLobby } from '../src/pages/assessment/knowledge/documentCommentsModel';
test.use({ baseURL: 'http://127.0.0.1:5283' });
const sourceId = 'ec:architecture/source/with/a/long/exact/identity';
const lobby = documentCallLobby('assessment:', conversationChannelForDoc(sourceId));
interface Data { actor: string; mode: 'awaiting' | 'ready' | 'partial'; denied?: boolean; sourceDenied?: boolean; context?: 'wrong' | 'missing'; requests: string[]; holdTranscript?: Promise<void> }
const state = (options: Partial<Data> = {}): Data => ({ actor: 'fixture-reader', mode: 'ready', requests: [], ...options });
const row = (data: Data) => ({ recordingId: 'recording-exact', callId: 'call-exact', lobbyName: lobby,
  startedAt: '2026-10-10T12:00:00Z', endedAt: '2026-10-10T12:02:00Z', durationMs: 120000, composeStatus: 'ok', transcriptionRequested: true,
  transcriptStatus: data.mode === 'awaiting' ? undefined : 'ready', summaryStatus: data.mode === 'ready' ? 'ready' : data.mode === 'partial' ? 'failed' : undefined,
  ...(data.context === 'missing' ? {} : { artifactContext: { tenant: 'assessment', documentSourceId: data.context === 'wrong' ? 'different-source' : sourceId } }),
  processingAttemptId: 'attempt-exact', participants: [{ userId: data.actor, displayName: 'Fixture Reviewer' }] });
async function mount(page: Page, data: Data, detail = false, family = 'workspace') {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    (window as unknown as { deviceRequests: number }).deviceRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { (window as unknown as { deviceRequests: number }).deviceRequests++; throw new Error('Device capture is prohibited in this fixture.'); };
  });
  await page.route('**/src/lib/conversationCall.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: "export * from '/e2e/fixtures/recording-runtime.tsx';" }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname; data.requests.push(`${request.method()} ${path}`);
    if (path === '/api/session/me') return route.fulfill({ json: { sub: data.actor, name: 'Fixture Reviewer', tenant: 'assessment', role: 'member', grants: { assessment: ['member'] }, switchable: { assessment: ['member'] }, availableRoles: ['member'], availableTenants: ['assessment'], masquerading: null } });
    if (path === '/api/session/realtime-token') return route.fulfill({ json: { token: `inert-${data.actor}`, expiresAt: '2099-10-10T12:00:00Z', platformApiUrl: 'http://127.0.0.1:5283/fixture-platform' } });
    if (path === '/api/people/shared') return route.fulfill({ json: { me: { userId: data.actor, displayName: 'Fixture Reviewer' }, people: [] } });
    if (path === '/api/assessment/knowledge/doc') return route.fulfill(data.sourceDenied ? { status: 403, json: { error: 'Document read denied' } } : { json: { id: url.searchParams.get('id'), title: 'Document architecture review', markdown: '# Architecture', classification: 'general', editable: false, path: '', updated_at: '' } });
    if (path === '/api/assessment/knowledge/doc/workflows/comments') return route.fulfill({ json: { documentId: sourceId, comments: [], import: { state: 'none', legacy: 0, imported: 0 } } });
    if (path === '/api/assessment/knowledge/doc/reactions') return route.fulfill({ json: { reactions: [] } });
    if (path === '/api/assessment/knowledge/doc/proposals') return route.fulfill({ json: { documentId: sourceId, proposals: [], canEdit: false } });
    if (path === '/api/assessment/recordings/search') {
      expect(url.searchParams.get('documentSourceId')).toBe(sourceId); expect(url.searchParams.has('teamId')).toBe(false);
      return route.fulfill({ json: { query: url.searchParams.get('q'), results: [{ id: 'recording-exact', type: 'recording', title: 'Document architecture review', description: 'Retain exact source provenance', href: `/assessment/${family}?${new URLSearchParams({ doc: sourceId, tab: 'recordings', recording: 'recording-exact' })}` }], total: 1, counts: { all: 1, recording: 1 } } });
    }
    if (path === '/fixture-platform/api/recordings') return route.fulfill({ json: { items: [row(data)], cursor: null } });
    if (path === '/fixture-platform/api/recordings/recording-exact') return route.fulfill(data.denied ? { status: 403, json: { error: 'Not a participant' } } : { json: row(data) });
    if (path.endsWith('/playback-token')) return route.fulfill({ json: { mediaState: 'unavailable' } });
    if (path.endsWith('/transcript')) { const actor = data.actor; if (data.holdTranscript) await data.holdTranscript; return route.fulfill({ json: { segments: [{ id: 'segment-exact', text: `Exact source transcript for ${actor}.`, startMs: 1000, endMs: 8000 }] } }); }
    if (path.endsWith('/summary')) return route.fulfill({ headers: { 'X-Summary-Status': data.mode === 'partial' ? 'failed' : 'ready' }, contentType: 'text/markdown', body: data.mode === 'partial' ? 'Internal placeholder' : '## Decision\n\nRetain exact source provenance.' });
    if (path.endsWith('/api/video/reactions')) return route.fulfill({ json: { reactions: [] } });
    return route.fulfill({ status: 503, json: { error: 'Unmocked fixture request denied' } });
  });
  await page.route('**/assessment/' + family + '?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/recording-documents.tsx"></script></body></html>` }));
  await page.goto(`/assessment/${family}?${new URLSearchParams({ doc: sourceId, tab: 'recordings', ...(detail ? { recording: 'recording-exact' } : {}) })}`);
  await expect(page.getByTestId('fixture-actor')).toHaveText(data.actor);
  return errors;
}
test('document postcall status retains hashed source and routes to independent transcript and summary attachments', async ({ page }) => {
  await page.clock.install(); const data = state({ mode: 'awaiting' }), errors = await mount(page, data, false, 'enterprise');
  await expect(page.getByTestId('document-tab-recordings')).toContainText('Waiting for transcription');
  await page.getByRole('button', { name: 'Show joined fixture call' }).click(); await page.getByRole('button', { name: 'End and clear native host' }).click();
  const status = page.getByTestId('postcall-recording'); await expect(status).toContainText('Waiting for transcription');
  data.mode = 'partial'; await page.clock.runFor(6000);
  await expect(status).toContainText('Summary failed'); await status.getByRole('button', { name: 'View recording', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('recording=recording-exact');
  const route = new URL(await page.getByTestId('fixture-route').textContent() ?? '', 'https://local.invalid');
  expect(route.pathname).toBe('/assessment/enterprise'); expect(route.searchParams.get('doc')).toBe(sourceId); expect(route.searchParams.get('recording')).toBe('recording-exact');
  await expect(page.getByTestId('recording-transcript-attachment')).toContainText('Exact source transcript');
  await expect(page.getByTestId('recording-summary-attachment')).toContainText('The summary could not be created.');
  await expect(page.getByText('Internal placeholder')).toHaveCount(0);
  expect(data.requests.filter(path => path.includes('/canvas'))).toEqual([]);
  expect(data.requests.filter(path => /^(POST|PUT|PATCH|DELETE)/.test(path) && !path.endsWith('/playback-token'))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { deviceRequests: number }).deviceRequests)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('document-recording-partial.png'), fullPage: true }); expect(errors).toEqual([]);
});
test('document recording search uses source authority and opens its exact saved detail', async ({ page }) => {
  const data = state(), errors = await mount(page, data);
  await page.getByRole('textbox', { name: 'Search recording content' }).fill('source provenance');
  await expect(page.getByTestId('recording-content-results')).toContainText('Retain exact source provenance');
  await page.getByTestId('recording-content-results').getByText('Document architecture review', { exact: true }).click();
  await expect(page.getByTestId('recording-summary-attachment')).toContainText('Retain exact source provenance');
  await expect(page.getByTestId('fixture-route')).toContainText('recording=recording-exact');
  expect(data.requests.some(path => path.includes('/canvas'))).toBe(false); expect(errors).toEqual([]);
});
test('missing or wrong canonical document context refuses every artifact despite a matching hashed lobby', async ({ page }) => {
  for (const context of ['missing', 'wrong'] as const) {
    const data = state({ context }), errors = await mount(page, data, true);
    await expect(page.getByTestId('initiative-recording-detail')).toContainText('could not be associated with this exact source document');
    expect(data.requests.some(path => /\/(transcript|summary|playback-token)$/.test(path))).toBe(false);
    await expect(page.getByTestId('recording-transcript-attachment')).toHaveCount(0); expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: 'wait' });
  }
});
test('source denial prevents its native recording index and actor change hides a late transcript', async ({ page }) => {
  const denied = state({ sourceDenied: true }), errors = await mount(page, denied, true);
  await expect(page.getByTestId('document-tab-recordings')).toContainText('This source could not be read');
  expect(denied.requests.some(path => path.includes('/fixture-platform/api/recordings'))).toBe(false); expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
  let release!: () => void; const data = state({ holdTranscript: new Promise<void>(r => { release = r; }) }), nextErrors = await mount(page, data, true);
  await expect.poll(() => data.requests.filter(path => path.endsWith('/transcript')).length).toBeGreaterThan(0);
  data.actor = 'fixture-other'; data.denied = true; data.holdTranscript = undefined; await page.getByRole('button', { name: 'Refresh fixture identity' }).click();
  await expect(page.getByTestId('fixture-actor')).toHaveText('fixture-other'); release();
  await expect(page.getByTestId('initiative-recording-detail')).toContainText('not available to your account');
  await expect(page.getByText('Exact source transcript for fixture-reader.')).toHaveCount(0); expect(nextErrors).toEqual([]);
});
