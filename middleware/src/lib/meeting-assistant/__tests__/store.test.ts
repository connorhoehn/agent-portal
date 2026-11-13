// The store contract on the memory store, the SQL store's statements and row mapping against a recording
// executor (no database runs in unit tests), and the retention sweep.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { MemoryAssistantStore, MAX_PENDING_REQUESTS } from '../store.js';
import { SqlAssistantStore, recordFromRow, lineFromRow } from '../store-sql.js';
import { sweepTranscripts } from '../retention.js';
import type { AssistantRecord } from '../types.js';

const record = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: 'call-1', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'u-vera',
  invitedAt: 1000, pausedBy: null, leftAt: null, leftBy: null, acked: ['u-vera'], attendees: ['u-vera'], presentAtInvite: ['u-vera'],
  requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], ...over,
});
const line = (over: Record<string, unknown> = {}) =>
  ({ callId: 'call-1', userId: 'u-vera', participantId: 'p1', speakerName: 'Vera', text: 'hello', at: 5000, captionId: 'c1', ...over }) as Parameters<MemoryAssistantStore['appendLine']>[0];

describe('MemoryAssistantStore', () => {
  let s: MemoryAssistantStore;
  beforeEach(async () => { s = new MemoryAssistantStore(); await s.create(record()); });

  it('creates once per call and returns copies', async () => {
    const again = await s.create(record({ invitedBy: 'u-release' }));
    expect(again.created).toBe(false);
    expect(again.record.invitedBy).toBe('u-vera');
    const r = (await s.get('call-1'))!; r.acked.push('x');
    expect((await s.get('call-1'))!.acked).toEqual(['u-vera']);
    expect(await s.get('nope')).toBeNull();
  });

  it('assigns line numbers in order, counts them, and stores a repeated caption once', async () => {
    expect((await s.appendLine(line()))!.seq).toBe(1);
    expect((await s.appendLine(line({ captionId: 'c2', text: 'two' })))!.seq).toBe(2);
    expect(await s.appendLine(line())).toBeNull();
    expect((await s.get('call-1'))).toMatchObject({ linesStored: 2, nextSeq: 3 });
    expect((await s.lines('call-1', 1, 10)).map((l) => l.text)).toEqual(['two']);
    expect(await s.lines('call-1', 0, 1)).toHaveLength(1);
  });

  it('stores a line only while listening', async () => {
    await s.transition('call-1', { from: ['listening'], to: 'paused', by: 'u-release', at: 6000 });
    expect(await s.appendLine(line())).toBeNull();
    await s.transition('call-1', { from: ['paused'], to: 'listening', by: 'u-release', at: 7000 });
    expect(await s.appendLine(line())).not.toBeNull();
    await s.transition('call-1', { from: ['listening'], to: 'left', by: 'u-vera', at: 8000 });
    expect(await s.appendLine(line({ captionId: 'c9' }))).toBeNull();
  });

  it('transitions only from the allowed states, and records who paused and who left', async () => {
    expect(await s.transition('call-1', { from: ['paused'], to: 'listening', by: 'x', at: 1 })).toBeNull();
    expect((await s.transition('call-1', { from: ['listening'], to: 'paused', by: 'u-release', at: 1 }))).toMatchObject({ state: 'paused', pausedBy: 'u-release' });
    expect((await s.transition('call-1', { from: ['paused'], to: 'listening', by: 'u-vera', at: 2 }))!.pausedBy).toBeNull();
    expect(await s.transition('call-1', { from: ['listening'], to: 'left', by: 'u-release', at: 3 })).toMatchObject({ state: 'left', leftBy: 'u-release', leftAt: 3 });
    expect(await s.transition('call-1', { from: ['invited', 'listening', 'paused'], to: 'left', by: 'u-vera', at: 4 })).toBeNull();
  });

  it('ack and attend are idempotent', async () => {
    await s.ack('call-1', 'u-release'); await s.ack('call-1', 'u-release'); await s.attend('call-1', 'u-priya'); await s.attend('call-1', 'u-priya');
    expect(await s.get('call-1')).toMatchObject({ acked: ['u-vera', 'u-release'], attendees: ['u-vera', 'u-release', 'u-priya'] });
    expect(await s.ack('nope', 'x')).toBeNull();
  });

  it('keeps the newest pending requests and counts all of them', async () => {
    for (let i = 0; i < MAX_PENDING_REQUESTS + 3; i++) await s.addRequest('call-1', { id: `r${i}`, askedBy: 'u-vera', text: 't', lines: [i], startedAt: 1, endedAt: 2 });
    const r = (await s.get('call-1'))!;
    expect(r.requests).toBe(MAX_PENDING_REQUESTS + 3);
    expect(r.pendingRequests).toHaveLength(MAX_PENDING_REQUESTS);
    expect(r.pendingRequests[0]!.id).toBe('r3');
  });

  it('retention: the sweep deletes lines at or before the cutoff and no others', async () => {
    const day = 86_400_000; const now = 100 * day;
    await s.appendLine(line({ captionId: 'old', at: now - 31 * day }));
    await s.appendLine(line({ captionId: 'edge', at: now - 30 * day }));
    await s.appendLine(line({ captionId: 'new', at: now - 29 * day }));
    expect(await sweepTranscripts(s, now, 30)).toBe(2);
    expect((await s.lines('call-1', 0, 10)).map((l) => l.captionId)).toEqual(['new']);
    expect(await sweepTranscripts(s, now)).toBe(0);
  });

  it('keeps the offsets and speakers a line arrived with', async () => {
    await s.appendLine(line({ startMs: 10, endMs: 900, speakers: ['u-vera', 'u-release'] }));
    expect((await s.lines('call-1', 0, 1))[0]).toMatchObject({ startMs: 10, endMs: 900, speakers: ['u-vera', 'u-release'] });
  });
});

describe('SqlAssistantStore statements', () => {
  const calls: { sql: string; params: { name?: string; value?: unknown }[] }[] = [];
  let rows: Record<string, unknown>[];
  const store = () => new SqlAssistantStore(async (sql, params = []) => { calls.push({ sql, params }); return rows; });
  beforeEach(() => { calls.length = 0; rows = []; });
  const norm = (sql: string) => sql.replace(/\s+/g, ' ');

  it('appendLine claims the line number and inserts in ONE statement, guarded by state and caption', async () => {
    rows = [{ call_id: 'call-1', seq: 4, user_id: 'u-vera', participant_id: 'p1', speaker_name: 'Vera', text: 'hi', at: '2026-11-13 10:00:00', caption_id: 'c1' }];
    const out = await store().appendLine({ ...line(), startMs: 5, speakers: ['u-vera'] });
    expect(calls).toHaveLength(1);
    const sql = norm(calls[0]!.sql);
    expect(sql).toContain("WITH claimed AS ( UPDATE meeting_assistants SET next_seq = next_seq + 1");
    expect(sql).toContain("state = 'listening'");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM meeting_transcript_lines WHERE call_id = :call AND caption_id = :caption)');
    expect(sql).toContain('INSERT INTO meeting_transcript_lines');
    expect(out).toMatchObject({ seq: 4, userId: 'u-vera', at: Date.parse('2026-11-13T10:00:00Z') });
    // Every value goes through a named parameter, never into the text.
    expect(sql).not.toContain('hello');
  });

  it('appendLine returns null when the guard stopped the insert', async () => {
    expect(await store().appendLine(line())).toBeNull();
  });

  it('transition lists only constant states and binds everything else', async () => {
    await store().transition('call-1', { from: ['invited', 'listening'], to: 'paused', by: "u'; DROP TABLE x;--", at: 1 });
    const sql = norm(calls[0]!.sql);
    expect(sql).toContain("WHERE call_id = :call AND state IN ('invited', 'listening')");
    expect(sql).not.toContain('DROP');
    expect(calls[0]!.params.find((p) => p.name === 'by')).toBeTruthy();
  });

  it('create is insert-or-read: a conflict falls back to the existing row', async () => {
    const existing = { call_id: 'call-1', tenant: 'orgiq', lobby: 'l', state: 'listening', invited_by: 'u-vera', invited_at: '2026-11-13T10:00:00Z', acked: '["u-vera"]', attendees: '[]', present_at_invite: '[]', pending_requests: '[]', requests: 0, lines_stored: 0, next_seq: 1 };
    let n = 0;
    const s = new SqlAssistantStore(async (sql) => { calls.push({ sql, params: [] }); return n++ === 0 ? [] : [existing]; });
    const out = await s.create(record());
    expect(norm(calls[0]!.sql)).toContain('ON CONFLICT (call_id) DO NOTHING');
    expect(out.created).toBe(false);
    expect(out.record.acked).toEqual(['u-vera']);
  });

  it('ack, attend, addRequest, lines and sweep each name their table and columns', async () => {
    const st = store();
    await st.ack('call-1', 'u-release'); await st.attend('call-1', 'u-release');
    await st.addRequest('call-1', { id: 'r', askedBy: 'u', text: 't', lines: [1], startedAt: 1, endedAt: 2 });
    await st.lines('call-1', 3, 50);
    expect(await st.sweepLines(1000)).toBe(0);
    const all = calls.map((c) => norm(c.sql));
    expect(all[0]).toContain('acked = CASE WHEN acked @> to_jsonb(:user::text)');
    expect(all[1]).toContain('NOT (attendees @> to_jsonb(:user::text))');
    expect(all[2]).toContain(`LIMIT ${MAX_PENDING_REQUESTS}`);
    expect(all[3]).toContain('WHERE call_id = :call AND seq > :after ORDER BY seq ASC LIMIT :limit');
    expect(all[4]).toContain('DELETE FROM meeting_transcript_lines WHERE at <= :cutoff::timestamptz');
  });

  it('maps rows, including jsonb as text and as arrays', () => {
    const r = recordFromRow({ call_id: 'c', tenant: 'orgiq', lobby: 'l', initiative_id: null, state: 'paused', invited_by: 'u', invited_at: '2026-11-13T10:00:00Z',
      paused_by: 'v', left_at: null, left_by: null, acked: ['u'], attendees: '["u","v"]', present_at_invite: '[]', requests: '2', lines_stored: 3, next_seq: 4, pending_requests: '[]' });
    expect(r).toMatchObject({ state: 'paused', initiativeId: null, pausedBy: 'v', acked: ['u'], attendees: ['u', 'v'], requests: 2, linesStored: 3, nextSeq: 4 });
    expect(lineFromRow({ call_id: 'c', seq: 1, user_id: 'u', text: 't', at: '2026-11-13T10:00:00Z', caption_id: 'x', speakers: '["u","v"]' }).speakers).toEqual(['u', 'v']);
  });
});

import { initiativeOfLobby } from '../store.js';
it('reads the initiative out of an initiative lobby and nothing else', () => {
  expect(initiativeOfLobby('orgiq:initiative:p-auth')).toBe('p-auth');
  for (const l of ['orgiq:dm:a:b', 'assessment:team:T-1', 'orgiq:initiative:', 'orgiq:initiative:a/b']) expect(initiativeOfLobby(l)).toBeNull();
});
