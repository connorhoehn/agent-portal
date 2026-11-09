jest.mock('../../lib/live-principal.js', () => ({ currentLiveSession: jest.fn(async s => s), sessionGatewayContext: jest.fn(s => ({ userId: s.sub, org: s.tenant })) }));
jest.mock('../../lib/gateway/authority.js', () => ({ admitLobbyRead: jest.fn(async () => 'ok') }));
jest.mock('../../lib/realtime-token.js', () => ({ realtimeSigningSecret: jest.fn(() => 'synthetic-key'), realtimeClaims: jest.fn(s => ({ sub: s.sub, org: s.tenant, epoch: s.epoch, act: s.act })), signRealtimeToken: jest.fn(async claims => ({ token: `synthetic-${claims.sub}` })) }));
jest.mock('../projects.js', () => ({ getProject: jest.fn(async () => ({ id: 'p-observability', name: 'Observability Platform' })) }));
jest.mock('../assessment.js', () => ({ getTeamDetail: jest.fn(async (id: string) => ({ team: { id, name: 'Notifications Service' } })), getKnowledgeDoc: jest.fn(), getKnowledgeTree: jest.fn() }));
import { AppError } from '../../lib/async-handler.js';
import { currentLiveSession } from '../../lib/live-principal.js';
import { admitLobbyRead } from '../../lib/gateway/authority.js';
import { realtimeClaims } from '../../lib/realtime-token.js';
import { getTeamDetail, getKnowledgeDoc, getKnowledgeTree } from '../assessment.js';
import { assessmentDocumentLobby } from '../../lib/assessment-document-context.js';
import { listRecordingSearchRecords, recordingsAreASource, resolveRecordingSearchRecord } from '../recording-search.js';
const session = { sub: 'u-nora', name: 'Nora', tenant: 'orgiq', role: 'member', iat: 123, epoch: 4, grants: { orgiq: ['member'] } };
const row = { recordingId: 'rec-1', lobbyName: 'orgiq:initiative:p-observability', startedAt: '2026-10-10T10:00:00Z', endedAt: '2026-10-10T10:01:00Z', transcriptStatus: 'ready', summaryStatus: 'ready', summaryRunId: 'run-1', stage: 'ready' };
const mock = (fn: unknown) => fn as jest.Mock;
const response = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
let fetcher: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  process.env['PLATFORM_API_URL'] = 'http://native.invalid';
  mock(currentLiveSession).mockImplementation(async s => s);
  mock(admitLobbyRead).mockResolvedValue('ok');
  fetcher = jest.fn(async (url: string) => {
    if (url.includes('?limit=')) return response({ items: [row], cursor: null });
    if (url.endsWith('/transcript')) return response({ segments: [{ speakerLabel: 'Nora', text: 'the latency budget is twenty milliseconds', startMs: 0, endMs: 1 }, { kind: 'reaction', text: 'reacted with thumb' }] });
    if (url.endsWith('/summary')) return response('# Decisions\nUse the real error budget.', 200, { 'X-Summary-Status': 'ready' });
    return response(row);
  });
  global.fetch = fetcher;
});
afterAll(() => { delete process.env['PLATFORM_API_URL']; });
test('reads participant-owned native artifacts with current identity and canonical initiative tags', async () => {
  const result = await listRecordingSearchRecords(session);
  expect(result.records[0]).toMatchObject({ id: 'rec-1', type: 'recording', title: 'Observability Platform huddle · 2026-10-10', sourceRefs: [{ type: 'initiative', id: 'p-observability' }] });
  expect(result.records[0]?.searchText).toContain('twenty milliseconds');
  expect(result.records[0]?.searchText).toContain('Use the real error budget');
  expect(result.records[0]?.searchText).not.toContain('thumb');
  expect(fetcher.mock.calls.every(([, opts]) => opts.method === 'GET' && opts.headers.Authorization === 'Bearer synthetic-u-nora')).toBe(true);
  expect(admitLobbyRead).toHaveBeenCalledTimes(2);
  expect(realtimeClaims).toHaveBeenCalledWith(session);
});
const assessment = { ...session, tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] } };
const teamRow = { ...row, recordingId: 'team-rec', lobbyName: 'assessment:team:TEAM-005' };
function useTeamRecording(rows = [teamRow]) {
  fetcher.mockImplementation(async (url: string) => {
    if (url.includes('?limit=')) return response({ items: rows, cursor: null });
    if (url.endsWith('/transcript')) return response({ segments: [{ text: 'notification pipeline needs a durable receipt', speakerLabel: 'Assessor', startMs: 0, endMs: 1 }] });
    if (url.endsWith('/summary')) return response('# Follow-up\nPreserve the durable receipt.', 200, { 'X-Summary-Status': 'ready' });
    return response(teamRow);
  });
}
test('Assessment explicitly projects only its participant-owned team artifacts and canonical team destination', async () => {
  useTeamRecording([teamRow, { ...row, recordingId: 'work-rec' }, { ...teamRow, recordingId: 'doc-rec', lobbyName: 'assessment:doc:page:100002' }]);
  const result = await listRecordingSearchRecords(assessment, 'TEAM-005', 'assessment');
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ id: 'team-rec', title: 'Notifications Service huddle · 2026-10-10', href: '/assessment/teams/TEAM-005?tab=documents&recording=team-rec' });
  expect(result.records[0]?.sourceRefs).toBeUndefined();
  expect(result.records[0]?.searchText).toContain('durable receipt');
  expect(fetcher.mock.calls.every(([, opts]) => opts.headers.Authorization === 'Bearer synthetic-u-nora')).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => /\/(work-rec|doc-rec)(\/|$)/.test(url))).toBe(false);
  await expect(listRecordingSearchRecords(assessment)).rejects.toMatchObject({ status: 503 });
});
test('Assessment context resolves exact ID only after native participant and team authority, scoped team cannot be swapped', async () => {
  useTeamRecording();
  expect(await resolveRecordingSearchRecord(assessment, 'team-rec', 'TEAM-005', 'assessment')).toMatchObject({ type: 'recording', id: 'team-rec' });
  expect(await resolveRecordingSearchRecord(assessment, 'team-rec', 'TEAM-006', 'assessment')).toBeNull();
  const count = fetcher.mock.calls.length;
  await expect(resolveRecordingSearchRecord(session, 'team-rec', 'TEAM-005', 'assessment')).rejects.toMatchObject({ status: 503 });
  expect(fetcher).toHaveBeenCalledTimes(count);
});
test('Assessment denied/deleted team or revoked native participation exposes neither title nor artifact text', async () => {
  useTeamRecording(); mock(admitLobbyRead).mockResolvedValue('denied');
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment')).records).toEqual([]);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/transcript'))).toBe(false);
  mock(admitLobbyRead).mockResolvedValue('ok'); mock(getTeamDetail).mockResolvedValueOnce(null);
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment')).records).toEqual([]);
  useTeamRecording(); const original = fetcher.getMockImplementation()!; let details = 0;
  fetcher.mockImplementation(async (url, opts) => url.endsWith('/team-rec') && ++details === 2 ? response({}, 404) : original(url, opts));
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment')).records).toEqual([]);
});
test('Assessment identity revoked during native reads rejects the whole projection', async () => {
  useTeamRecording();
  mock(currentLiveSession).mockResolvedValueOnce(assessment).mockRejectedValue(new AppError(401, 'Session revoked'));
  await expect(listRecordingSearchRecords(assessment, undefined, 'assessment')).rejects.toMatchObject({ status: 401 });
});
test('host denial prevents any transcript, summary, result or project title read', async () => {
  mock(admitLobbyRead).mockResolvedValue('denied');
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: [] });
  expect(fetcher.mock.calls.some(([url]) => /\/(transcript|summary)$/.test(url))).toBe(false);
});
test.each([403, 404, 410])('native participant denial/deletion %s hides the artifact without an existence signal', async status => {
  fetcher.mockImplementation(async (url: string) => url.includes('?limit=') ? response({ items: [row] }) : response({}, status));
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: [] });
});
test('participation revoked after body reads drops the previously readable text', async () => {
  let detailReads = 0;
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, opts: unknown) => url.endsWith('/rec-1') && ++detailReads === 2 ? response({}, 403) : original(url, opts));
  expect((await listRecordingSearchRecords(session)).records).toEqual([]);
});
test('host permission revoked during artifact I/O drops the text', async () => {
  mock(admitLobbyRead).mockResolvedValueOnce('ok').mockResolvedValue('denied');
  expect((await listRecordingSearchRecords(session)).records).toEqual([]);
});
test('a newer processing attempt never exposes the previous transcript or summary', async () => {
  let details = 0;
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, opts: unknown) => url.endsWith('/rec-1') && ++details === 2 ? response({ ...row, summaryRunId: 'new-run', transcriptStatus: 'pending' }) : original(url, opts));
  expect((await listRecordingSearchRecords(session)).records).toEqual([]);
});
test('wrong tenant, malformed lobby, scope mismatch and expiry never hydrate artifacts', async () => {
  fetcher.mockResolvedValue(response({ items: [{ ...row, lobbyName: 'social:room:secret' }, { ...row, lobbyName: 'orgiq:initiative:p-other' }, { ...row, expiresAt: '2000-01-01T00:00:00Z' }, { ...row, ttl: 0 }, { ...row, expiresAt: 'invalid' }] }));
  expect((await listRecordingSearchRecords(session, 'p-observability')).records).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(listRecordingSearchRecords({ ...session, tenant: 'assessment' })).rejects.toMatchObject({ status: 503 });
});
test('failed summary and synthetic explanatory markdown are not indexed as a summary', async () => {
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, opts: unknown) => url.endsWith('/summary') ? response('_Summary generation failed_', 200, { 'X-Summary-Status': 'failed' }) : original(url, opts));
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: ['Recording artifacts unavailable'] });
});
test('a current failed summary leaves the native ready transcript searchable', async () => {
  const failed = { ...row, summaryStatus: 'failed' };
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, opts: unknown) => url.includes('?limit=') ? response({ items: [failed] }) : url.endsWith('/rec-1') ? response(failed) : original(url, opts));
  const result = await listRecordingSearchRecords(session);
  expect(result.records[0]?.searchText).toContain('latency budget');
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/summary'))).toBe(false);
});
test('an exhausted native read budget stops further artifact requests and discloses the window', async () => {
  let now = 1000;
  const time = jest.spyOn(Date, 'now').mockImplementation(() => now);
  fetcher.mockImplementation(async () => { now += 9000; return response({ items: [row] }); });
  try {
    expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: ['Recording artifacts read window is limited'] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { time.mockRestore(); }
});
test('an oversized chunked native body is cancelled before unbounded text allocation', async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(256 * 1024)); },
    cancel() { cancelled = true; },
  });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, opts: unknown) => url.endsWith('/transcript') ? new Response(stream) : original(url, opts));
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: ['Recording artifacts unavailable'] });
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(4);
});
test('bounded cursor scan is disclosed and repeated cursor fails closed', async () => {
  fetcher.mockImplementation(async () => response({ items: [], cursor: 'same' }));
  await expect(listRecordingSearchRecords(session)).rejects.toMatchObject({ status: 502 });
  let page = 0;
  fetcher.mockImplementation(async () => response({ items: [], cursor: `next-${++page}` }));
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: ['Recordings source window is limited'] });
  expect(page).toBe(3);
});
test('selected context rechecks the exact native ID and strips private matching text', async () => {
  const record = await resolveRecordingSearchRecord(session, 'rec-1');
  expect(record?.description).toContain('latency budget');
  expect(record).not.toHaveProperty('searchText');
  expect(fetcher.mock.calls.some(([url]) => url.includes('?limit='))).toBe(false);
  fetcher.mockResolvedValue(response({ ...row, recordingId: 'other' }));
  expect(await resolveRecordingSearchRecord(session, 'rec-1')).toBeNull();
});
test('directory epoch or masquerade authority changes reject the entire in-flight projection', async () => {
  mock(currentLiveSession).mockResolvedValueOnce(session).mockRejectedValue(new AppError(401, 'Session expired'));
  await expect(listRecordingSearchRecords(session)).rejects.toMatchObject({ status: 401 });
  mock(currentLiveSession).mockImplementation(async s => s);
  const actor = { ...session, act: { sub: 'admin', epoch: 3, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } };
  await resolveRecordingSearchRecord(actor, 'rec-1');
  expect(realtimeClaims).toHaveBeenCalledWith(actor);
});
test('native outage is explicit and unavailable config never adopts a mock/global transcript cache', async () => {
  fetcher.mockImplementation(async (url: string) => url.includes('?limit=') ? response({ items: [row] }) : response({}, 503));
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: ['Recording artifacts unavailable'] });
  delete process.env['PLATFORM_API_URL'];
  expect(await listRecordingSearchRecords(session)).toEqual({ records: [], partial: ['Recordings unavailable'] });
});
const sourceId = 'ec:standards/ci-cd-standards.md';
const documentRow = { ...row, recordingId: 'doc-rec', lobbyName: assessmentDocumentLobby(sourceId), artifactContext: { tenant: 'assessment', documentSourceId: sourceId } };
function useDocumentRecording(value: object = documentRow) {
  mock(getKnowledgeDoc).mockResolvedValue({ id: sourceId, title: 'CI/CD Standards' });
  mock(getKnowledgeTree).mockResolvedValue({ sections: [{ key: 'enterprise_context', kind: 'local', nodes: [{ id: sourceId, is_dir: false }] }] });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, opts: unknown) => url.includes('?limit=') ? response({ items: [value] })
    : url.endsWith('/doc-rec') ? response(value) : original(url, opts));
}
test('hashed document recording projects original source only after participant+fresh host checks and exact scope', async () => {
  useDocumentRecording();
  const result = await listRecordingSearchRecords(assessment, undefined, 'assessment', sourceId);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ id: 'doc-rec', title: 'CI/CD Standards huddle · 2026-10-10', href: `/assessment/enterprise?doc=${encodeURIComponent(sourceId)}&tab=recordings&recording=doc-rec` });
  expect(result.records[0]?.searchText).toContain('twenty milliseconds');
  expect(getKnowledgeDoc).toHaveBeenCalledTimes(2);
  expect(await resolveRecordingSearchRecord(assessment, 'doc-rec', undefined, 'assessment', Date.now() + 8000, sourceId)).toMatchObject({ id: 'doc-rec' });
  expect(await resolveRecordingSearchRecord(assessment, 'doc-rec', undefined, 'assessment', Date.now() + 8000, 'different-source')).toBeNull();
  expect(await resolveRecordingSearchRecord(assessment, 'doc-rec', 'TEAM-005', 'assessment')).toBeNull();
});
test.each([{ artifactContext: null }, { artifactContext: { tenant: 'orgiq', documentSourceId: sourceId } }, { artifactContext: { tenant: 'assessment', documentSourceId: 'wrong-source' } }, { lobbyName: 'orgiq:doc:any' }])('unverified/mismatched document metadata %j does not hydrate', async change => {
  useDocumentRecording({ ...documentRow, ...change });
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment', sourceId)).records).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(getKnowledgeDoc).not.toHaveBeenCalled();
});
test('document access/participation revocation or source association change never leaves searchable artifact text', async () => {
  useDocumentRecording(); mock(getKnowledgeDoc).mockResolvedValueOnce(null);
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment', sourceId)).records).toEqual([]);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/transcript'))).toBe(false);
  useDocumentRecording(); mock(getKnowledgeDoc).mockResolvedValueOnce({ id: sourceId, title: 'Before deletion' }).mockResolvedValueOnce(null);
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment', sourceId)).records).toEqual([]);
  useDocumentRecording(); const original = fetcher.getMockImplementation()!; let details = 0;
  fetcher.mockImplementation(async (url, opts) => url.endsWith('/doc-rec') && ++details === 2 ? response({ ...documentRow, artifactContext: null }) : original(url, opts));
  expect((await listRecordingSearchRecords(assessment, undefined, 'assessment', sourceId)).records).toEqual([]);
});
test('document scope cannot widen Work tenant or be combined with team scope', async () => {
  await expect(listRecordingSearchRecords(session, undefined, 'orgiq', sourceId)).rejects.toMatchObject({ status: 400 });
  await expect(resolveRecordingSearchRecord(assessment, 'doc-rec', 'TEAM-005', 'assessment', undefined, sourceId)).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});

test('recordings are a search source only with a Social grant and a configured platform', () => {
  expect(recordingsAreASource(session)).toBe(false);
  const social = { ...session, grants: { orgiq: ['member'], social: ['participant'] } };
  expect(recordingsAreASource(social)).toBe(true);
  // A bare policy principal is left to the read, which refuses it.
  expect(recordingsAreASource({ sub: 'u-nora', role: 'member', tenant: 'orgiq' })).toBe(true);
  delete process.env['PLATFORM_API_URL'];
  expect(recordingsAreASource(social)).toBe(false);
});
