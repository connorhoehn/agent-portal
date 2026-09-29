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
  await page.route('**/api/graph/entities', route => route.fulfill({ json: {
    nodes: orgPeople, departments: [{ id: 'd-plat', name: 'Platform Engineering', color: '#3b82f6' }, { id: 'd-sec', name: 'Security', color: '#ef4444' }],
    edges: [{ source: 'vera', target: 'nora', type: 'collaborates', strength: 0.9 }, { source: 'nora', target: 'ben', type: 'mentors', strength: 0.8 }],
  } }));
  await page.route('**/api/graph/people/*', route => route.fulfill({ json: {
    id: 'vera', name: 'Vera Green', title: 'Staff Engineer', department: 'Platform Engineering', skills: ['OIDC'],
    influenceScore: 0.8, scoredAt: null, connections: [{ type: 'collaborates', strength: 0.9, otherPerson: { id: 'nora', name: 'Nora Chang', title: 'SME' } }],
  } }));
  await page.route('**/api/graph/people/*/evidence', route => route.fulfill({ json: { documents: [] } }));
  return { submissions, invocationURLs };
}

const orgPeople = [
  { id: 'vera', name: 'Vera Green', title: 'Staff Engineer', department: 'Platform Engineering', skills: ['OIDC', 'Cognito'], influenceScore: 0.8 },
  { id: 'nora', name: 'Nora Chang', title: 'Engineer', department: 'Platform Engineering', skills: ['SAML'], influenceScore: 0.6 },
  { id: 'ben', name: 'Ben Okafor', title: 'Security Lead', department: 'Security', skills: ['Threat modeling'], influenceScore: 0.5 },
];

test('Search views preserve query, draft, typed selection and graph layout', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}`);
  const rail = page.getByTestId('search-explorer-rail');
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('search-results')).toContainText('Auth Migration');
  const composer = page.getByTestId('search-composer').getByRole('textbox', { name: 'Search question' });
  await composer.fill('Keep this unsent follow-up');
  await page.getByLabel('Select Vera Green', { exact: true }).click();
  await expect(page.getByLabel('Select Vera Green', { exact: true })).toBeChecked();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  const node = page.getByRole('button', { name: 'Person: Vera Green', exact: true });
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  // Only the selection and what an edge connects to it are drawn: Nora has
  // no edge to Vera, so the neighbour to add is the initiative Vera owns.
  await expect(page.getByRole('button', { name: 'Person: Nora Chang', exact: true })).toHaveCount(0);
  const other = page.getByRole('button', { name: 'Initiative: Auth Migration, In progress', exact: true });
  await other.focus();
  await page.keyboard.press('Space');
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('radio', { name: 'Radial', exact: true }).click();
  await expect(page).toHaveURL(/layout=radial/);
  await expect(composer).toHaveText('Keep this unsent follow-up');
  await page.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(composer).toHaveText('Keep this unsent follow-up');
  await page.getByRole('tab', { name: /^Results/ }).click();
  await expect(page.getByLabel('Select Auth Migration', { exact: true })).toBeChecked();
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
  // A send from Connections stays on Connections; the answer is one tab away.
  await expect(page).toHaveURL(/tab=connections/);
  await page.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(page.getByTestId('search-evidence')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ message: question, selection: { records: [{ type: 'person', id: 'vera' }, { type: 'work', id: 'cutover' }] } });
  await expect(page.getByRole('log')).toContainText('Start with Vera Green');
  await expect(page.getByTestId('search-evidence').getByRole('link', { name: 'Source 1: Vera Green', exact: true }).first()).toHaveAttribute('href', '/iq/people/vera');
  await expect(page.getByRole('log').getByRole('link', { name: '1', exact: true })).toHaveAttribute('href', '/iq/people/vera');
  await page.getByRole('button', { name: 'View these connections', exact: true }).click();
  await expect(page.getByTestId('search-connections')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('session')).toBe('search-stream-session');
  await page.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Start with Vera Green');
  expect(submissions).toHaveLength(1);
});

test('saved search restores query, scope and selection then can be removed', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&scope=auth&tab=connections&selection=person:vera`);
  // Save search lives in the header's ⋯ menu (decision 9: one header row).
  await page.getByRole('button', { name: 'Search actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save search', exact: true }).click();
  await page.getByLabel('Saved search name').fill('Auth migration owners');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const rail = page.getByTestId('search-explorer-rail');
  await expect(rail.getByRole('button', { name: 'Auth migration owners', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New search', exact: true }).click();
  await rail.getByRole('button', { name: 'Auth migration owners', exact: true }).click();
  await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('scope')).toBe('auth');
  await expect(page.getByRole('button', { name: 'Person: Vera Green', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Search actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove saved search', exact: true }).click();
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
  // entities=people lands on the People row, whose Connections panel is the org graph.
  await expect(page.getByTestId('search-people-graph')).toBeVisible();
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
  // The `/` menu offers the command; the explicit route is the typed form.
  // (Picking the agent from the argument menu hides the command line and,
  // in ui-components 2.403.0, the words typed next land in a paragraph ahead
  // of it — a library gap, reported, not worked around here.)
  await editor.fill('/agent');
  await expect(page.getByRole('option', { name: /Ask a specific agent/ })).toBeVisible();
  await editor.fill('/agent advisor Find migration guides');
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

test('Search composer is the shared agent dock: Agent menu, Workflow rows seed the draft, # attaches context', async ({ page }) => {
  const { submissions, invocationURLs } = await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent('Auth Migration')}`);
  await expect(page.getByTestId('search-results')).toContainText('Auth Migration');
  const composer = page.getByTestId('search-composer');
  const editor = composer.getByRole('textbox', { name: 'Search question' });
  await expect(composer.getByTestId('search-rich-composer')).toBeVisible();
  // Agent ⌄ is visible; Chat and Terminal are listed with the reason they are off.
  await composer.getByRole('button', { name: 'Composer mode' }).click();
  await expect(page.getByText('Search has no discussion thread — ask the agent').first()).toBeVisible();
  await expect(page.getByText('Search has no terminal').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Workflow ⌄: a disabled row says why; an enabled row puts its prompt in the draft.
  await page.getByTestId('search-composer-workflow').click();
  await expect(page.getByRole('menuitem', { name: /Explain the selection/ })).toBeDisabled();
  await page.getByRole('menuitem', { name: /Who can help/ }).click();
  await expect(editor).toHaveText('Who can help with Auth Migration? Name the owner, the SMEs and the blocked work.');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => invocationURLs.length).toBe(1);
  expect(invocationURLs[0]).toBe('/api/agents/orgiq-supervisor/invoke');
  expect(submissions[0].message).toBe('Who can help with Auth Migration? Name the owner, the SMEs and the blocked work.');
  // `#` opens "Add context"; picking a record attaches it as a chip and in the URL.
  await editor.click();
  await editor.pressSequentially('#Vera');
  await page.getByRole('option', { name: /Vera Green/ }).click();
  await expect(page).toHaveURL(/context=person%3Avera|context=person:vera/);
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
    await expect(page.getByTestId('search-explorer-rail').locator('[aria-current="page"]')).toHaveCount(2);
    const rail = await page.getByTestId('search-explorer-rail').boundingBox();
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

test('Results group by type with counts, highlights and a URL-bound sort', async ({ page }) => {
  // The chips and sort collapse into the header menu below ~1536px; audit them at the walk width.
  await page.setViewportSize({ width: 1672, height: 941 });
  await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent('Auth Migration')}`);
  const list = page.getByTestId('record-result-list');
  await expect(list).toContainText('People');
  await expect(list).toContainText('Initiatives');
  await expect(list.locator('mark').first()).toBeVisible();
  await expect(list).toContainText('5 results');
  await expect(list).toContainText('Select results to ask about them or view their connections.');
  await expect(page.getByTestId('search-type-rail').getByRole('link', { name: /People/ })).toContainText('2');
  await page.getByTestId('search-sort').click();
  await page.getByRole('menuitem', { name: 'Recent' }).click();
  await expect(page).toHaveURL(/sort=recent/);
});

test('a scoped search names its initiative, offers the whole workspace and labels row actions', async ({ page }) => {
  // The chips and sort collapse into the header menu below ~1536px; audit them at the walk width.
  await page.setViewportSize({ width: 1672, height: 941 });
  await mockWorkspace(page);
  await page.goto('/iq/search?q=cutover&scope=auth');
  await expect(page.getByTestId('search-scope')).toContainText('In: Auth Migration');
  await expect(page.getByTestId('record-result-list')).toContainText('5 results in Auth Migration');
  await expect(page.getByRole('link', { name: /Open work item/ }).first()).toHaveAttribute('href', '/iq/work-items/cutover');
  // "Search entire workspace" sits in the results footer beside "N results in <scope>".
  await page.getByTestId('search-scope-all').click();
  expect(new URL(page.url()).searchParams.has('scope')).toBe(false);
});

test('People connections draw the org graph with department chips and a person card', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/iq/search?type=person&tab=connections');
  const panel = page.getByTestId('search-people-graph');
  await expect(panel).toContainText('3 people');
  await expect(panel.getByText('Platform Engineering').first()).toBeVisible();
  await expect(panel.getByText('Rare skills · org-wide')).toBeVisible();
  // Keyboard activation: the library's Departments legend can sit over a node
  // in a short canvas (DEFECTS.md item 5, library half).
  await page.getByRole('button', { name: /^Vera Green · Staff Engineer/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/selection=person%3Avera|selection=person:vera/);
  await expect(panel).toContainText('OIDC');
});

test('A lone person selection draws the org graph around that person, never the record graph', async ({ page }) => {
  await mockWorkspace(page);
  for (const url of ['/iq/search?tab=connections&selection=person:vera', '/iq/explore?focus=vera']) {
    await page.goto(url);
    const panel = page.getByTestId('search-people-graph');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('search-connections')).toHaveCount(0);
    const graph = page.getByTestId('search-org-graph');
    await expect(graph.getByRole('button', { name: /^Vera Green/ })).toBeVisible();
    await expect(graph.getByRole('button', { name: /^Nora Chang/ })).toBeVisible();
    // Ben (Security) is not Vera's neighbour: the narrowed graph leaves him out.
    await expect(graph.getByRole('button', { name: /^Ben Okafor/ })).toHaveCount(0);
    await expect(panel).toContainText('2 / 3 people');
  }
  await page.getByRole('button', { name: 'Show whole org', exact: true }).click();
  await expect(page).toHaveURL(/graphAll=1/);
  await expect(page.getByTestId('search-org-graph').getByRole('button', { name: /^Ben Okafor/ })).toBeVisible();
});

test('A record selection with no recorded edges shows the empty state, not filler', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/iq/search?tab=connections&selection=knowledge:sso');
  await expect(page.getByTestId('search-connections')).toHaveCount(0);
  await expect(page.getByText('No recorded connections', { exact: true })).toBeVisible();
});

test('asking about a selection keeps the query and the Connections graph', async ({ page }) => {
  const { submissions } = await mockWorkspace(page);
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&tab=connections&selection=person:vera,initiative:auth,work:cutover`);
  await expect(page.getByTestId('search-connections')).toBeVisible();
  await page.getByRole('button', { name: 'Ask about selection →', exact: true }).click();
  const composer = page.getByTestId('search-composer');
  await expect(composer.getByRole('textbox', { name: 'Search question' })).toHaveText('What connects these 3 records, and what needs attention?');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(page.getByTestId('search-assistant-strip')).toContainText('Start with Vera Green');
  const url = new URL(page.url());
  expect(url.searchParams.get('q')).toBe(question);
  expect(url.searchParams.get('tab')).toBe('connections');
  await expect(page.getByTestId('search-connections')).toBeVisible();
  await expect(page.getByText('No recorded connections', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Person: Vera Green', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('the expanded assistant strip renders Markdown; the collapsed line is plain text', async ({ page }) => {
  await mockWorkspace(page);
  await page.route('**/api/sessions/*/events', route => route.fulfill({ json: { events: [
    { eventId: 'q-md', role: 'USER', text: question },
    { eventId: 'a-md', role: 'ASSISTANT', text: '**Key Decisions:** ask **Vera Green** first. Source: s3://orgiq-documents/adr-auth.md' },
  ] } }));
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&tab=connections&selection=person:vera,initiative:auth&session=search-history`);
  const strip = page.getByTestId('search-assistant-strip');
  await expect(strip).toContainText('Key Decisions: ask Vera Green first. Source:');
  await expect(strip).not.toContainText('**');
  await expect(strip).not.toContainText('s3://');
  await strip.getByRole('button', { name: 'Expand conversation', exact: true }).click();
  const conversation = page.getByTestId('search-assistant-conversation');
  await expect(conversation.locator('strong', { hasText: 'Vera Green' })).toBeVisible();
  await expect(conversation).not.toContainText('**');
});

test('the person card sits beside the People canvas, not over it', async ({ page }) => {
  await mockWorkspace(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/iq/search?type=person&tab=connections&selection=person:vera');
  const card = page.getByTestId('search-person-card');
  await expect(card).toContainText('OIDC');
  await expect(card.getByRole('button', { name: 'Ask about Vera', exact: true })).toBeVisible();
  const canvas = page.getByTestId('search-people-canvas-canvas');
  const [a, b] = [await card.boundingBox(), await canvas.boundingBox()];
  expect(a && b).toBeTruthy();
  const overlaps = a!.x < b!.x + b!.width && b!.x < a!.x + a!.width && a!.y < b!.y + b!.height && b!.y < a!.y + a!.height;
  expect(overlaps).toBe(false);
  expect(a!.x).toBeGreaterThanOrEqual(b!.x + b!.width);
  // The graph fills the pane rather than a fixed ~360px band.
  const graph = await page.getByTestId('search-org-graph').boundingBox();
  expect(graph!.height).toBeGreaterThan(400);
});

test('the header is one row: crumbs, title and view tabs share a band at most 48px tall; no hero field', async ({ page }) => {
  await mockWorkspace(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}`);
  const header = page.getByTestId('search-header');
  await expect(header.getByRole('heading', { name: question, exact: true })).toBeVisible();
  const band = (await header.boundingBox())!;
  expect(band.height).toBeLessThanOrEqual(48);
  for (const id of ['search-header-crumbs', 'search-header-title', 'search-header-tabs', 'search-chips']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box, id).toBeTruthy();
    expect(box.y, id).toBeGreaterThanOrEqual(band.y - 1);
    expect(box.y + box.height, id).toBeLessThanOrEqual(band.y + band.height + 1);
  }
  await expect(page.getByTestId('search-hero')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search workspace' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search workspace' })).toHaveCount(0);
  console.log(`[measure] header ${Math.round(band.height)}px`);
});

test('a bare composer send issues the query: q, the Results count and the rail counts follow', async ({ page }) => {
  await mockWorkspace(page);
  await page.route('**/api/search?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const q = (params.get('q') ?? '').toLowerCase();
    const matched = q ? records.filter(record => record.title.toLowerCase().includes(q)) : records;
    const counted = { all: matched.length, person: 0, initiative: 0, work: 0, knowledge: 0, decision: 0, asset: 0 } as Record<string, number>;
    for (const record of matched) counted[record.type] += 1;
    const type = params.get('type') ?? 'all';
    const results = type === 'all' ? matched : matched.filter(record => record.type === type);
    return route.fulfill({ json: { query: q, results, related: [], counts: counted, total: results.length, edges } });
  });
  await page.goto('/iq/search');
  await expect(page.getByRole('tab', { name: /^Results/ })).toContainText('5');
  const composer = page.getByTestId('search-composer');
  await composer.getByRole('textbox', { name: 'Search question' }).fill('Nora Chang');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Nora Chang');
  await expect(page).toHaveURL(/tab=answer/);
  await expect(page.getByRole('tab', { name: /^Results/ })).toContainText('1');
  await expect(page.getByTestId('search-type-rail').getByRole('link', { name: /People/ })).toContainText('1');
});

test('the Answer view carries a graph card that expands inline and opens Connections', async ({ page }) => {
  await mockWorkspace(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&tab=answer&session=search-history`);
  await expect(page.getByRole('log')).toContainText('Start with Vera Green');
  const card = page.getByTestId('search-graph-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('search-graph-card-summary')).toContainText('connections');
  // Under the last turn, with the cited records.
  const evidence = (await page.getByTestId('search-evidence').boundingBox())!;
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual(evidence.y + evidence.height - 1);
  await card.getByTestId('search-graph-card-toggle').click();
  await expect(card.getByTestId('search-graph-card-graph')).toBeVisible();
  await expect(card.getByTestId('search-graph-card-canvas').locator('.react-flow')).toBeVisible();
  await card.getByTestId('search-graph-card-open').click();
  await expect(page).toHaveURL(/tab=connections/);
  await expect(page.getByTestId('search-connections')).toBeVisible();
});

test('on a people search the Answer card summarises the org graph and opens it', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/iq/search?type=person&tab=answer&session=search-history');
  const card = page.getByTestId('search-graph-card');
  await expect(card).toContainText('People & connections');
  await expect(card.getByTestId('search-graph-card-summary')).toContainText('3 records');
  await card.getByTestId('search-graph-card-open').click();
  await expect(page).toHaveURL(/tab=connections/);
  await expect(page.getByTestId('search-people-graph')).toBeVisible();
});

test('the Connections canvas takes the height the header freed', async ({ page }) => {
  await mockWorkspace(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`/iq/search?q=${encodeURIComponent(question)}&tab=connections&selection=person:vera,initiative:auth`);
  const graph = page.getByTestId('search-connections');
  await expect(graph.getByRole('button', { name: 'Person: Vera Green', exact: true })).toBeVisible();
  const canvas = (await graph.locator('.react-flow').boundingBox())!;
  const whole = (await graph.boundingBox())!;
  console.log(`[measure] record graph ${Math.round(whole.height)}px, canvas ${Math.round(canvas.height)}px`);
  expect(canvas.height).toBeGreaterThanOrEqual(520);
  await page.goto('/iq/search?type=person&tab=connections');
  const org = (await page.getByTestId('search-people-canvas-canvas').boundingBox())!;
  console.log(`[measure] people canvas ${Math.round(org.height)}px`);
  expect(org.height).toBeGreaterThanOrEqual(480);
});
