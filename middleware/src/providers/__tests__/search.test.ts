jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../index.js', () => ({ aurora: { fetchGraph: jest.fn(), fetchPersonGraph: jest.fn() } }));
jest.mock('../projects.js', () => ({ listProjects: jest.fn(), listProjectSummaries: jest.fn(), getProject: jest.fn() }));
jest.mock('../work-items.js', () => ({ searchWorkItems: jest.fn(), getWorkItem: jest.fn() }));
jest.mock('../design-reviews.js', () => ({ listDesignReviews: jest.fn(), getDesignThread: jest.fn() }));
jest.mock('../decisions.js', () => ({ listDecisions: jest.fn(), getDecision: jest.fn() }));
jest.mock('../distillation.js', () => ({ listItems: jest.fn(), getItem: jest.fn() }));
jest.mock('../prompt-library.js', () => ({ listAssets: jest.fn(), getAsset: jest.fn() }));
jest.mock('../recording-search.js', () => ({ listRecordingSearchRecords: jest.fn(async () => ({ records: [], partial: [] })), resolveRecordingSearchRecord: jest.fn() }));
import { isAllowed } from '../../lib/authz.js';
import { aurora } from '../index.js';
import { listProjects, listProjectSummaries, getProject } from '../projects.js';
import { searchWorkItems, getWorkItem } from '../work-items.js';
import { listDesignReviews, getDesignThread } from '../design-reviews.js';
import { listDecisions } from '../decisions.js';
import { listItems } from '../distillation.js';
import { listAssets } from '../prompt-library.js';
import { searchRecords, resolveSearchRecords, resolveSearchContext, recordingSearchResponse } from '../search.js';
import { listRecordingSearchRecords, resolveRecordingSearchRecord } from '../recording-search.js';
const principal = { sub: 'member', role: 'member', tenant: 'orgiq' };
const mock = (fn: unknown) => fn as jest.Mock;
beforeEach(() => {
  jest.resetAllMocks();
  mock(isAllowed).mockResolvedValue(true);
  mock(listRecordingSearchRecords).mockResolvedValue({ records: [], partial: [] });
  mock(aurora.fetchGraph).mockResolvedValue({ peopleTotal: 2, nodes: [
    { id: 'vera', name: 'Vera Green', title: 'Engineer', department: 'Platform', skills: ['identity'] },
    { id: 'nora', name: 'Nora Chang', title: 'Engineer', department: 'Design', skills: [] },
  ], edges: [] });
  mock(listProjects).mockResolvedValue([{ id: 'auth', name: 'Auth Migration', status: 'active', ownerId: 'vera', ownerName: 'Vera Green' }, { id: 'other', name: 'Other initiative' }]);
  mock(listProjectSummaries).mockResolvedValue(new Map([['auth', 'Migrate identity']]));
  mock(getProject).mockImplementation(async id => id === 'auth' ? { id, name: 'Auth Migration', ownerName: 'Vera Green', summary: 'Migrate identity', contributors: [{ personId: 'nora', name: 'Nora Chang', role: 'sme' }] } : null);
  mock(searchWorkItems).mockResolvedValue([{ id: 'cutover', projectId: 'auth', projectName: 'Auth Migration', title: 'Tenant cutover', status: 'open', blockedReason: 'Needs decision', assigneeId: 'nora', assigneeName: 'Nora Chang' }]);
  mock(listDesignReviews).mockResolvedValue([]);
  mock(getDesignThread).mockResolvedValue(null);
  mock(listDecisions).mockResolvedValue([{ id: 'order', topic: 'Choose cutover order', summary: '', status: 'open', projectId: 'auth' }]);
  mock(listItems).mockResolvedValue({ items: [
    { id: 'obs', title: 'Check callback', body: 'Use exact origin', level: 'L0', initiative_id: 'auth' },
    { id: 'cluster', title: 'Identity origin pattern', summary: '', level: 'L1', initiative_id: 'auth', member_observation_ids: ['obs'] },
    { id: 'guide', title: 'Bring SSO up', summary: '', level: 'L2', cluster_ids: ['cluster'], library_item_id: 'skill', status: 'published', type: 'procedure' },
  ], total: 3 });
  mock(listAssets).mockResolvedValue({ assets: [{ id: 'skill', name: 'Bring SSO up', description: '', lifecycleStatus: 'draft', kind: 'skill', usedBy: [] }], total: 1 });
});
test('native recording text is searchable and scoped, but only an excerpt leaves the projection', async () => {
  mock(listRecordingSearchRecords).mockResolvedValue({ records: [{ type: 'recording', id: 'rec-native', title: 'Auth Migration huddle', href: '/iq/projects/auth?tab=docs&recording=rec-native', searchText: `${'quiet '.repeat(400)}Exact callback origin decision`, sourceRefs: [{ type: 'initiative', id: 'auth' }] }], partial: [] });
  const result = await searchRecords(principal, { q: 'callback origin', scope: 'auth', type: 'recording' });
  expect(result.counts.recording).toBe(1);
  expect(result.results[0]?.description).toContain('Exact callback origin decision');
  expect(result.results[0]?.description?.length).toBeLessThanOrEqual(1202);
  expect(JSON.stringify(result)).not.toContain('searchText');
  expect((await searchRecords(principal)).results.some(r => 'searchText' in r)).toBe(false);
  expect(result.edges).toContainEqual(expect.objectContaining({ source: 'initiative:auth', target: 'recording:rec-native' }));
});
test('recording-only projection searches full artifacts with bounded public snippets and honest lower-bound counts', () => {
  const projection = { records: [{ type: 'recording' as const, id: 'team-rec', title: 'Notifications Service huddle', href: '/assessment/teams/TEAM-005?tab=documents&recording=team-rec', searchText: `${'quiet '.repeat(400)}The exact notification receipt is durable`, updatedAt: '2026-10-10T10:00:00Z' }], partial: ['Recordings source window is limited'] };
  const response = recordingSearchResponse(projection, { q: 'notification receipt', limit: 10, offset: 0 });
  expect(response.results[0]?.description).toContain('notification receipt');
  expect(response.results[0]?.description?.length).toBeLessThanOrEqual(1202);
  expect(response.counts).toMatchObject({ all: 1, recording: 1, initiative: 0, person: 0 });
  expect(response.totalIsLowerBound).toBe(true); expect(response.edges).toEqual([]);
  expect(JSON.stringify(response)).not.toContain('searchText');
  expect(recordingSearchResponse(projection, { q: 'unrelated' }).results).toEqual([]);
});
test('recording read failures disclose a partial source and selected context is re-resolved', async () => {
  mock(listRecordingSearchRecords).mockRejectedValue(new Error('native unavailable'));
  const result = await searchRecords(principal, { type: 'recording' });
  expect(result.partial).toContain('Recordings unavailable');
  expect(result.totalIsLowerBound).toBe(true);
  mock(resolveRecordingSearchRecord).mockResolvedValue({ type: 'recording', id: 'r1', title: 'Canonical current call', href: '/iq/projects/auth?tab=docs&recording=r1', sourceRefs: [{ type: 'initiative', id: 'auth' }] });
  const selected = await resolveSearchContext(principal, [{ type: 'initiative', id: 'auth' }, { type: 'recording', id: 'r1' }]);
  expect(resolveRecordingSearchRecord).toHaveBeenCalledWith(principal, 'r1');
  expect(selected.edges).toContainEqual(expect.objectContaining({ source: 'initiative:auth', target: 'recording:r1' }));
});
test('a question finds the existing initiative and its real owner, SME, and assigned work', async () => {
  const r = await searchRecords(principal, { q: 'Who can help finish Auth Migration?' });
  expect(r.results.map(x => x.id)).toEqual(expect.arrayContaining(['auth', 'vera', 'nora', 'cutover']));
  expect(r.results[0]?.id).toBe('auth');
  expect(r.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'person:vera', target: 'initiative:auth', label: 'owns' }),
    expect.objectContaining({ source: 'person:nora', target: 'initiative:auth', label: 'SME' }),
    expect.objectContaining({ source: 'person:nora', target: 'work:cutover', label: 'assigned to' }),
  ]));
  expect(r.results.find(x => x.id === 'cutover')?.status).toBe('blocked');
});
test('type filters and pagination share permission-filtered counts', async () => {
  const r = await searchRecords(principal, { q: 'Auth Migration', type: 'person', limit: 1, offset: 1 });
  expect(r.total).toBe(2); expect(r.counts.person).toBe(2); expect(r.results).toHaveLength(1);
  expect(r.results[0]?.type).toBe('person');
  expect(r.counts.all).toBeGreaterThan(r.total);
});
test('the total is exact only when every source window was read whole', async () => {
  const exact = await searchRecords(principal, { q: 'Auth Migration' });
  expect(exact.totalIsLowerBound).toBe(false);
  expect(exact.total).toBe(exact.counts.all);
  // A full 200-row initiative window means initiatives beyond it were never scored.
  mock(listProjects).mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: i === 0 ? 'Auth Migration' : `Initiative ${i}` })));
  const capped = await searchRecords(principal, { q: 'Auth Migration' });
  expect(capped.totalIsLowerBound).toBe(true);
  expect(capped.partial).toContain('Initiatives source window is limited');
  // A failed source read contributes nothing, so the count is a floor there too.
  mock(listProjects).mockResolvedValue([]);
  mock(listDecisions).mockRejectedValue(new Error('down'));
  const failed = await searchRecords(principal, { q: 'cutover' });
  expect(failed.totalIsLowerBound).toBe(true);
  expect(failed.partial).toContain('Decisions unavailable');
});
test('denied people never appear in results, related records, counts, or graph edges', async () => {
  mock(isAllowed).mockImplementation(async (_p, action) => action !== 'ViewOrgChart');
  const r = await searchRecords(principal, { q: 'Auth Migration' });
  expect(r.counts.person).toBe(0);
  expect([...r.results, ...r.related].some(x => x.type === 'person')).toBe(false);
  expect(r.edges.some(x => x.source.startsWith('person:') || x.target.startsWith('person:'))).toBe(false);
  expect(aurora.fetchGraph).not.toHaveBeenCalled();
});
test('search and selection hydration preserve authorized portraits, with initials for absent faces', async () => {
  const vera = { id: 'vera', name: 'Vera Green', title: 'Engineer', department: 'Platform', skills: ['identity'], avatarUrl: '/avatars/photos/vera.jpg', presence: 'office' };
  mock(aurora.fetchGraph).mockResolvedValue({ peopleTotal: 2, nodes: [vera, { ...vera, id: 'nora', name: 'Nora Chang', avatarUrl: null }], edges: [] });
  const r = await searchRecords(principal, { scope: 'auth', type: 'person' });
  expect(r.results.find(row => row.id === 'vera')?.avatarUrl).toBe(vera.avatarUrl);
  expect(r.results.find(row => row.id === 'nora')).not.toHaveProperty('avatarUrl');
  expect(r.results.every(row => !('presence' in row))).toBe(true);
  mock(aurora.fetchPersonGraph).mockResolvedValue(vera);
  expect((await resolveSearchRecords(principal, [{ type: 'person', id: 'vera' }]))[0]?.avatarUrl).toBe(vera.avatarUrl);
  mock(aurora.fetchPersonGraph).mockResolvedValue({ ...vera, avatarUrl: '' });
  expect((await resolveSearchRecords(principal, [{ type: 'person', id: 'vera' }]))[0]).not.toHaveProperty('avatarUrl');
});
test('denied selection hydration never fetches or exposes a portrait', async () => {
  mock(isAllowed).mockImplementation(async (_p, action) => action !== 'ViewOrgChart');
  mock(aurora.fetchPersonGraph).mockResolvedValue({ id: 'vera', name: 'Vera Green', avatarUrl: '/secret.jpg' });
  expect(await resolveSearchRecords(principal, [{ type: 'person', id: 'vera' }])).toEqual([]);
  expect(aurora.fetchPersonGraph).not.toHaveBeenCalled();
});
test('tenant and Search denial stop all source reads', async () => {
  await expect(searchRecords({ ...principal, tenant: 'assessment' })).rejects.toMatchObject({ status: 403 });
  mock(isAllowed).mockResolvedValue(false);
  await expect(searchRecords(principal)).rejects.toMatchObject({ status: 403 });
  expect(listProjects).not.toHaveBeenCalled();
});
test('scope follows recorded evidence into guide and asset without merging their state', async () => {
  const r = await searchRecords(principal, { scope: 'auth' });
  expect(r.results.map(x => x.id)).not.toContain('other');
  expect(r.results.find(x => x.id === 'guide')?.status).toBe('published');
  expect(r.results.find(x => x.id === 'skill')?.status).toBe('draft');
  expect(r.edges).toContainEqual(expect.objectContaining({ source: 'knowledge:guide', target: 'asset:skill', label: 'derived asset' }));
});
test('a scoped unrelated query does not silently return the whole initiative', async () => {
  const r = await searchRecords(principal, { scope: 'auth', q: 'unfindableword' });
  expect(r.total).toBe(0);
});
test('source failure is explicit and edges never point at missing records', async () => {
  mock(listAssets).mockRejectedValue(new Error('offline'));
  const r = await searchRecords(principal);
  expect(r.partial).toContain('Agent library unavailable');
  expect(r.edges.some(x => x.target === 'asset:skill')).toBe(false);
});
test('bounded source windows are disclosed', async () => {
  mock(listItems).mockResolvedValue({ items: [], total: 1001 });
  const r = await searchRecords(principal);
  expect(r.partial).toContain('Knowledge source window is limited');
});
test('context resolution drops missing records and re-reads canonical values', async () => {
  mock(getWorkItem).mockImplementation(async id => id === 'cutover' ? { id, title: 'Current title', projectId: 'auth', status: 'open' } : null);
  const r = await resolveSearchRecords(principal, [{ type: 'work', id: 'cutover' }, { type: 'work', id: 'missing' }]);
  expect(r).toHaveLength(1); expect(r[0]?.title).toBe('Current title');
  expect(r[0]?.href).toContain('item=cutover');
});
test('context resolution applies the same person permission', async () => {
  mock(isAllowed).mockImplementation(async (_p, action) => action !== 'ViewOrgChart');
  expect(await resolveSearchRecords(principal, [{ type: 'person', id: 'vera' }])).toEqual([]);
  expect(aurora.fetchPersonGraph).not.toHaveBeenCalled();
});

test('selected context edges link only selected authorized source identities', async () => {
  mock(aurora.fetchPersonGraph).mockImplementation(async id => id === 'nora' ? { id, name: 'Nora Chang' } : null);
  mock(getWorkItem).mockResolvedValue({ id: 'cutover', title: 'Tenant cutover', projectId: 'auth', assigneeId: 'nora', status: 'open' });
  const context = await resolveSearchContext(principal, [{ type: 'person', id: 'nora' }, { type: 'work', id: 'cutover' }]);
  expect(context.records).toHaveLength(2);
  expect(context.edges).toEqual([expect.objectContaining({ source: 'person:nora', target: 'work:cutover', label: 'assigned to' })]);
  expect(context.edges.some(e => e.source === 'initiative:auth')).toBe(false);
});

test('approved design decisions retain original IDs, initiative, and design thread links', async () => {
  const design = { id: 'des-auth', title: 'Ratified design', status: 'approved', orgProjectId: 'auth', orgProjectName: 'Auth Migration', summary: 'Decision summary', affected: [], dependsOn: [] };
  mock(listDesignReviews).mockResolvedValue([design]);
  const r = await searchRecords(principal, { scope: 'auth' });
  expect(r.results).toContainEqual(expect.objectContaining({ id: 'des-auth', type: 'decision', href: '/iq/designs/des-auth', status: 'approved' }));
  expect(r.edges).toContainEqual(expect.objectContaining({ source: 'initiative:auth', target: 'decision:des-auth', label: 'approved decision' }));
  mock(getDesignThread).mockResolvedValue(design);
  expect(await resolveSearchRecords(principal, [{ type: 'decision', id: 'des-auth' }])).toEqual([expect.objectContaining({ id: 'des-auth', href: '/iq/designs/des-auth' })]);
});

test('initiative context puts owners and blocked or open work before completed work', async () => {
  mock(searchWorkItems).mockResolvedValue([
    { id: 'done', projectId: 'auth', projectName: 'Auth Migration', title: 'AAA completed task', status: 'done' },
    { id: 'open', projectId: 'auth', projectName: 'Auth Migration', title: 'BBB open task', status: 'open' },
    { id: 'blocked', projectId: 'auth', projectName: 'Auth Migration', title: 'ZZZ blocked task', status: 'open', labels: ['blocked'] },
  ]);
  const r = await searchRecords(principal, { q: 'Who can help finish Auth Migration?' });
  const ids = r.results.map(x => x.id);
  expect(ids.indexOf('vera')).toBeLessThan(ids.indexOf('nora'));
  expect(ids.indexOf('blocked')).toBeLessThan(ids.indexOf('open'));
  expect(ids.indexOf('open')).toBeLessThan(ids.indexOf('done'));
});

test('matchReason says why each row scored: title, initiative membership, or initiative work', async () => {
  const r = await searchRecords(principal, { q: 'Who can help finish Auth Migration?' });
  const reason = (id: string) => r.results.find(x => x.id === id)?.matchReason;
  expect(reason('auth')).toBe('Title match');
  expect(reason('vera')).toBe('Matched through initiative membership');
  expect(reason('nora')).toBe('Matched through initiative membership');
  // Its subtitle names the initiative, but the includes edge is what ranked it.
  expect(reason('cutover')).toBe('Matched through initiative work');
  expect(reason('order')).toBe('Matched through a linked initiative');
});
test('a text-only hit is a Text match; no query and no scope carries no reason', async () => {
  const r = await searchRecords(principal, { q: 'identity' });
  expect(r.results.find(x => x.id === 'vera')).toMatchObject({ matchReason: 'Text match', highlights: ['identity'] });
  const browse = await searchRecords(principal);
  expect(browse.results.every(x => x.matchReason === undefined && x.highlights === undefined)).toBe(true);
});
test('scope-only browsing marks every row In scope', async () => {
  const r = await searchRecords(principal, { scope: 'auth' });
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results.every(x => x.matchReason === 'In scope')).toBe(true);
});
test('highlights are the query terms present in the row, in query order, deduped', async () => {
  const r = await searchRecords(principal, { q: 'migration auth AUTH' });
  expect(r.results.find(x => x.id === 'auth')?.highlights).toEqual(['migration', 'auth']);
  expect(r.results.find(x => x.id === 'cutover')?.highlights).toEqual(['migration', 'auth']);
  expect(r.results.find(x => x.id === 'vera')?.highlights).toEqual([]);
});
test('sort=recent orders by source updatedAt, undated rows last, relevance as the tiebreak', async () => {
  mock(listProjects).mockResolvedValue([{ id: 'auth', name: 'Auth Migration', status: 'active', ownerId: 'vera', ownerName: 'Vera Green', lastActivityAt: '2026-09-01 10:00:00', createdAt: '2026-01-01T00:00:00Z' }]);
  mock(searchWorkItems).mockResolvedValue([{ id: 'cutover', projectId: 'auth', projectName: 'Auth Migration', title: 'Tenant cutover', status: 'open', updatedAt: '2026-09-20T12:00:00Z' }]);
  mock(listDecisions).mockResolvedValue([{ id: 'order', topic: 'Choose cutover order', summary: '', status: 'open', projectId: 'auth', decidedAt: null }]);
  mock(listItems).mockResolvedValue({ items: [], total: 0 });
  mock(listAssets).mockResolvedValue({ assets: [], total: 0 });
  const r = await searchRecords(principal, { q: 'Auth Migration', sort: 'recent' });
  const ids = r.results.map(x => x.id);
  expect(ids.slice(0, 2)).toEqual(['cutover', 'auth']);
  // A zone-less Aurora timestamp is UTC, not local time.
  expect(r.results[1]?.updatedAt).toBe('2026-09-01T10:00:00.000Z');
  // Undated rows (people, the undecided decision) follow, in relevance order: owner before SME.
  expect(ids.slice(2)).toEqual(['vera', 'nora', 'order']);
  expect(r.results.slice(2).every(x => x.updatedAt === undefined)).toBe(true);
  const relevance = await searchRecords(principal, { q: 'Auth Migration' });
  expect(relevance.results[0]?.id).toBe('auth');
});
describe('widening the scope never drops a match (search-journeys member defect 6)', () => {
  const keys = (r: { results: { type: string; id: string }[] }) => r.results.map(x => `${x.type}:${x.id}`);
  test('an initiative matched only through its summary is found scoped and unscoped, for the same reason', async () => {
    mock(listProjectSummaries).mockResolvedValue(new Map([['auth', 'Migrate identity'], ['other', 'Typed component contracts and versioned release channels.']]));
    mock(getProject).mockImplementation(async id => id === 'other' ? { id, name: 'Other initiative', summary: 'Typed component contracts and versioned release channels.', contributors: [] } : null);
    const unscoped = await searchRecords(principal, { q: 'component contracts' });
    // Unscoped, the summary comes from the batched read, not a per-initiative detail read.
    expect(getProject).not.toHaveBeenCalledWith('other');
    const scoped = await searchRecords(principal, { q: 'component contracts', scope: 'other' });
    for (const r of [unscoped, scoped]) {
      const hit = r.results.find(x => x.type === 'initiative' && x.id === 'other');
      expect(hit).toMatchObject({ matchReason: 'Text match', highlights: ['component', 'contracts'] });
    }
    expect(unscoped.counts.initiative).toBeGreaterThanOrEqual(scoped.counts.initiative);
  });
  test('the scoped result set is a subset of the unscoped one', async () => {
    for (const q of ['cutover', 'identity', 'Auth Migration', 'origin']) {
      const unscoped = new Set(keys(await searchRecords(principal, { q })));
      const scoped = keys(await searchRecords(principal, { q, scope: 'auth' }));
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.filter(k => !unscoped.has(k))).toEqual([]);
    }
  });
  test('a failed summary read is reported as partial, not silently empty', async () => {
    mock(listProjectSummaries).mockRejectedValue(new Error('boom'));
    const r = await searchRecords(principal, { q: 'identity' });
    expect(r.partial).toContain('Initiative summaries unavailable');
  });
});
