import { test, expect, type Page } from '@playwright/test';

const records = [
  { id: 'auth', type: 'initiative', title: 'Auth Migration', href: '/iq/initiatives/auth', status: 'in_progress', description: 'Move sign-in to a new origin.' },
  { id: 'vera', type: 'person', title: 'Vera Green', href: '/iq/people/vera', subtitle: 'Owner', description: 'Owns Auth Migration.' },
  { id: 'nora', type: 'person', title: 'Nora Chang', href: '/iq/people/nora', subtitle: 'SME', description: 'Coordinates the tenant cutover.' },
  { id: 'cutover', type: 'work', title: 'Tenant-by-tenant cutover', href: '/iq/work-items/cutover', status: 'blocked', subtitle: 'Nora Chang' },
  { id: 'sso', type: 'knowledge', title: 'Bring SSO up on a new origin', href: '/iq/distillation/knowledge?item=sso', status: 'published' },
];
const edges = [
  { id: 'owner', source: 'person:vera', target: 'initiative:auth', label: 'owns' },
  { id: 'sme', source: 'person:nora', target: 'initiative:auth', label: 'SME' },
  { id: 'work', source: 'initiative:auth', target: 'work:cutover', label: 'includes' },
  { id: 'assignment', source: 'person:nora', target: 'work:cutover', label: 'assigned to' },
];
const counts = { all: 5, person: 2, initiative: 1, work: 1, knowledge: 1, decision: 0, asset: 0 };
const question = 'Who can help finish Auth Migration?';
const assistantText = 'Start with Vera Green, the initiative owner [1], and Nora Chang for the blocked cutover [2].';
const evidence = [{ ...records[1], n: 1 }, { ...records[3], n: 2 }];

async function mockWorkspace(page: Page) {
  let saved: Record<string, unknown>[] = [];
  const submissions: Record<string, unknown>[] = [];
  const invocationURLs: string[] = [];
  await page.route('**/api/agents', route => route.fulfill({ json: { agents: [
    { id: 'orgiq-supervisor', name: 'Supervisor', status: 'READY', protocol: 'AG-UI', model: 'test', tools: [] },
    { id: 'orgiq-advisor', name: 'Advisor', status: 'READY', protocol: 'AG-UI', model: 'test', tools: [] },
  ] } }));
  await page.route('**/api/search?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const type = params.get('type') ?? 'all';
    const result = type === 'all' ? records : records.filter(record => record.type === type);
    return route.fulfill({ json: { query: params.get('q') ?? '', results: result, related: type === 'all' ? [] : records.filter(record => record.type !== type), counts, total: result.length, edges } });
  });
  await page.route('**/api/saved-searches**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const entry = { ...request.postDataJSON(), id: 'saved-auth' };
      saved = [entry];
      return route.fulfill({ status: 201, json: entry });
    }
    if (request.method() === 'DELETE') {
      saved = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { searches: saved } });
  });
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [
    { sessionId: 'search-history', actorId: 'me', createdAt: '2026-09-27T12:00:00Z', title: question },
  ] } }));
  await page.route('**/api/sessions/*/events', route => route.fulfill({ json: { events: [
    { eventId: 'q-history', role: 'USER', text: question },
    { eventId: 'a-history', role: 'ASSISTANT', text: assistantText, toolCalls: [{ id: 'context-history', name: 'search_context', result: JSON.stringify({ records: evidence }) }] },
  ] } }));
  await page.route('**/api/agents/*/invoke', route => {
    submissions.push(route.request().postDataJSON());
    invocationURLs.push(new URL(route.request().url()).pathname);
    const events = [
      { type: 'RUN_STARTED', threadId: 'search-stream-session', sessionId: 'search-stream-session', runId: 'search-run' },
      { type: 'TOOL_CALL_START', toolCallId: 'context-stream', toolCallName: 'search_context' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'context-stream', delta: '{}' },
      { type: 'TOOL_CALL_END', toolCallId: 'context-stream' },
      { type: 'TOOL_CALL_RESULT', messageId: 'context-result', toolCallId: 'context-stream', content: JSON.stringify({ records: evidence }) },
      { type: 'TEXT_MESSAGE_START', messageId: 'answer-stream', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer-stream', delta: assistantText },
      { type: 'TEXT_MESSAGE_END', messageId: 'answer-stream' },
      { type: 'RUN_FINISHED', threadId: 'search-stream-session', runId: 'search-run' },
    ];
    return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });
  return { submissions, invocationURLs };
}

test('Search views preserve query, draft, typed selection and graph layout', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}`);
  const rail = page.getByRole('navigation', { name: 'Search navigation' });
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('search-results')).toContainText('Auth Migration');
  const composer = page.getByTestId('search-composer').getByRole('textbox', { name: 'Search question' });
  await composer.fill('Keep this unsent follow-up');
  await page.getByLabel('Select Vera Green', { exact: true }).click();
  await expect(page.getByLabel('Select Vera Green', { exact: true })).toBeChecked();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  const node = page.getByRole('button', { name: 'Person: Vera Green', exact: true });
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  const other = page.getByRole('button', { name: 'Person: Nora Chang', exact: true });
  await other.focus();
  await page.keyboard.press('Space');
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('radio', { name: 'Radial', exact: true }).click();
  await expect(page).toHaveURL(/layout=radial/);
  await expect(composer).toHaveText('Keep this unsent follow-up');
  await page.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(composer).toHaveText('Keep this unsent follow-up');
  await page.getByRole('tab', { name: /^Results/ }).click();
  await expect(page.getByLabel('Select Nora Chang', { exact: true })).toBeChecked();
  expect(new URL(page.url()).searchParams.get('q')).toBe(question);
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Radial', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Person: Vera Green', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('selection is sent as typed context and answer evidence links remain available across views', async ({ page }) => {
  const { submissions } = await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&tab=connections&selection=person:vera,work:cutover`);
  await page.getByRole('button', { name: 'Ask about selection →', exact: true }).click();
  await page.getByTestId('search-composer').getByRole('textbox', { name: 'Search question' }).fill(question);
  await page.getByTestId('search-composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('search-evidence')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ message: question, selection: { records: [{ type: 'person', id: 'vera' }, { type: 'work', id: 'cutover' }] } });
  await expect(page.getByRole('log')).toContainText('Start with Vera Green');
  await expect(page.getByTestId('search-evidence').getByRole('link', { name: '[1] Vera Green', exact: true })).toHaveAttribute('href', '/iq/people/vera');
  await expect(page.getByRole('log').getByRole('link', { name: '1', exact: true })).toHaveAttribute('href', '/iq/people/vera');
  await page.getByRole('button', { name: 'View these connections →', exact: true }).click();
  await expect(page.getByTestId('search-connections')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('session')).toBe('search-stream-session');
  await page.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Start with Vera Green');
  expect(submissions).toHaveLength(1);
});

test('saved search restores query, scope and selection then can be removed', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&scope=auth&tab=connections&selection=person:vera`);
  await page.getByRole('button', { name: 'Save search', exact: true }).click();
  await page.getByLabel('Saved search name').fill('Auth migration owners');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const rail = page.getByRole('navigation', { name: 'Search navigation' });
  await expect(rail.getByRole('button', { name: 'Auth migration owners', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New search', exact: true }).click();
  await rail.getByRole('button', { name: 'Auth migration owners', exact: true }).click();
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('scope')).toBe('auth');
  await expect(page.getByRole('button', { name: 'Person: Vera Green', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Remove saved search', exact: true }).click();
  await expect(rail.getByRole('button', { name: 'Auth migration owners', exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('saved')).toBe(false);
});

test('legacy Ask and Explore deep links retain session, layout and identifiers', async ({ page }) => {
  const { submissions } = await mockWorkspace(page);
  await page.goto('/iq/invoke?session=search-history&extra=kept#source');
  await expect(page.getByRole('log')).toContainText('Start with Vera Green');
  let url = new URL(page.url());
  expect(url.pathname).toBe('/iq/search');
  expect(url.searchParams.get('session')).toBe('search-history');
  expect(url.searchParams.get('tab')).toBe('answer');
  expect(url.searchParams.get('extra')).toBe('kept');
  expect(url.hash).toBe('#source');
  await page.goto('/iq/explore?selected=vera,nora&layout=radial&entities=people&extra=kept#graph');
  await expect(page.getByTestId('search-connections')).toBeVisible();
  url = new URL(page.url());
  expect(url.pathname).toBe('/iq/search');
  expect(url.searchParams.get('selection')).toBe('person:vera,person:nora');
  expect(url.searchParams.get('layout')).toBe('radial');
  expect(url.searchParams.get('type')).toBe('person');
  expect(url.searchParams.get('extra')).toBe('kept');
  expect(url.hash).toBe('#graph');
  expect(submissions).toHaveLength(0);
});

test('rich composer uses supervisor automatically and supports explicit agent commands', async ({ page }) => {
  const { submissions, invocationURLs } = await mockWorkspace(page);
  await page.goto('/iq/search');
  const composer = page.getByTestId('search-composer');
  const editor = composer.getByRole('textbox', { name: 'Search question' });
  await expect(page.getByRole('combobox', { name: 'Search agent' })).toHaveCount(0);
  await editor.fill('Find the owner of Auth Migration');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('search-evidence')).toBeVisible();
  expect(invocationURLs[0]).toBe('/api/agents/orgiq-supervisor/invoke');
  await editor.fill('/agent');
  await page.getByRole('option', { name: /Ask a specific agent/ }).click();
  await editor.pressSequentially('Adv');
  await page.getByRole('option', { name: /Advisor/ }).click();
  await editor.pressSequentially('Find migration guides');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => invocationURLs.length).toBe(2);
  expect(invocationURLs[1]).toBe('/api/agents/orgiq-advisor/invoke');
  expect(submissions[1].message).toBe('Find migration guides');
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await editor.fill('Who should coordinate next?');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => invocationURLs.length).toBe(3);
  expect(invocationURLs[2]).toBe('/api/agents/orgiq-supervisor/invoke');
});

test('stacked Search menus and composer fit desktop and narrower layouts', async ({ page }) => {
  await mockWorkspace(page);
  for (const width of [1618, 1280]) {
    await page.setViewportSize({ width, height: 990 });
    await page.goto(`/iq/search?q=${encodeURIComponent(question)}&tab=connections&session=search-history&selection=person:vera,person:nora`);
    await expect(page.getByRole('button', { name: 'Person: Vera Green', exact: true })).toBeVisible();
    await expect(page.getByTestId('search-composer').getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
    // Current conversation and current record filter can both be active;
    // preserving ?session on filter links must not highlight every filter.
    await expect(page.getByRole('navigation', { name: 'Search navigation' }).locator('[aria-current="page"]')).toHaveCount(2);
    const rail = await page.getByRole('navigation', { name: 'Search navigation' }).boundingBox();
    const graph = await page.getByTestId('search-connections').boundingBox();
    expect(rail!.x + rail!.width).toBeLessThanOrEqual(graph!.x);
    expect(graph!.x + graph!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/search-connections-${width}.png`, animations: 'disabled' });
    await page.getByRole('tab', { name: 'Answer', exact: true }).click();
    await expect(page.getByTestId('search-evidence')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Answer', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: `/tmp/search-answer-${width}.png`, animations: 'disabled' });
  }
});
