// The store contract on the memory store, the SQL store's statements and row mapping against a recording
// executor (no database runs in unit tests), and the retention sweep.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { MemoryAssistantStore, MAX_PENDING_REQUESTS } from '../store.js';
import { SqlAssistantStore, recordFromRow, lineFromRow } from '../store-sql.js';
import { sweepTranscripts } from '../retention.js';
import { sessionOf, type AssistantRecord, type AssistantTurn } from '../types.js';
import { turnFromRow } from '../store-sql.js';

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
    // The call is over: a call still listening or paused is never swept (audit M3), so this old assertion's listening call is moved to left first.
    await s.transition('call-1', { from: ['listening'], to: 'left', by: 'u-vera', at: now - 1000 });
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

const turn = (over: Partial<AssistantTurn> = {}): AssistantTurn => ({
  turnId: 't-1', callId: 'call-1', askedBy: 'u-vera', tool: { name: 'search', args: { query: 'x' } }, kind: 'read', status: 'pending', createdAt: 1000, expiresAt: 91_000, ...over,
});

describe('turns and the session bookkeeping (package 4a)', () => {
  let s: MemoryAssistantStore;
  beforeEach(async () => { s = new MemoryAssistantStore(); await s.create(record()); });

  it('creates a turn once per (call, turnId), lists them by asker and status in order, and returns copies', async () => {
    expect((await s.createTurn(turn())).created).toBe(true);
    expect((await s.createTurn(turn({ tool: { name: 'other', args: null } }))).created).toBe(false);
    await s.createTurn(turn({ turnId: 't-2', askedBy: 'u-bob', createdAt: 2000 }));
    await s.createTurn(turn({ turnId: 't-3', createdAt: 3000, status: 'done' }));
    expect((await s.listTurns('call-1')).map((t) => t.turnId)).toEqual(['t-1', 't-2', 't-3']);
    expect((await s.listTurns('call-1', { askedBy: 'u-vera', statuses: ['pending', 'running'] })).map((t) => t.turnId)).toEqual(['t-1']);
    expect((await s.listTurns('call-2'))).toEqual([]);
    const got = (await s.getTurn('call-1', 't-1'))!; got.status = 'failed';
    expect((await s.getTurn('call-1', 't-1'))!.status).toBe('pending');
  });

  it('moves a turn only from the statuses named, so two results settle once', async () => {
    await s.createTurn(turn());
    expect(await s.moveTurn('call-1', 't-1', { from: ['running'], to: 'done' })).toBeNull();
    expect((await s.moveTurn('call-1', 't-1', { from: ['pending'], to: 'running', actionId: 'a-1' }))).toMatchObject({ status: 'running', actionId: 'a-1' });
    expect((await s.moveTurn('call-1', 't-1', { from: ['pending', 'running'], to: 'done' }))!.status).toBe('done');
    expect(await s.moveTurn('call-1', 't-1', { from: ['pending', 'running'], to: 'expired' })).toBeNull();
    expect(await s.moveTurn('call-1', 'nope', { from: ['pending'], to: 'done' })).toBeNull();
  });
  it('claims a turn once, in one step: simultaneous claims have exactly one winner, and only a runnable, unexpired, unclaimed turn can be claimed (B6)', async () => {
    await s.createTurn(turn());                                                                    // a pending read
    await s.createTurn(turn({ turnId: 't-w', kind: 'write', status: 'pending' }));                 // a write not confirmed yet
    await s.createTurn(turn({ turnId: 't-x', expiresAt: 5000 }));
    const racers = await Promise.all(['a', 'b', 'c', 'd'].map((id) => s.claimTurn('call-1', 't-1', { claimId: id, claimedAt: 2000 }, 2000)));
    expect(racers.filter((r) => r !== null)).toHaveLength(1);
    const winner = racers.find((r) => r !== null)!;
    expect((await s.getTurn('call-1', 't-1'))).toMatchObject({ claimId: winner.claimId, claimedAt: 2000 });
    expect(await s.claimTurn('call-1', 't-1', { claimId: 'z', claimedAt: 2500 }, 2500)).toBeNull();
    expect(await s.claimTurn('call-1', 't-w', { claimId: 'z', claimedAt: 2000 }, 2000)).toBeNull();
    expect(await s.claimTurn('call-1', 't-x', { claimId: 'z', claimedAt: 6000 }, 6000)).toBeNull();
    await s.moveTurn('call-1', 't-w', { from: ['pending'], to: 'running' });
    expect(await s.claimTurn('call-1', 't-w', { claimId: 'w', claimedAt: 2000 }, 2000)).toMatchObject({ claimId: 'w' });
  });

  it('lists due turns across calls: pending or running, past their time, oldest first, bounded (M9)', async () => {
    await s.createTurn(turn());                                                   // due at 91 000
    await s.createTurn(turn({ turnId: 't-2', status: 'running', kind: 'write', expiresAt: 50_000 }));
    await s.createTurn(turn({ turnId: 't-3', status: 'done', expiresAt: 10_000 }));
    await s.createTurn(turn({ turnId: 't-4', expiresAt: 500_000 }));
    expect((await s.dueTurns(100_000, 10)).map((t) => t.turnId)).toEqual(['t-2', 't-1']);
    expect((await s.dueTurns(100_000, 1)).map((t) => t.turnId)).toEqual(['t-2']);
  });


  it('merges session fields, counts refusals, and reads defaults for a record that has no session', async () => {
    expect(sessionOf((await s.get('call-1'))!).refusedCalls).toBe(0);
    expect(await s.bumpRefused('call-1')).toBe(1);
    expect(await s.bumpRefused('call-1')).toBe(2);
    await s.patchSession('call-1', { ceilingSeconds: 7200, holds: ['h-1'] });
    expect(sessionOf((await s.get('call-1'))!)).toMatchObject({ refusedCalls: 2, ceilingSeconds: 7200, holds: ['h-1'], warned: false });
    expect(await s.bumpRefused('nope')).toBe(0);
    expect(await s.patchSession('nope', { warned: true })).toBeNull();
  });

  it('stores a line with no person, and the name lock never counts it', async () => {
    const stored = await s.appendLine(line({ userId: null, captionId: 'u1' }));
    expect(stored).toMatchObject({ userId: null });
  });
});

describe('SqlAssistantStore turn statements', () => {
  const calls: Array<{ sql: string; params: Array<{ name: string; value: Record<string, unknown> }> }> = [];
  let rows: Record<string, unknown>[] = [];
  const store = () => new SqlAssistantStore(async (sql, params = []) => { calls.push({ sql, params: params as never }); return rows; });
  beforeEach(() => { calls.length = 0; rows = []; });

  it('creates a turn from the call\'s own row (so it carries the tenant) and ignores a repeat', async () => {
    rows = [{ call_id: 'call-1', turn_id: 't-1', asked_by: 'u-vera', tool_name: 'search', tool_args: '{"query":"x"}', kind: 'read', status: 'pending', action_id: null, created_at: '1970-01-01T00:00:01Z', expires_at: '1970-01-01T00:01:31Z' }];
    const out = await store().createTurn(turn());
    expect(calls[0]!.sql).toMatch(/INSERT INTO meeting_assistant_turns[\s\S]*SELECT :call, :turn, tenant[\s\S]*FROM meeting_assistants WHERE call_id = :call[\s\S]*ON CONFLICT \(call_id, turn_id\) DO NOTHING/);
    expect(out).toEqual({ turn: turn(), created: true });
  });

  it('moves a turn in one guarded statement and lists with a status list built from constants', async () => {
    await store().moveTurn('call-1', 't-1', { from: ['pending', 'running'], to: 'done' });
    expect(calls[0]!.sql).toMatch(/UPDATE meeting_assistant_turns SET status = :to[\s\S]*AND status IN \('pending', 'running'\)/);
    await store().listTurns('call-1', { askedBy: 'u-vera', statuses: ['pending'] });
    expect(calls[1]!.sql).toMatch(/asked_by = :asked AND status IN \('pending'\)/);
  });

  it('claims a turn in one conditional update (B6)', async () => {
    rows = [{ call_id: 'call-1', turn_id: 't-1', asked_by: 'u-vera', tool_name: 'search', tool_args: '{}', kind: 'read', status: 'pending', action_id: null, created_at: '1970-01-01T00:00:01Z', expires_at: '1970-01-01T00:01:31Z', claim_id: 'abc', claimed_at: '1970-01-01T00:00:02Z' }];
    const out = await store().claimTurn('call-1', 't-1', { claimId: 'abc', claimedAt: 2000 }, 2000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/UPDATE meeting_assistant_turns SET claim_id = :claim, claimed_at = :at::timestamptz\s+WHERE call_id = :call AND turn_id = :turn AND claim_id IS NULL AND expires_at > :now::timestamptz\s+AND \(\(kind = 'write' AND status = 'running'\) OR \(kind <> 'write' AND status = 'pending'\)\)\s+RETURNING/);
    expect(out).toMatchObject({ claimId: 'abc', claimedAt: 2000 });
    rows = [];
    expect(await store().claimTurn('call-1', 't-1', { claimId: 'def', claimedAt: 3000 }, 3000)).toBeNull();
  });

  it('finds due turns across calls with one bounded statement (M9)', async () => {
    await store().dueTurns(5000, 50);
    expect(calls[0]!.sql).toMatch(/WHERE status IN \('pending', 'running'\) AND expires_at <= :now::timestamptz[\s\S]*LIMIT :limit/);
  });

  it('counts a refusal and merges the session in single statements', async () => {
    rows = [{ refused: 3 }];
    expect(await store().bumpRefused('call-1')).toBe(3);
    expect(calls[0]!.sql).toMatch(/jsonb_set\(session, '\{refusedCalls\}'/);
    await store().patchSession('call-1', { warned: true });
    expect(calls[1]!.sql).toMatch(/session = session \|\| :patch::jsonb/);
  });

  it('maps a row with string or object JSON, and a line row with no person', () => {
    expect(turnFromRow({ call_id: 'c', turn_id: 't', asked_by: 'u', tool_name: 'x', tool_args: { a: 1 }, kind: 'write', status: 'running', action_id: 'a-1', created_at: 1000, expires_at: 2000 }))
      .toMatchObject({ tool: { name: 'x', args: { a: 1 } }, actionId: 'a-1', createdAt: 1000 });
    expect(lineFromRow({ call_id: 'c', seq: 1, user_id: null, participant_id: '', speaker_name: '', text: 'hi', at: 1000, caption_id: 'x', start_ms: null, end_ms: null, speakers: null }).userId).toBeNull();
    expect(recordFromRow({ call_id: 'c', tenant: 't', lobby: 'l', state: 'listening', invited_by: 'u', invited_at: 1000, session: '{"refusedCalls":2}' }).session).toEqual({ refusedCalls: 2 });
  });
});
