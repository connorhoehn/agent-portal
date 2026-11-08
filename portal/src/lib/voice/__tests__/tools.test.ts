import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FIELD_CHARS, MAX_ROWS, DATA_NOTE, ResultMemory, localHref, parseSince, parseToolArgs, runVoiceTool, shapeOutput, voicePage } from '../tools.ts';
import { VOICE_TENANTS, VOICE_TOOLS, navigatePageIds, voiceToolSpec } from '../catalogue.ts';
import { PALETTE, fakeFetch, route, toolContext } from './voiceHarness.ts';

/** A valid call per P3 tool, and the context that refuses it. */
const P3_REFUSALS: Array<{ tool: string; args: Record<string, unknown>; ctx: Parameters<typeof toolContext>[0] }> = [
  { tool: 'search_people', args: { query: 'kubernetes' }, ctx: { deny: ['Search'] } },
  { tool: 'search_records', args: { query: 'auth migration', type: 'decision' }, ctx: { deny: ['Search'] } },
  { tool: 'navigate', args: { page: 'bots' }, ctx: { role: 'member' } },
  { tool: 'open_computer_lab', args: {}, ctx: { tenant: 'social' } },
  { tool: 'list_active_initiatives', args: {}, ctx: { tenant: 'social' } },
  { tool: 'bot_sweep_status', args: { since: 'yesterday' }, ctx: { tenant: 'social' } },
  { tool: 'access_request_status', args: { query: 'budgets' }, ctx: { tenant: 'access', deny: ['ViewAccess'] } },
  { tool: 'access_request_status', args: { scope: 'approvals' }, ctx: { tenant: 'access', role: 'requester', allow: ['ViewAccess', 'RequestAccess'] } },
  { tool: 'access_request_status', args: { scope: 'approvals' }, ctx: { tenant: 'orgiq' } },
  { tool: 'access_request_status', args: { scope: 'reports', query: 'sme' }, ctx: { tenant: 'social' } },
];

test('every P3 tool refuses on its gate without a network call', async () => {
  for (const { tool, args, ctx } of P3_REFUSALS) {
    let calls = 0;
    const c = toolContext({ ...ctx, fetch: async () => { calls++; throw new Error('network'); } });
    const r = await runVoiceTool(tool, JSON.stringify(args), c);
    assert.equal(r.outcome, 'refused', tool);
    assert.equal(r.output['kind'], 'refused', tool);
    assert.equal(typeof r.output['reason'], 'string');
    assert.equal(calls, 0, `${tool} made no request`);
    assert.deepEqual(c.navigations, [], `${tool} opened nothing`);
  }
});

test('arguments: strict nulls are dropped, then lengths, ranges, enums and unknown keys are enforced', () => {
  const people = voiceToolSpec('search_people')!;
  assert.deepEqual(parseToolArgs(people, '{"query":"Kubernetes experts","scope":null,"limit":null,"sort":"recent"}'),
    { ok: true, args: { query: 'Kubernetes experts', sort: 'recent' }, ignored: [] });
  for (const bad of ['{"query":""}', '{"query":"x","limit":11}', '{"query":"x","limit":2.5}', '{"query":"x","sort":"newest"}',
    '{"query":"x","tenant":"access"}', '{}', 'not json', JSON.stringify({ query: 'x'.repeat(201) })]) {
    assert.equal(parseToolArgs(people, bad).ok, false, bad);
  }
  const nav = voiceToolSpec('navigate')!;
  assert.equal(parseToolArgs(nav, '{"page":"search","params":{"q":"k8s","type":null,"id":null}}').ok, true);
  assert.equal(parseToolArgs(nav, '{"route":"/iq/local-compute"}').ok, false, 'the V1 probe\'s own shape is not the catalogue\'s');
});

test('navigate refuses an unknown page id and a page outside the tenant or the role, table-driven over PAGES', async () => {
  const unknown = await runVoiceTool('navigate', { page: 'admin-identity' }, toolContext());
  assert.equal(unknown.outcome, 'refused', 'not in the enum');
  const crossTenant = await runVoiceTool('navigate', { page: 'teams' }, toolContext({ tenant: 'orgiq' }));
  assert.equal(crossTenant.outcome, 'refused', 'a social page from orgiq');

  // Every role of every tenant, over every page id: the id resolves to its own tenant's palette row, gated by isPageVisible.
  const roles = ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin', 'participant', 'moderator',
    'assessor', 'program-lead', 'author', 'operator', 'requester', 'approver', 'access-admin'];
  assert.equal(PALETTE.pages.filter((p) => p.pageId).length, 24, 'the real palette table, 24 voice pages');
  const inTenant = (p: { tenant: string }, t: string) => p.tenant === t || p.tenant === 'universal' || (p.tenant === 'admin' && t === 'orgiq');
  const ids = [...new Set(PALETTE.pages.filter((p) => p.pageId).map((p) => p.pageId!))];
  for (const id of ids) {
    for (const tenant of VOICE_TENANTS) {
      for (const role of roles) {
        const c = toolContext({ tenant, role });
        const r = await runVoiceTool('navigate', { page: id }, c);
        const target = PALETTE.pages.find((p) => p.pageId === id && inTenant(p, tenant));
        const expected = navigatePageIds(tenant).includes(id) && !!target && PALETTE.visible(target, tenant, role);
        assert.equal(r.outcome === 'done', expected, `${id} as ${role} in ${tenant}`);
        assert.deepEqual(c.navigations, expected ? [target!.path] : [], `${id} as ${role} in ${tenant}`);
      }
    }
  }
  // A repeated id opens the session's own tenant's page, with a record id where the route takes one.
  const runs = toolContext({ tenant: 'pipelines', role: 'author' });
  await runVoiceTool('navigate', { page: 'runs', params: { id: 'run-7' } }, runs);
  assert.deepEqual(runs.navigations, ['/pipelines/runs/run-7']);
  const teams = toolContext({ tenant: 'assessment', role: 'assessor' });
  await runVoiceTool('navigate', { page: 'teams' }, teams);
  assert.deepEqual(teams.navigations, ['/assessment/teams']);
  const ws = toolContext({ tenant: 'social', role: 'social-member' });
  const out = await runVoiceTool('navigate', { page: 'workspaces' }, ws);
  assert.equal(out.outcome, 'done');
  assert.match(String(out.output['warning']), /ends this voice session/);
  assert.equal(voicePage(PALETTE, 'workspaces')!.path, '/workspaces');
});

test('search_people navigates the page and reads the same search, shaping rows as data', async () => {
  const long = 'k'.repeat(400);
  const results = Array.from({ length: 14 }, (_, i) => ({
    type: 'person', id: `p${i}`, title: `Person ${i}`, subtitle: 'Platform', description: long, href: `/iq/people/p${i}`,
    matchReason: 'Skill match', updatedAt: '2026-11-07T00:00:00Z', avatarUrl: 'https://x/y.png', sourceRefs: [{ type: 'team', id: 't' }],
  }));
  const { fetch, log } = fakeFetch([route('GET', '/api/search?', 200, { query: 'kubernetes', results, total: 14, counts: {} })]);
  const c = toolContext({ fetch });
  const r = await runVoiceTool('search_people', '{"query":"Kubernetes experts","scope":null,"limit":null,"sort":"recent"}', c);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(c.navigations, ['/iq/search?q=Kubernetes+experts&type=person&tab=results&sort=recent']);
  assert.equal(log[0]!.url, '/api/search?q=Kubernetes+experts&type=person&limit=5&sort=recent');
  assert.equal(r.output['note'], DATA_NOTE);
  assert.equal(r.output['kind'], 'search_results');
  const rows = r.output['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows.length, 5);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['detail', 'href', 'matched', 'name', 'ref', 'subtitle', 'updatedAt']);
  assert.equal(rows[0]!['ref'], 'person:p0', 'the row\'s own id, for open_result');
  assert.equal((rows[0]!['detail'] as string).length, MAX_FIELD_CHARS);
});

test('a search the server refuses is a refusal, an outage a failure', async () => {
  const forbidden = fakeFetch([route('GET', '/api/search', 403, { error: 'Forbidden' })]);
  assert.equal((await runVoiceTool('search_records', { query: 'x' }, toolContext({ fetch: forbidden.fetch }))).outcome, 'refused');
  const down = fakeFetch([route('GET', '/api/search', 502, {})]);
  assert.equal((await runVoiceTool('search_records', { query: 'x' }, toolContext({ fetch: down.fetch }))).outcome, 'failed');
});

test('search_records outside orgiq reads that tenant\'s own search, with its own types and gate, and opens no page', async () => {
  const huddle = { type: 'huddle', id: 'h1', title: 'Platform standup', kind: 'Huddle', subtitle: 'In the huddle now: Mira, Lena', status: 'live', href: '/social/calls', score: 3 };
  const { fetch, log } = fakeFetch([route('GET', '/api/social/search?', 200, { query: 'standup', results: [huddle], counts: { huddle: 1 }, total: 1 })]);
  const c = toolContext({ fetch, tenant: 'social', role: 'participant', allow: ['ViewSocial'] });
  const r = await runVoiceTool('search_records', '{"query":"standup","type":"huddle","scope":null,"limit":null}', c);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(log.map((l) => l.url), ['/api/social/search?q=standup&type=huddle&limit=5']);
  assert.deepEqual(c.navigations, [], 'no search page outside orgiq');
  assert.deepEqual((r.output['rows'] as unknown[])[0], { ref: 'huddle:h1', title: 'Platform standup', type: 'huddle', subtitle: 'In the huddle now: Mira, Lena', status: 'live', href: '/social/calls' });

  // A type another tenant indexes is refused before the network; so is a role without the tenant search's own action.
  const foreign = await runVoiceTool('search_records', { query: 'x', type: 'initiative' }, toolContext({ fetch, tenant: 'social', allow: ['ViewSocial'] }));
  assert.equal(foreign.outcome, 'refused');
  const noView = await runVoiceTool('search_records', { query: 'x' }, toolContext({ fetch, tenant: 'social', allow: ['Search'] }));
  assert.equal(noView.outcome, 'refused');
  assert.equal(log.length, 1);
  // orgiq keeps GET /api/search, and `team` is a type there now.
  const org = fakeFetch([route('GET', '/api/search?', 200, { results: [{ type: 'team', id: 't1', title: 'Platform', href: '/iq/search?tab=connections' }], total: 1 })]);
  const t = await runVoiceTool('search_records', { query: 'platform', type: 'team' }, toolContext({ fetch: org.fetch, allow: ['Search'] }));
  assert.equal(t.outcome, 'done');
  assert.equal(org.log[0]!.url, '/api/search?q=platform&type=team&limit=5');
});

test('open_result opens a row the session\'s own search returned, by ref or position, and nothing else', async () => {
  const people = [
    { type: 'person', id: 'p-ada', title: 'Ada Okafor', subtitle: 'Platform', href: '/iq/search?tab=connections&selection=person%3Ap-ada' },
    { type: 'person', id: 'p-bo', title: 'Bo Lin', subtitle: 'SRE', href: '/iq/search?tab=connections&selection=person%3Ap-bo' },
  ];
  const { fetch, log } = fakeFetch([route('GET', '/api/search?', 200, { results: people, total: 2 })]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, results });
  // Before any search there is nothing to open.
  assert.equal((await runVoiceTool('open_result', { ref: '1' }, c)).outcome, 'refused');
  const found = await runVoiceTool('search_people', { query: 'kubernetes' }, c);
  assert.deepEqual((found.output['rows'] as Array<{ ref: string }>).map((r) => r.ref), ['person:p-ada', 'person:p-bo']);
  c.navigations.length = 0;

  const first = await runVoiceTool('open_result', { ref: '1' }, c);
  assert.equal(first.outcome, 'done');
  assert.deepEqual(c.navigations, [people[0]!.href], 'the first row\'s own href: the person in the connections inspector');
  const byRef = await runVoiceTool('open_result', { ref: 'person:p-bo' }, c);
  assert.equal(byRef.summary, 'Opened Bo Lin');
  assert.deepEqual(c.navigations, [people[0]!.href, people[1]!.href]);

  // A name, a path, a ref no search returned and a position past the rows are all refused, and open nothing.
  for (const ref of ['Ada Okafor', '/admin/identity', 'person:p-zed', '3', 'https://evil.example/x']) {
    const r = await runVoiceTool('open_result', { ref }, c);
    assert.equal(r.outcome, 'refused', ref);
  }
  assert.equal(c.navigations.length, 2);
  assert.equal(log.length, 1, 'open_result never reads');
  // A context without the dock's memory (no session) cannot open anything.
  assert.equal((await runVoiceTool('open_result', { ref: '1' }, toolContext())).outcome, 'refused');
});

test('open_result refuses a kept row whose href leaves the portal; social profiles open on the contacts page', async () => {
  const results = new ResultMemory();
  results.keep([{ ref: 'contact:u-ada', title: 'Ada', href: '//evil.example/x' }]);
  const c = toolContext({ tenant: 'social', role: 'participant', results });
  assert.equal((await runVoiceTool('open_result', { ref: 'contact:u-ada' }, c)).outcome, 'refused');
  assert.deepEqual(c.navigations, []);
  for (const bad of ['//x', 'https://x', 'javascript:alert(1)', '\\x', 'x']) assert.equal(localHref(bad), false, bad);
  assert.equal(localHref('/social/contacts/u-ada'), true);

  const { fetch } = fakeFetch([route('GET', '/api/social/search?', 200, { results: [{ type: 'contact', id: 'u-ada', title: 'Ada Okafor', kind: 'Contact', href: '/social/contacts/u-ada', score: 2 }], total: 1 })]);
  const s = toolContext({ fetch, tenant: 'social', role: 'participant', allow: ['ViewSocial'], results: new ResultMemory() });
  await runVoiceTool('search_records', { query: 'ada', type: 'contact' }, s);
  assert.equal((await runVoiceTool('open_result', { ref: 'contact:u-ada' }, s)).outcome, 'done');
  assert.deepEqual(s.navigations, ['/social/contacts/u-ada']);
  // And navigate names the same profile by page id.
  const n = toolContext({ tenant: 'social', role: 'participant' });
  await runVoiceTool('navigate', { page: 'contacts', params: { id: 'u-ada' } }, n);
  assert.deepEqual(n.navigations, ['/social/contacts/u-ada']);
});

test('list_active_initiatives reads the initiatives list the page reads, mine by default', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/graph/projects', 200, [
    { id: 'p1', name: 'Alpha', status: 'active', ownerName: 'Ana', contributorCount: 4, openStories: 3, description: 'secret body text' },
  ])]);
  const r = await runVoiceTool('list_active_initiatives', '{"scope":null}', toolContext({ fetch }));
  assert.equal(log[0]!.url, '/api/graph/projects?scope=mine&status=active&limit=10');
  assert.deepEqual(r.output['rows'], [{ id: 'p1', name: 'Alpha', owner: 'Ana', contributors: 4, openStories: 3 }]);
});

test('open_computer_lab opens the Computer Lab (/admin/devbox), on the initiative\'s busiest computer when it has one', async () => {
  const c = toolContext();
  const r = await runVoiceTool('open_computer_lab', { initiativeId: 'p1' }, c);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(c.navigations, ['/admin/devbox'], 'the lab that lists and starts computers, not /iq/local-compute');
  const boxes = [
    { id: 'c-idle', label: 'alpha-1', sessionId: 's'.repeat(40), status: 'idle', projectId: 'p1' },
    { id: 'c-run', label: 'alpha-2', sessionId: 't'.repeat(40), status: 'running', projectId: 'p1' },
  ];
  const withBoxes = toolContext({ compute: { canManage: true, computers: () => boxes, create: async () => boxes[0]!, openShell: () => ({ ok: true, id: 'x' }), runCommand: async () => {} } });
  await runVoiceTool('open_computer_lab', { initiativeId: 'p1' }, withBoxes);
  assert.deepEqual(withBoxes.navigations, ['/admin/devbox?box=c-run']);
  const member = await runVoiceTool('open_computer_lab', {}, toolContext({ role: 'member' }));
  assert.equal(member.outcome, 'refused', 'the lab route\'s roles');
});

const NOW = new Date('2026-11-08T12:00:00Z');
const old = '2026-11-01T09:00:00Z';
const recent = '2026-11-08T08:00:00Z';

function sweepFixtures(opts: { failedBot?: boolean; findingAt?: string; failedSweep?: boolean }) {
  return fakeFetch([
    route('GET', '/api/work/sweeps/runs', 200, { runs: opts.failedSweep ? [{ sweep: 'stale_docs', status: 'failed', startedAt: recent, error: 'graph read timed out', findings: null }] : [] }),
    route('GET', '/api/work/findings', 200, { findings: [{ sweep: 'bus_factor', severity: 'warning', title: 'One owner on Alpha', status: 'open', lastSeenAt: opts.findingAt ?? old }] }),
    route('GET', '/api/bots/runs', 200, { runs: [
      { botId: 'b1', status: opts.failedBot ? 'failed' : 'done', startedAt: recent, error: opts.failedBot ? 'model refused' : null },
      { botId: 'b2', status: 'failed', startedAt: old, error: 'old failure' },
    ] }),
    route('GET', '/api/bots', 200, { bots: [{ id: 'b1', name: 'Docs freshness bot' }, { id: 'b2', name: 'Old bot' }] }),
  ]);
}

test('bot_sweep_status answers "nothing since yesterday" from only older findings and no failed runs', async () => {
  const { fetch, log } = sweepFixtures({});
  const r = await runVoiceTool('bot_sweep_status', '{"since":"yesterday","scope":null}', toolContext({ fetch, role: 'org-leader', now: () => NOW }));
  assert.equal(r.outcome, 'done');
  assert.match(String(r.output['summary']), /^Nothing failed since/);
  assert.match(log.find((l) => l.url.startsWith('/api/work/sweeps/runs'))!.url, /status=failed/);
  assert.equal((r.output['botRuns'] as { count: number }).count, 0);
});

test('bot_sweep_status names the failed bot, the failed sweep and the new finding', async () => {
  const { fetch } = sweepFixtures({ failedBot: true, failedSweep: true, findingAt: recent });
  const r = await runVoiceTool('bot_sweep_status', { since: 'yesterday' }, toolContext({ fetch, role: 'program-owner', now: () => NOW }));
  assert.match(r.summary, /Docs freshness bot/);
  assert.doesNotMatch(r.summary, /Old bot/);
  assert.match(r.summary, /1 failed sweep run/);
  assert.match(r.summary, /1 open finding/);
});

test('bot_sweep_status for a role without the run history reads findings only and says so', async () => {
  const { fetch, log } = sweepFixtures({ failedBot: true });
  const r = await runVoiceTool('bot_sweep_status', { since: 'yesterday' }, toolContext({ fetch, role: 'member', deny: ['ManageBots'], now: () => NOW }));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(log.map((l) => l.url.split('?')[0]), ['/api/work/findings']);
  assert.ok((r.output['unread'] as string[])[0]!.includes('your role cannot read it'));
  assert.equal((await runVoiceTool('bot_sweep_status', { since: 'next tuesday' }, toolContext({ fetch, now: () => NOW }))).outcome, 'refused');
});

test('parseSince reads yesterday as local midnight and refuses the future', () => {
  const now = new Date(2026, 10, 8, 15, 30);
  assert.equal(parseSince('yesterday', now)!.getTime(), new Date(2026, 10, 7).getTime());
  assert.equal(parseSince('2026-11-01', now)!.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(parseSince('2026-12-01', now), null);
});

const request = (over: Record<string, unknown>) => ({
  id: 'r1', kind: 'grant', reviewId: null, requester: { id: 'u1', displayName: 'Me' }, beneficiary: { id: 'u1', displayName: 'Me' },
  item: { id: 'envelope:p1', title: 'Sprint envelope on Alpha' }, justification: 'my private reason for asking', duration: 'standing',
  status: 'pending', submittedAt: '2026-11-07T10:00:00Z',
  steps: [{ step: 1, kind: 'manager', status: 'approved', decidedBy: { id: 'm', displayName: 'Maya Manager' }, decidedAt: '2026-11-07T11:00:00Z', eligible: [] },
    { step: 2, kind: 'steward', status: 'current', eligible: [{ id: 's', displayName: 'Sam Steward' }] }],
  sod: { verdict: 'clear', conflicts: [] }, ...over,
});

test('access_request_status reads scope=mine only, even for an approver, in the access tenant', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/access/requests', 200, { items: [request({})] })]);
  const r = await runVoiceTool('access_request_status', { query: 'envelope' }, toolContext({ fetch, tenant: 'access', role: 'approver' }));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.url, '/api/access/requests?scope=mine&q=envelope');
  const row = (r.output['rows'] as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(row, { ref: 'request:r1', item: 'Sprint envelope on Alpha', status: 'pending', submittedAt: '2026-11-07T10:00:00Z', currentStep: 'steward', waitingOn: 'Sam Steward', decidedBy: 'Maya Manager', decidedAt: '2026-11-07T11:00:00Z' });
  assert.doesNotMatch(JSON.stringify(r.output), /private reason/, 'the justification never reaches the model');
});

test('access_request_status: an approver reads what waits on them, a manager their reports\' requests, and each opens by ref', async () => {
  const waiting = [
    request({ id: 'r-ada', requester: { id: 'u-ada', displayName: 'Ada Okafor' }, beneficiary: { id: 'u-ada', displayName: 'Ada Okafor' }, item: { id: 'orgiq:sme', title: 'SME in Work' }, submittedAt: '2026-11-08T09:00:00Z' }),
    request({ id: 'r-bo', requester: { id: 'u-bo', displayName: 'Bo Lin' }, beneficiary: { id: 'u-bo', displayName: 'Bo Lin' }, item: { id: 'social:moderator', title: 'Moderator in Social' } }),
  ];
  const { fetch, log } = fakeFetch([
    route('GET', '/api/access/approvals', 200, { items: waiting }),
    route('GET', '/api/access/requests?scope=reports', 200, { items: [waiting[1]] }),
  ]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, tenant: 'access', role: 'approver', allow: ['ViewAccess', 'RequestAccess', 'DecideAccess'], results });
  const all = await runVoiceTool('access_request_status', '{"query":null,"scope":"approvals"}', c);
  assert.equal(all.outcome, 'done');
  assert.equal(log[0]!.url, '/api/access/approvals');
  assert.equal(all.summary, '2 waiting on you; first: SME in Work from Ada Okafor');
  assert.deepEqual((all.output['rows'] as Array<Record<string, unknown>>).map((r) => [r['ref'], r['requester']]), [['request:r-ada', 'Ada Okafor'], ['request:r-bo', 'Bo Lin']]);
  assert.doesNotMatch(JSON.stringify(all.output), /private reason/, 'the justification never reaches the model');
  const bo = await runVoiceTool('access_request_status', { query: 'bo lin', scope: 'approvals' }, c);
  assert.equal(bo.output['count'], 1, 'the route\'s own match, over requester and item');
  const reports = await runVoiceTool('access_request_status', { scope: 'reports' }, c);
  assert.equal(log.at(-1)!.url, '/api/access/requests?scope=reports');
  assert.equal(reports.summary, 'Moderator in Social: pending');
  // The kept rows open the request's own record page.
  assert.equal((await runVoiceTool('open_result', { ref: 'request:r-bo' }, c)).outcome, 'done');
  assert.deepEqual(c.navigations, ['/access/requests/r-bo']);
  const nav = toolContext({ tenant: 'access', role: 'requester' });
  await runVoiceTool('navigate', { page: 'requests', params: { id: 'r-bo' } }, nav);
  assert.deepEqual(nav.navigations, ['/access/requests/r-bo']);
  // The approvals page is the approver's palette row; a requester is not offered it.
  const asRequester = toolContext({ tenant: 'access', role: 'requester' });
  assert.equal((await runVoiceTool('navigate', { page: 'approvals' }, asRequester)).outcome, 'refused');
});

test('access_request_status outside Access refuses approvals and reports with the Access hint, before any request', async () => {
  for (const tenant of ['orgiq', 'social', 'assessment', 'pipelines']) {
    let calls = 0;
    const r = await runVoiceTool('access_request_status', { scope: 'approvals' }, toolContext({ tenant, fetch: async () => { calls++; throw new Error('network'); } }));
    assert.equal(r.outcome, 'refused', tenant);
    assert.match(String(r.output['hint']), /Access workspace/, tenant);
    assert.equal(calls, 0, tenant);
  }
});

test('access_request_status from orgiq resolves an initiative name to its envelope and reads /mine', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/graph/projects', 200, [{ id: 'p1', name: 'Alpha migration' }, { id: 'p2', name: 'Beta' }]),
    route('GET', '/api/access-requests/mine', 200, { items: [request({ status: 'approved' })] }),
  ]);
  const r = await runVoiceTool('access_request_status', { query: 'the alpha envelope' }, toolContext({ fetch }));
  assert.deepEqual(log.map((l) => l.url), ['/api/graph/projects?scope=mine&limit=50', '/api/access-requests/mine?itemId=envelope%3Ap1']);
  assert.equal(r.summary, 'Sprint envelope on Alpha: approved');
  const none = await runVoiceTool('access_request_status', { query: 'prod database' }, toolContext({ fetch: fakeFetch([route('GET', '/api/graph/projects', 200, [])]).fetch }));
  assert.match(String(none.output['hint']), /Access workspace/);
});

test('property: no tool result carries a string over 120 characters or a list over 10 rows', async () => {
  const huge = 'x'.repeat(5000);
  const rows = (n: number, f: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => f(i));
  const { fetch } = fakeFetch([
    route('GET', '/api/search', 200, { results: rows(50, (i) => ({ title: huge + i, subtitle: huge, description: huge, href: `/${huge}`, matchReason: huge, type: huge })), total: 50 }),
    route('GET', '/api/graph/projects', 200, rows(60, (i) => ({ id: `p${i}-${huge}`, name: `Alpha ${huge}`, ownerName: huge, contributorCount: i }))),
    route('GET', '/api/work/sweeps/runs', 200, { runs: rows(40, () => ({ sweep: huge, status: 'failed', startedAt: recent, error: huge })) }),
    route('GET', '/api/work/findings', 200, { findings: rows(40, () => ({ sweep: huge, severity: 'critical', title: huge, status: 'open', lastSeenAt: recent })) }),
    route('GET', '/api/bots/runs', 200, { runs: rows(40, (i) => ({ botId: `b${i}`, status: 'failed', startedAt: recent, error: huge })) }),
    route('GET', '/api/bots', 200, { bots: rows(40, (i) => ({ id: `b${i}`, name: `${huge}${i}` })) }),
    route('GET', '/api/access-requests/mine', 200, { items: rows(30, () => request({ item: { id: 'e', title: huge } })) }),
  ]);
  const calls: Array<[string, Record<string, unknown>]> = [
    ['search_people', { query: 'k', limit: 10 }], ['search_records', { query: 'k', limit: 10 }], ['list_active_initiatives', { scope: 'all' }],
    ['bot_sweep_status', { since: 'yesterday', scope: 'all' }], ['access_request_status', { query: 'alpha' }], ['navigate', { page: 'search', params: { q: huge.slice(0, 900) } }],
  ];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') assert.ok(v.length <= MAX_FIELD_CHARS, `${path} is ${v.length} characters`);
    else if (Array.isArray(v)) { assert.ok(v.length <= MAX_ROWS, `${path} has ${v.length} rows`); v.forEach((x, i) => walk(x, `${path}[${i}]`)); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const [name, args] of calls) {
    const r = await runVoiceTool(name, args, toolContext({ fetch, role: 'org-leader', now: () => NOW }));
    assert.equal(r.outcome, 'done', name);
    walk(r.output, name);
    assert.ok(r.summary.length <= MAX_FIELD_CHARS);
  }
  walk(shapeOutput({ deep: { deeper: [Array.from({ length: 30 }, () => huge)] } }), 'shapeOutput');
});

test('the catalogue has a runner for every tool', async () => {
  const { VOICE_RUNNERS } = await import('../actions.ts');
  assert.deepEqual(Object.keys(VOICE_RUNNERS).sort(), VOICE_TOOLS.map((t) => t.name).sort());
});
