// The actions collection (memory store and SQL statements) and the chat message kinds' metadata contracts.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { MemoryAssistantStore } from '../store.js';
import { SqlAssistantStore, actionFromRow } from '../store-sql.js';
import type { AssistantAction } from '../types.js';
import { claimsAssistant, parseAssistantMetadata, isAssistantKind, isAssistantUserId, ASSISTANT_USER_ID, ASSISTANT_NAME } from '../chat-types.js';
import { noticeText } from '../chat.js';

const action = (over: Partial<AssistantAction> = {}): AssistantAction => ({
  callId: 'call-1', actionId: 'act-1', messageId: 'm1', askedBy: 'u-vera', toolName: 'create_work_item', argsDigest: 'sha256:ab', status: 'waiting',
  createdAt: 1000, decidedBy: null, decidedAt: null, resultText: null, ...over,
});

describe('MemoryAssistantStore actions', () => {
  let s: MemoryAssistantStore;
  beforeEach(() => { s = new MemoryAssistantStore(); });

  it('creates once per (call, actionId); a second create returns what is there', async () => {
    expect((await s.createAction(action())).created).toBe(true);
    const again = await s.createAction(action({ messageId: 'm2', askedBy: 'u-other' }));
    expect(again.created).toBe(false);
    expect(again.action).toMatchObject({ messageId: 'm1', askedBy: 'u-vera' });
    expect((await s.createAction(action({ callId: 'call-2' }))).created).toBe(true);
    expect(await s.getAction('call-1', 'nope')).toBeNull();
  });

  it('decides only from the allowed statuses, records who and when, and returns copies', async () => {
    await s.createAction(action());
    const done = await s.decideAction('call-1', 'act-1', { from: ['waiting'], to: 'confirmed', by: 'u-vera', at: 2000 });
    expect(done).toMatchObject({ status: 'confirmed', decidedBy: 'u-vera', decidedAt: 2000 });
    expect(await s.decideAction('call-1', 'act-1', { from: ['waiting'], to: 'declined', by: 'u-vera', at: 3000 })).toBeNull();
    expect(await s.decideAction('call-1', 'missing', { from: ['waiting'], to: 'declined', by: 'x', at: 1 })).toBeNull();
    const finished = await s.decideAction('call-1', 'act-1', { from: ['confirmed'], to: 'done', by: 'system', at: 4000, resultText: 'Created.' });
    expect(finished).toMatchObject({ status: 'done', resultText: 'Created.' });
    finished!.status = 'failed';
    expect((await s.getAction('call-1', 'act-1'))!.status).toBe('done');
  });
});

describe('SqlAssistantStore actions', () => {
  const calls: { sql: string; params: { name?: string; value?: unknown }[] }[] = [];
  let rows: Record<string, unknown>[];
  const store = () => new SqlAssistantStore(async (sql, params = []) => { calls.push({ sql, params }); return rows; });
  const norm = (sql: string) => sql.replace(/\s+/g, ' ');
  const row = { call_id: 'call-1', action_id: 'act-1', message_id: 'm1', asked_by: 'u-vera', tool_name: 't', args_digest: 'd', status: 'confirmed',
    created_at: '2026-11-13 10:00:00', decided_by: 'u-vera', decided_at: '2026-11-13 10:01:00', result_text: null };
  beforeEach(() => { calls.length = 0; rows = []; });

  it('createAction inserts under the call\'s tenant, conflicts to a read, and binds every value', async () => {
    let n = 0;
    const s = new SqlAssistantStore(async (sql, params = []) => { calls.push({ sql, params }); return n++ === 0 ? [] : [row]; });
    const out = await s.createAction(action({ summary: undefined } as never));
    const sql = norm(calls[0]!.sql);
    expect(sql).toContain('INSERT INTO meeting_assistant_actions');
    expect(sql).toContain('FROM meeting_assistants WHERE call_id = :call');
    expect(sql).toContain('ON CONFLICT (call_id, action_id) DO NOTHING');
    expect(out.created).toBe(false);
    expect(out.action).toMatchObject({ actionId: 'act-1', status: 'confirmed', decidedBy: 'u-vera', decidedAt: Date.parse('2026-11-13T10:01:00Z') });
  });

  it('decideAction is one guarded UPDATE: constant statuses in the text, everything else bound', async () => {
    rows = [row];
    const out = await store().decideAction('call-1', "act'; DROP TABLE x;--", { from: ['waiting'], to: 'confirmed', by: "u'; --", at: 5 });
    const sql = norm(calls[0]!.sql);
    expect(sql).toContain("WHERE call_id = :call AND action_id = :action AND status IN ('waiting')");
    expect(sql).not.toContain('DROP');
    expect(calls[0]!.params.find((p) => p.name === 'by')).toBeTruthy();
    expect(out!.status).toBe('confirmed');
    rows = [];
    expect(await store().decideAction('call-1', 'act-1', { from: ['waiting'], to: 'declined', by: 'u', at: 1 })).toBeNull();
  });

  it('getAction reads by call and id; rows map to the action shape', async () => {
    rows = [row];
    expect((await store().getAction('call-1', 'act-1'))!.messageId).toBe('m1');
    expect(norm(calls[0]!.sql)).toContain('WHERE call_id = :call AND action_id = :action');
    expect(actionFromRow(row).resultText).toBeNull();
  });
});

describe('message kinds', () => {
  it('claimsAssistant flags the marker and any assistant-… kind, and nothing else', () => {
    expect(claimsAssistant({ assistant: true })).toBe(true);
    expect(claimsAssistant({ assistant: false })).toBe(true);
    for (const kind of ['assistant-notice', 'assistant-reply', 'assistant-action', 'assistant-whatever']) expect(claimsAssistant({ kind })).toBe(true);
    for (const m of [undefined, null, {}, { kind: 'call' }, { kind: 'document' }, { displayName: 'Milo' }, { clientDeliveryId: 'x' }]) expect(claimsAssistant(m as never)).toBe(false);
    expect(isAssistantKind('assistant-notice')).toBe(true); expect(isAssistantKind('call')).toBe(false); expect(isAssistantKind(5)).toBe(false);
    expect(ASSISTANT_USER_ID).toBe('agent:meeting-assistant'); expect(ASSISTANT_NAME).toBe('Milo');
  });
  it('the author id: the one written now and the one messages were stored under before the rename are both the assistant\'s', () => {
    expect(isAssistantUserId(ASSISTANT_USER_ID)).toBe(true);
    expect(isAssistantUserId('agent:nova')).toBe(true);
    for (const id of ['alice', 'agent:milo', 'agent:', '', null, undefined]) expect(isAssistantUserId(id)).toBe(false);
  });
  it('a stored message keeps the name it was posted under; one without a usable name reads as the name now', () => {
    expect(parseAssistantMetadata({ assistant: true, displayName: 'Nova', kind: 'assistant-notice' })).toEqual({ assistant: true, displayName: 'Nova', kind: 'assistant-notice' });
    for (const displayName of [undefined, '', 42, 'x'.repeat(65)]) {
      expect(parseAssistantMetadata({ assistant: true, displayName, kind: 'assistant-notice' })).toEqual({ assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-notice' });
    }
  });

  const base = { assistant: true, displayName: 'Milo' };
  it('parses the three kinds and drops anything outside the contract', () => {
    expect(parseAssistantMetadata({ ...base, kind: 'assistant-notice', extra: 1 })).toEqual({ ...base, kind: 'assistant-notice' });
    expect(parseAssistantMetadata({ ...base, kind: 'assistant-reply', askedBy: 'u', askedByName: 'Una', private: false, text: 'hidden' }))
      .toEqual({ ...base, kind: 'assistant-reply', askedBy: 'u', askedByName: 'Una', private: false });
    const card = { ...base, kind: 'assistant-action', actionId: 'a1', askedBy: 'u', askedByName: 'Una', summary: 'Do it', detail: ['one', 'two'],
      tool: { name: 't', argsDigest: 'd' }, status: 'waiting', resultText: 'ok' };
    expect(parseAssistantMetadata(card)).toEqual(card);
    for (const status of ['confirmed', 'declined', 'expired', 'done', 'failed']) expect(parseAssistantMetadata({ ...card, status })!).toMatchObject({ status });
    // the card's headline and plain-words line ride along; over-long or empty ones are dropped
    expect(parseAssistantMetadata({ ...card, title: 'the cookie bug', does: 'Creates a work item' })).toEqual({ ...card, title: 'the cookie bug', does: 'Creates a work item' });
    expect(parseAssistantMetadata({ ...card, title: 'x'.repeat(201), does: '' })).toEqual(card);
  });

  it('refuses malformed metadata: no marker, unknown kind, missing fields, bad status, a private reply as a chat message', () => {
    expect(parseAssistantMetadata({ kind: 'assistant-notice' })).toBeNull();
    expect(parseAssistantMetadata({ assistant: false, kind: 'assistant-notice' })).toBeNull();
    expect(parseAssistantMetadata({ ...base, kind: 'assistant-other' })).toBeNull();
    expect(parseAssistantMetadata({ ...base, kind: 'assistant-reply', askedBy: 'u' })).toBeNull();
    const card = { ...base, kind: 'assistant-action', actionId: 'a1', askedBy: 'u', askedByName: 'Una', summary: 'Do it', tool: { name: 't', argsDigest: 'd' }, status: 'waiting' };
    expect(parseAssistantMetadata({ ...card, status: 'pending' })).toBeNull();
    expect(parseAssistantMetadata({ ...card, tool: { name: 't' } })).toBeNull();
    expect(parseAssistantMetadata({ ...card, actionId: '' })).toBeNull();
    expect(parseAssistantMetadata('x')).toBeNull(); expect(parseAssistantMetadata(null)).toBeNull(); expect(parseAssistantMetadata([])).toBeNull();
    expect(parseAssistantMetadata({ ...base, kind: 'assistant-reply', askedBy: 'u', askedByName: 'Una', private: true })).toEqual({ ...base, kind: 'assistant-reply', askedBy: 'u', askedByName: 'Una' });
  });

  it('the notice sentences are plain, name the person, and carry the configured retention', () => {
    expect(noticeText.joined('Una', 30)).toBe("Milo joined at Una's invitation. Once you acknowledge, what you say is sent to the speech provider and kept as text for 30 days. Milo writes minutes for the people in the call and leaves after 60 minutes. Anyone here can pause Milo, or dismiss it for everyone.");
    // Sweep 4 in-call 12: a seated person whose first name is Milo or Mylo is named in one sentence; nobody else adds one.
    expect(noticeText.nameTwins(['Una Bell', 'Milo Park'])).toBe(' Milo Park is also in this call. Milo takes anything said to "Milo" as a request for itself, so call them by their last name.');
    expect(noticeText.nameTwins(['Milo Park', 'Mylo Chen'])).toBe(' Milo Park and Mylo Chen are also in this call. Milo takes anything said to "Milo" as a request for itself, so call them by their last names.');
    expect(noticeText.nameTwins(['Una Bell'])).toBe('');
    expect(noticeText.paused('Una')).toBe('Una paused Milo. Nothing is being heard or stored.');
    expect(noticeText.dismissed('Una')).toBe('Una dismissed Milo.');
    for (const text of [noticeText.joined('Una', 7), noticeText.paused('Una'), noticeText.resumed('Una'), noticeText.dismissed('Una')]) expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(noticeText.joined('Una', 7)).toContain('7 days');
  });
});
