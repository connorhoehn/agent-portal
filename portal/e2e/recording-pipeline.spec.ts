import { test, expect, type Page } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:5283', viewport: { width: 1280, height: 900 } });
type Mode = 'awaiting' | 'transcribing' | 'summarizing' | 'partial' | 'ready' | 'unknown';
interface FixtureState { actor: string; tenant: 'orgiq' | 'assessment'; exact: boolean; mode: Mode; denied?: boolean; holdTranscript?: Promise<void>; holdDetail?: Promise<void>; holdSearch?: Promise<void>; searchDenied?: boolean; searchPartial?: boolean; requests: string[]; media?: boolean }
const session = (state: FixtureState) => ({ sub: state.actor, name: 'Fixture Reviewer', tenant: state.tenant, role: 'member', grants: { [state.tenant]: ['member'] }, switchable: { [state.tenant]: ['member'] }, availableRoles: ['member'], availableTenants: [state.tenant], masquerading: null });
function row(state: FixtureState, id = 'recording-exact') {
  const transcriptStatus = state.mode === 'awaiting' ? undefined : state.mode === 'transcribing' ? 'processing' : 'ready';
  return { recordingId: id, callId: id === 'recording-exact' ? 'call-exact' : 'call-neighbour', lobbyName: state.tenant === 'assessment' ? 'assessment:team:TEAM-005' : 'orgiq:initiative:p-observability',
    startedAt: '2026-10-10T12:00:00Z', endedAt: '2026-10-10T12:02:00Z', durationMs: 120000, composeStatus: 'ok', transcriptionRequested: true, transcriptStatus,
    summaryStatus: state.mode === 'summarizing' || state.mode === 'unknown' ? 'processing' : state.mode === 'ready' ? 'ready' : state.mode === 'partial' ? 'failed' : undefined,
    processingAttemptId: 'attempt-exact', summaryRunId: 'summary-run-exact', participants: [{ userId: state.actor, displayName: 'Fixture Reviewer' }] };
}
async function mount(page: Page, state: FixtureState, query = '') {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  // Substitute only the call host reader; the production monitor and the
  // actual native host fixture share the same inert provider instance.
  await page.route('**/src/lib/conversationCall.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: "export { useCallHost } from '/e2e/fixtures/recording-runtime.tsx';" }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname; state.requests.push(`${request.method()} ${path}`);
    if (path === '/api/session/me') return route.fulfill({ json: session(state) });
    if (path === '/api/session/realtime-token') return route.fulfill({ json: { token: `inert-${state.actor}`, expiresAt: '2099-10-10T12:00:00Z', platformApiUrl: 'http://127.0.0.1:5283/fixture-platform' } });
    if (path === '/api/assessment/recordings/search') {
      const actor = state.actor, query = url.searchParams.get('q');
      if (state.holdSearch) await state.holdSearch;
      if (state.searchDenied) return route.fulfill({ status: 403, json: { error: 'Assessment team is not accessible' } });
      if (url.searchParams.get('teamId') !== 'TEAM-005' || state.tenant !== 'assessment') return route.fulfill({ status: 400, json: { error: 'Wrong recording search scope' } });
      return route.fulfill({ json: { query, results: [{ id: 'recording-exact', type: 'recording', title: 'Notifications review', description: `Saved summary for ${actor}: ${query}`, subtitle: 'Notifications Service', href: '/assessment/teams/TEAM-005?tab=documents&recording=recording-exact' }], total: 1, counts: { all: 1, recording: 1 }, ...(state.searchPartial ? { totalIsLowerBound: true, partial: ['recordings'] } : {}) } });
    }
    if (path === '/api/initiative-decks') return route.fulfill({ json: [] });
    if (path === '/api/people/shared') return route.fulfill({ json: { me: { userId: state.actor, displayName: 'Fixture Reviewer' }, people: [] } });
    if (path === '/fixture-platform/api/recordings') return route.fulfill({ json: { items: [row(state, 'recording-neighbour'), ...(state.exact ? [row(state)] : [])], cursor: null } });
    if (path === '/fixture-platform/api/recordings/recording-exact') { if (state.holdDetail) await state.holdDetail; return route.fulfill(state.denied ? { status: 403, json: { error: 'Not a participant' } } : { json: row(state) }); }
    if (path.endsWith('/playback-token') && request.method() === 'POST') return route.fulfill({ json: state.media ? { mediaState: 'playable', composedUrl: 'http://127.0.0.1:5283/e2e/fixtures/assets/recording-preview.mp4' } : { mediaState: 'unavailable' } });
    if (path.endsWith('/transcript')) {
      const actor = state.actor;
      if (state.holdTranscript) await state.holdTranscript;
      if (state.mode === 'awaiting' || state.mode === 'transcribing') return route.fulfill({ status: 202, headers: { 'Retry-After': '5' }, json: { status: 'processing', terminal: false, retryAfterMs: 5000 } });
      return route.fulfill({ json: { segments: [{ id: 'segment-1', speakerId: actor, speakerLabel: 'Reviewer', text: `Exact saved transcript for ${actor}: validate the rollback window.`, startMs: 1000, endMs: 8000 }] } });
    }
    if (path.endsWith('/summary')) {
      if (state.mode === 'ready') return route.fulfill({ contentType: 'text/markdown', headers: { 'X-Summary-Status': 'ready' }, body: '## Decisions\n\nValidate the rollback window before launch.' });
      if (state.mode === 'partial') return route.fulfill({ headers: { 'X-Summary-Status': 'failed' }, body: 'Internal failure placeholder must never render as a successful summary.' });
      return route.fulfill({ status: 202, headers: { 'Retry-After': '5' }, json: { status: state.mode === 'unknown' ? 'unavailable' : 'processing', terminal: state.mode === 'unknown', retryAfterMs: state.mode === 'unknown' ? null : 5000, error: state.mode === 'unknown' ? 'Summary status clock is unavailable' : null } });
    }
    if (path.endsWith('/api/video/reactions')) return route.fulfill({ json: { reactions: [] } });
    return route.fulfill({ status: 503, json: { error: 'Unmocked fixture API request denied' } });
  });
  await page.route('**/__recording-pipeline**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/recording-pipeline.tsx"></script></body></html>` }));
  await page.goto('/__recording-pipeline' + query);
  await expect(page.getByTestId('fixture-actor')).toHaveText(state.actor);
  return errors;
}
function state(overrides: Partial<FixtureState> = {}): FixtureState { return { actor: 'fixture-reader', tenant: 'orgiq', exact: false, mode: 'awaiting', requests: [], ...overrides }; }

test('native ended-host clears safely, resolves only its exact call, and shows independent attachments', async ({ page }) => {
  await page.clock.install(); const data = state({ media: true }); const errors = await mount(page, data);
  await page.getByRole('button', { name: 'Show joined fixture call' }).click();
  await expect(page.getByTestId('fixture-phase')).toHaveText('live');
  await page.getByRole('button', { name: 'End and clear native host' }).click();
  const status = page.getByTestId('postcall-recording');
  await expect(status).toContainText('Waiting for the recording from this call');
  await page.clock.runFor(6000);
  await expect(status).not.toContainText('Recording ready');
  expect(data.requests.some(path => path.includes('/recording-neighbour/'))).toBe(false);
  data.exact = true; await page.clock.runFor(6000);
  await expect(status).toContainText('Waiting for transcription');
  data.mode = 'transcribing'; await page.clock.runFor(6000); await expect(status).toContainText('Creating transcript');
  data.mode = 'summarizing'; await page.clock.runFor(6000); await expect(status).toContainText('Creating summary');
  data.mode = 'partial'; await page.clock.runFor(6000); await expect(status).toContainText('Video and transcript ready · Summary failed');
  await status.getByRole('button', { name: 'View recording', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('/iq/projects/p-observability?tab=docs&recording=recording-exact');
  await expect(page.getByTestId('recording-transcript-attachment')).toContainText('Exact saved transcript for fixture-reader');
  await expect(page.getByTestId('recording-transcript-attachment').getByText('Reviewer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('recording-summary-attachment')).toContainText('The summary could not be created.');
  await expect(page.getByTestId('initiative-recording-activity')).toContainText('Fixture Reviewer');
  await expect(page.getByTestId('initiative-recording-video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Internal failure placeholder')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('recording-partial-failure.png'), fullPage: true });
  data.mode = 'ready'; await page.getByRole('button', { name: 'Refresh recording' }).click();
  await expect(page.getByTestId('recording-summary-attachment')).toContainText('Validate the rollback window before launch.');
  expect(await page.getByRole('button', { name: 'Refresh recording' }).evaluate(node => getComputedStyle(node).fontSize)).toBe('12px');
  expect(await page.getByRole('button', { name: 'Back to docs & recordings' }).evaluate(node => getComputedStyle(node).fontSize)).toBe('12px');
  await page.screenshot({ path: test.info().outputPath('recording-attachments-ready.png'), fullPage: true });
  expect(errors).toEqual([]);
  expect(data.requests.filter(path => /^(POST|PUT|PATCH|DELETE)/.test(path) && !path.endsWith('/playback-token'))).toEqual([]);
});

test('unknown progress terminates with manual refresh and Assessment exact file routing', async ({ page }) => {
  const data = state({ tenant: 'assessment', exact: true, mode: 'unknown' }); const errors = await mount(page, data, '?recording=recording-exact');
  await expect(page.getByTestId('recording-transcript-attachment')).toContainText('Exact saved transcript');
  await expect(page.getByTestId('recording-summary-attachment')).toContainText('Summary processing could not be verified.');
  await page.setViewportSize({ width: 640, height: 960 });
  await page.screenshot({ path: test.info().outputPath('assessment-recording-compact.png') });
  await expect(page.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show joined fixture call' }).click();
  await page.getByRole('button', { name: 'End and clear native host' }).click();
  await page.getByTestId('postcall-recording').getByRole('button', { name: 'View recording', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('/assessment/teams/TEAM-005?tab=documents&recording=recording-exact');
  expect(errors).toEqual([]);
});

test('nonparticipant detail denial prevents every artifact read', async ({ page }) => {
  const data = state({ exact: true, mode: 'ready', denied: true }); const errors = await mount(page, data, '?recording=recording-exact');
  await expect(page.getByTestId('initiative-recording-detail')).toContainText('not available to your account');
  await expect(page.getByTestId('recording-transcript-attachment')).toHaveCount(0);
  expect(data.requests.some(path => /\/(transcript|summary|playback-token)$/.test(path))).toBe(false);
  expect(errors).toEqual([]);
});

test('late artifact receipt cannot reveal a previous signed actor after session change', async ({ page }) => {
  let resolve!: () => void; const hold = new Promise<void>(r => { resolve = r; });
  const data = state({ exact: true, mode: 'ready', holdTranscript: hold }); const errors = await mount(page, data, '?recording=recording-exact');
  await expect.poll(() => data.requests.filter(path => path.endsWith('/transcript')).length).toBeGreaterThan(0);
  data.actor = 'fixture-other'; data.denied = true; data.holdTranscript = undefined;
  await page.getByRole('button', { name: 'Refresh fixture identity' }).click();
  await expect(page.getByTestId('fixture-actor')).toHaveText('fixture-other'); resolve();
  await expect(page.getByTestId('initiative-recording-detail')).toContainText('not available to your account');
  await expect(page.getByText(/Exact saved transcript for fixture-reader/)).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('unresolved exact association has a finite wait and explicit retry without a nearby substitute', async ({ page }) => {
  await page.clock.install(); const data = state(); const errors = await mount(page, data);
  await page.getByRole('button', { name: 'Show joined fixture call' }).click();
  await page.getByRole('button', { name: 'End and clear native host' }).click();
  const status = page.getByTestId('postcall-recording');
  await expect(status).toContainText('Waiting for the recording');
  await page.clock.runFor(20 * 60_000 + 6_000);
  await expect(status).toContainText('No exact recording association is ready.');
  const stoppedAt = data.requests.filter(path => path === 'GET /fixture-platform/api/recordings').length;
  await page.clock.runFor(15_000);
  expect(data.requests.filter(path => path === 'GET /fixture-platform/api/recordings').length).toBe(stoppedAt);
  data.exact = true; data.mode = 'ready';
  await status.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toContainText('Recording, transcript and summary ready');
  expect(errors).toEqual([]);
});


test('project file cards refresh native processing status without rereading unrelated documents', async ({ page }) => {
  await page.clock.install(); const data = state({ exact: true, mode: 'awaiting' }); const errors = await mount(page, data, '?files=1');
  const files = page.getByTestId('initiative-files');
  await expect(files).toContainText('Waiting for transcription');
  await expect(files).not.toContainText('could not be read');
  const decksReads = data.requests.filter(path => path === 'GET /api/initiative-decks').length;
  data.mode = 'summarizing'; await page.clock.runFor(6000);
  await expect(files).toContainText('Creating summary');
  data.mode = 'partial'; await page.clock.runFor(6000);
  await expect(files).toContainText('Summary failed');
  expect(data.requests.filter(path => path === 'GET /api/initiative-decks').length).toBe(decksReads);
  await page.screenshot({ path: test.info().outputPath('project-files-live-processing.png') });
  expect(errors).toEqual([]);
});


test('an initial hung native metadata read ends its spinner and permits explicit retry', async ({ page }) => {
  await page.clock.install(); let resolve!: () => void;
  const data = state({ exact: true, mode: 'ready', holdDetail: new Promise<void>(r => { resolve = r; }) }); const errors = await mount(page, data, '?recording=recording-exact');
  const detail = page.getByTestId('initiative-recording-detail');
  await expect(detail).toContainText('Opening the recording');
  await page.clock.runFor(20 * 60_000 + 6_000);
  await expect(detail).toContainText('The recording could not be checked yet.');
  await expect(detail.getByText('Opening the recording…', { exact: true })).toHaveCount(0);
  data.holdDetail = undefined; resolve();
  await page.getByRole('button', { name: 'Refresh recording' }).click();
  await expect(page.getByTestId('recording-transcript-attachment')).toContainText('Exact saved transcript');
  expect(errors).toEqual([]);
});


test('unconfirmed native binding is retained only in optional postcall details, without a live-call banner', async ({ page }) => {
  const data = state(); const errors = await mount(page, data, '?binding=unavailable');
  await page.getByRole('button', { name: 'Show joined fixture call' }).click();
  await expect(page.getByTestId('postcall-recording')).toHaveCount(0);
  await page.getByRole('button', { name: 'End and clear native host' }).click();
  const status = page.getByTestId('postcall-recording');
  await expect(status).toContainText('Waiting for the recording from this call');
  await expect(status).not.toContainText('could not confirm its recording association');
  await status.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(status).toContainText('The native call could not confirm its recording association.');
  await expect(status).toContainText('No other call has been substituted.');
  expect(errors).toEqual([]);
});

test('media failure and recovery do not announce that an active call ended', async ({ page }) => {
  const data = state({ exact: true, mode: 'ready' });
  const errors = await mount(page, data);
  await page.getByRole('button', { name: 'Show joined fixture call' }).click();
  await expect(page.getByTestId('fixture-phase')).toHaveText('live');
  await page.getByRole('button', { name: 'Fail media while call remains active' }).click();
  await expect(page.getByTestId('fixture-phase')).toHaveText('failed');
  await expect(page.getByTestId('postcall-recording')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reconnect active call' }).click();
  await expect(page.getByTestId('fixture-phase')).toHaveText('reconnecting');
  await expect(page.getByTestId('postcall-recording')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show joined fixture call' }).click();
  await expect(page.getByTestId('fixture-phase')).toHaveText('live');
  await expect(page.getByTestId('postcall-recording')).toHaveCount(0);
  await page.getByRole('button', { name: 'End and clear native host' }).click();
  await expect(page.getByTestId('postcall-recording')).toContainText('Recording, transcript and summary ready');
  expect(errors).toEqual([]);
});

test('Assessment searches saved recording content in team scope and opens the exact recording', async ({ page }) => {
  const data = state({ tenant: 'assessment', exact: true, mode: 'ready', searchPartial: true });
  const errors = await mount(page, data);
  await page.getByRole('textbox', { name: 'Search recording content' }).fill('rollback window');
  const results = page.getByTestId('recording-content-results');
  await expect(results).toContainText('Saved summary for fixture-reader: rollback window');
  await expect(results).toContainText('These results may be incomplete');
  await results.getByText('Notifications review', { exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toHaveText('/assessment/teams/TEAM-005?tab=documents&recording=recording-exact');
  await expect(page.getByTestId('recording-summary-attachment')).toContainText('Validate the rollback window');
  expect(data.requests.some(value => value.includes('/api/search'))).toBe(false);
  expect(errors).toEqual([]);
});

test('Assessment recording search drops an in-flight response when the signed-in actor changes', async ({ page }) => {
  let release!: () => void;
  const data = state({ tenant: 'assessment', exact: true, mode: 'ready', holdSearch: new Promise<void>(resolve => { release = resolve; }) });
  await mount(page, data);
  await page.getByRole('textbox', { name: 'Search recording content' }).fill('private phrase');
  await expect.poll(() => data.requests.some(value => value.includes('/api/assessment/recordings/search'))).toBe(true);
  data.actor = 'replacement-reader'; data.holdSearch = undefined; data.searchDenied = true;
  await page.getByRole('button', { name: 'Refresh fixture identity' }).click();
  await expect(page.getByTestId('fixture-actor')).toHaveText('replacement-reader');
  release();
  await expect(page.getByRole('textbox', { name: 'Search recording content' })).toHaveValue('');
  await expect(page.getByTestId('recording-content-results')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search recording content' }).fill('private phrase');
  await expect(page.getByTestId('recording-content-search')).toContainText('Recording content could not be searched');
  await expect(page.getByTestId('recording-content-search')).not.toContainText('Saved summary for fixture-reader');
});
