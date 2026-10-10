jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true }, auth: {} } }));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [
  { id: 'assessor', tenant: 'assessment', label: 'Assessor', capabilities: ['ViewAssessment'] },
  { id: 'admin', tenant: 'orgiq', label: 'Admin', capabilities: ['ViewAssessment'] },
] }));
jest.mock('../../providers/recording-search.js', () => ({ listRecordingSearchRecords: jest.fn(), resolveRecordingSearchRecord: jest.fn(), RECORDING_READ_BUDGET_MS: 8000 }));
jest.mock('../../providers/search.js', () => ({ SEARCH_SORTS: ['relevance', 'recent'], recordingSearchResponse: jest.fn((projection, opts) => ({ query: opts.q, results: projection.records, total: projection.records.length, totalIsLowerBound: projection.partial.length > 0, partial: projection.partial, related: [], edges: [], counts: { all: projection.records.length, recording: projection.records.length } })) }));
import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler, AppError } from '../../lib/async-handler.js';
import { assessmentRecordingSearchRouter } from '../assessment-recording-search.js';
import { listRecordingSearchRecords, resolveRecordingSearchRecord } from '../../providers/recording-search.js';
import type { Session } from '../../lib/session.js';
const reader: Session = { sub: 'reader', tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] }, epoch: 2, iat: 1 };
const makeApp = (session: Session | null = reader) => express().use((req, _res, next) => { if (session) req.session = session; next(); }).use('/api/assessment/recordings', assessmentRecordingSearchRouter).use(errorHandler);
beforeEach(() => { jest.mocked(listRecordingSearchRecords).mockReset().mockResolvedValue({ records: [], partial: [] }); jest.mocked(resolveRecordingSearchRecord).mockReset().mockResolvedValue(null); });
test('existing Assessment read authority admits assessor without adding Search or Social grants', async () => {
  const res = await request(makeApp()).get('/api/assessment/recordings/search?q=receipt&teamId=TEAM-005&limit=20&offset=1&sort=recent');
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('private, no-store');
  expect(listRecordingSearchRecords).toHaveBeenCalledWith(reader, 'TEAM-005', 'assessment', undefined);
});
test.each([null, { ...reader, tenant: 'orgiq' }, { ...reader, tenant: 'orgiq', role: 'admin' }, { ...reader, role: 'member', grants: { assessment: ['member'] } }])('cross-tenant/missing read authority is denied before native access', async session => {
  const res = await request(makeApp(session as Session | null)).get('/api/assessment/recordings/search');
  expect([401, 403]).toContain(res.status); expect(listRecordingSearchRecords).not.toHaveBeenCalled();
});
test.each(['teamId=TEAM-../secret', 'teamId=p-observability', 'type=initiative', 'limit=101', 'offset=-1', 'sort=unknown'])('validates recording-only query %s', async query => {
  expect((await request(makeApp()).get(`/api/assessment/recordings/search?${query}`)).status).toBe(400); expect(listRecordingSearchRecords).not.toHaveBeenCalled();
});
test('native failure is explicit partial results while revoked session remains an error', async () => {
  jest.mocked(listRecordingSearchRecords).mockRejectedValue(new AppError(502, 'Native unavailable'));
  const res = await request(makeApp()).get('/api/assessment/recordings/search');
  expect(res.status).toBe(200); expect(res.body).toMatchObject({ results: [], totalIsLowerBound: true, partial: ['Recordings unavailable'] });
  jest.mocked(listRecordingSearchRecords).mockRejectedValue(new AppError(401, 'Revoked'));
  expect((await request(makeApp()).get('/api/assessment/recordings/search')).status).toBe(401);
});
test('hydration deduplicates exact recording refs, carries team scope, and excludes denied rows', async () => {
  jest.mocked(resolveRecordingSearchRecord).mockResolvedValueOnce({ type: 'recording', id: 'owned', title: 'Huddle', href: '/assessment/teams/TEAM-005?tab=documents&recording=owned' });
  const res = await request(makeApp()).get('/api/assessment/recordings/records?keys=recording:owned,recording:denied,recording:owned&teamId=TEAM-005');
  expect(res.status).toBe(200); expect(res.body.records.map((r: { id: string }) => r.id)).toEqual(['owned']);
  expect(resolveRecordingSearchRecord).toHaveBeenNthCalledWith(1, reader, 'owned', 'TEAM-005', 'assessment', expect.any(Number), undefined);
  expect(resolveRecordingSearchRecord).toHaveBeenCalledTimes(2);
  expect((await request(makeApp()).get('/api/assessment/recordings/records?keys=initiative:fake')).status).toBe(400);
});
test('selected-record hydration shares one bounded native read window and stops before further I/O', async () => {
  let now = 1000; const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.mocked(resolveRecordingSearchRecord).mockImplementation(async () => { now += 9000; return null; });
  try {
    expect((await request(makeApp()).get('/api/assessment/recordings/records?keys=recording:first,recording:second')).status).toBe(504);
    expect(resolveRecordingSearchRecord).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});
test('document recording search and hydration forward original source scope without a team substitution', async () => {
  const sourceId = 'ec:standards/ci-cd.md';
  expect((await request(makeApp()).get(`/api/assessment/recordings/search?documentSourceId=${encodeURIComponent(sourceId)}`)).status).toBe(200);
  expect(listRecordingSearchRecords).toHaveBeenCalledWith(reader, undefined, 'assessment', sourceId);
  expect((await request(makeApp()).get(`/api/assessment/recordings/records?keys=recording:owned&documentSourceId=${encodeURIComponent(sourceId)}`)).status).toBe(200);
  expect(resolveRecordingSearchRecord).toHaveBeenCalledWith(reader, 'owned', undefined, 'assessment', expect.any(Number), sourceId);
});
test.each(['documentSourceId=&teamId=TEAM-005', 'documentSourceId=source&teamId=TEAM-005', 'documentSourceId=%00source', 'documentSourceId=one&documentSourceId=two'])('invalid/ambiguous document scope %s is rejected before native reads', async query => {
  expect((await request(makeApp()).get(`/api/assessment/recordings/search?${query}`)).status).toBe(400);
  expect((await request(makeApp()).get(`/api/assessment/recordings/records?keys=recording:owned&${query}`)).status).toBe(400);
  expect(listRecordingSearchRecords).not.toHaveBeenCalled(); expect(resolveRecordingSearchRecord).not.toHaveBeenCalled();
});
