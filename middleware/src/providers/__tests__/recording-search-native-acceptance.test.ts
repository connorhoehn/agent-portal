// Opt-in cross-repository read acceptance. Directory/Cedar are synthetic
// fixtures; native JWT, native policy, DDB rows, Whisper/Codex artifacts real.
import fs from 'node:fs';
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true }, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, aurora: {}, bedrock: {}, agentcore: {}, guardrail: {}, ecr: {}, messageQueue: { mock: true }, canary: {} } }));
const mockUsers = new Map<string, any>();
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(async (id: string) => mockUsers.has(id) ? structuredClone(mockUsers.get(id)) : null), displayNameForSubject: (id: string) => id }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async (_p: unknown, action: string) => action === 'Search') }));
import { searchRecords, resolveSearchRecords } from '../search.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import type { Session } from '../../lib/session.js';
const run = process.env['RECORDING_READ_ACCEPTANCE_URL'] ? describe : describe.skip;
run('owned genuine native recording artifact search', () => {
  const base = process.env['RECORDING_READ_ACCEPTANCE_URL']!;
  const row = process.env['RECORDING_READ_ACCEPTANCE_PATH'] ? JSON.parse(fs.readFileSync(process.env['RECORDING_READ_ACCEPTANCE_PATH']!, 'utf8')) : {};
  const subjects = ['meeting-reader-one', 'meeting-reader-two', 'meeting-stranger'];
  const session = (sub: string): Session => ({ sub, name: sub, role: 'member', tenant: 'orgiq', iat: Math.floor(Date.now()/1000), epoch: 2, grants: { orgiq: ['member'] } });
  beforeAll(() => {
    process.env['PLATFORM_API_URL'] = base;
    subjects.forEach(id => mockUsers.set(id, { id, displayName: id, epoch: 2, grants: { orgiq: ['member'] }, personId: null, email: null }));
  });
  test.each(subjects.slice(0, 2))('actual native participant %s reads genuine artifacts then searches them', async user => {
    const principal = session(user);
    const { token } = await signRealtimeToken(realtimeClaims(principal), process.env['REALTIME_JWT_SECRET']!);
    const headers = { Authorization: `Bearer ${token}` };
    const transcript = await fetch(`${base}/api/recordings/${row.recordingId}/transcript`, { headers });
    expect(transcript.status).toBe(200);
    const body = await transcript.json() as any;
    expect(body.segments).toEqual(JSON.parse(row.transcriptJson).segments);
    const summary = await fetch(`${base}/api/recordings/${row.recordingId}/summary`, { headers });
    expect(summary.status).toBe(200);
    expect(summary.headers.get('X-Summary-Status')).toBe('ready');
    expect(await summary.text()).toBe(row.summaryMarkdown);
    expect(await resolveSearchRecords(principal, [{ type: 'recording', id: row.recordingId }])).toHaveLength(1);
    const result = await searchRecords(principal, { q: 'duplicate alert', scope: 'p-observability', type: 'recording' });
    expect(result.results).toContainEqual(expect.objectContaining({ type: 'recording', id: row.recordingId, sourceRefs: [{ type: 'initiative', id: 'p-observability' }] }));
    expect(result.results.find(r => r.id === row.recordingId)?.description?.toLowerCase()).toContain('duplicate alert');
    expect(JSON.stringify(result)).not.toContain('searchText');
    expect(await resolveSearchRecords(principal, [{ type: 'recording', id: row.recordingId }])).toHaveLength(1);
  });
  test('actual native nonparticipant denial prevents list, selected context and cached-reader leakage', async () => {
    const principal = session(subjects[2]!);
    const { token } = await signRealtimeToken(realtimeClaims(principal), process.env['REALTIME_JWT_SECRET']!);
    const response = await fetch(`${base}/api/recordings/${row.recordingId}/transcript`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(404);
    const result = await searchRecords(principal, { q: 'duplicate alert', type: 'recording' });
    expect(result.counts.recording).toBe(0);
    expect(JSON.stringify(result)).not.toContain(row.recordingId);
    expect(await resolveSearchRecords(principal, [{ type: 'recording', id: row.recordingId }])).toEqual([]);
  });
  test('real BFF freshness check rejects a revoked fixture epoch before artifact context', async () => {
    mockUsers.get(subjects[0]!)!.epoch = 3;
    try { await expect(resolveSearchRecords(session(subjects[0]!), [{ type: 'recording', id: row.recordingId }])).rejects.toMatchObject({ status: 401 }); }
    finally { mockUsers.get(subjects[0]!)!.epoch = 2; }
  });
});
