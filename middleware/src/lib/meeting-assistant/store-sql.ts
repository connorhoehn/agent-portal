// The SQL store (schema/meeting_assistant_schema.sql), over the RDS Data API's `exec` shape.
// The executor is injected so unit tests can assert the statements and map canned rows
// (__tests__/store-sql.test.ts); production passes providers/aurora.ts `exec`.
//
// Every write that must be atomic is ONE statement: a line's `seq` is claimed by the UPDATE that
// bumps `next_seq`, guarded by `state = 'listening'` and by the caption not being stored yet, and
// the INSERT reads the claimed seq from it. No transaction needed, no lost or doubled line numbers.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { AssistantAction, AssistantRecord, AssistantState, PendingRequest, TranscriptLine } from './types.js';
import { MAX_PENDING_REQUESTS, type ActionChange, type AssistantStore, type StateChange } from './store.js';

export type SqlExec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;

const s = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const sOrNull = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : s(name, value));
const n = (name: string, value: number): SqlParameter => ({ name, value: { longValue: Math.trunc(value) } });
const nOrNull = (name: string, value: number | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : n(name, value));
const LINE_COLUMNS = 'call_id, seq, user_id, participant_id, speaker_name, text, at, caption_id, start_ms, end_ms, speakers';
const ACTION_COLUMNS = 'call_id, action_id, message_id, asked_by, tool_name, args_digest, status, created_at, decided_by, decided_at, result_text';
const iso = (ms: number): string => new Date(ms).toISOString();

const COLUMNS = `call_id, tenant, lobby, initiative_id, state, invited_by, invited_at, paused_by, left_at, left_by,
  acked, attendees, present_at_invite, requests, lines_stored, next_seq, pending_requests`;

const json = <T>(v: unknown, fallback: T): T => {
  if (Array.isArray(v)) return v as T;
  if (typeof v === 'string' && v) { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return fallback;
};
const ms = (v: unknown): number => (typeof v === 'number' ? v : Date.parse(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d(:?\d\d)?$/.test(String(v)) ? '' : 'Z')));
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : ms(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function recordFromRow(r: Record<string, unknown>): AssistantRecord {
  return {
    callId: str(r['call_id']), tenant: str(r['tenant']), lobby: str(r['lobby']), initiativeId: strOrNull(r['initiative_id']),
    state: str(r['state']) as AssistantState, invitedBy: str(r['invited_by']), invitedAt: ms(r['invited_at']),
    pausedBy: strOrNull(r['paused_by']), leftAt: msOrNull(r['left_at']), leftBy: strOrNull(r['left_by']),
    acked: json<string[]>(r['acked'], []), attendees: json<string[]>(r['attendees'], []),
    presentAtInvite: json<string[]>(r['present_at_invite'], []),
    requests: Number(r['requests'] ?? 0), linesStored: Number(r['lines_stored'] ?? 0), nextSeq: Number(r['next_seq'] ?? 1),
    pendingRequests: json<PendingRequest[]>(r['pending_requests'], []),
  };
}

export function lineFromRow(r: Record<string, unknown>): TranscriptLine {
  return { callId: str(r['call_id']), seq: Number(r['seq']), userId: str(r['user_id']), participantId: str(r['participant_id']),
    speakerName: str(r['speaker_name']), text: str(r['text']), at: ms(r['at']), captionId: str(r['caption_id']),
    ...(r['start_ms'] != null ? { startMs: Number(r['start_ms']) } : {}), ...(r['end_ms'] != null ? { endMs: Number(r['end_ms']) } : {}),
    ...(r['speakers'] != null ? { speakers: json<string[]>(r['speakers'], []) } : {}) };
}

export function actionFromRow(r: Record<string, unknown>): AssistantAction {
  return { callId: str(r['call_id']), actionId: str(r['action_id']), messageId: str(r['message_id']), askedBy: str(r['asked_by']),
    toolName: str(r['tool_name']), argsDigest: str(r['args_digest']), status: str(r['status']) as AssistantAction['status'],
    createdAt: ms(r['created_at']), decidedBy: strOrNull(r['decided_by']), decidedAt: msOrNull(r['decided_at']), resultText: strOrNull(r['result_text']) };
}

/** The states a column list may name: constants only, never request input. */
const list = (states: readonly string[]): string => states.map((x) => `'${x}'`).join(', ');

export class SqlAssistantStore implements AssistantStore {
  constructor(private readonly exec: SqlExec) {}

  async get(callId: string) {
    const rows = await this.exec(`SELECT ${COLUMNS} FROM meeting_assistants WHERE call_id = :call`, [s('call', callId)]);
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async create(record: AssistantRecord) {
    const rows = await this.exec(
      `INSERT INTO meeting_assistants (call_id, tenant, lobby, initiative_id, state, invited_by, invited_at, acked, attendees, present_at_invite)
       VALUES (:call, :tenant, :lobby, :initiative, :state, :by, :at::timestamptz, :acked::jsonb, :attendees::jsonb, :present::jsonb)
       ON CONFLICT (call_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [s('call', record.callId), s('tenant', record.tenant), s('lobby', record.lobby), sOrNull('initiative', record.initiativeId),
        s('state', record.state), s('by', record.invitedBy), s('at', iso(record.invitedAt)), s('acked', JSON.stringify(record.acked)),
        s('attendees', JSON.stringify(record.attendees)), s('present', JSON.stringify(record.presentAtInvite))],
    );
    if (rows[0]) return { record: recordFromRow(rows[0]), created: true };
    const existing = await this.get(record.callId);
    if (!existing) throw new Error('meeting assistant record vanished between insert and read');
    return { record: existing, created: false };
  }

  async transition(callId: string, change: StateChange) {
    const rows = await this.exec(
      `UPDATE meeting_assistants SET state = :to,
         paused_by = CASE WHEN :to = 'paused' THEN :by WHEN :to = 'listening' THEN NULL ELSE paused_by END,
         left_at = CASE WHEN :to = 'left' THEN :at::timestamptz ELSE left_at END,
         left_by = CASE WHEN :to = 'left' THEN :by ELSE left_by END,
         updated_at = now()
       WHERE call_id = :call AND state IN (${list(change.from)})
       RETURNING ${COLUMNS}`,
      [s('call', callId), s('to', change.to), s('by', change.by), s('at', iso(change.at))],
    );
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async ack(callId: string, userId: string) {
    const rows = await this.exec(
      `UPDATE meeting_assistants SET
         acked = CASE WHEN acked @> to_jsonb(:user::text) THEN acked ELSE acked || to_jsonb(:user::text) END,
         attendees = CASE WHEN attendees @> to_jsonb(:user::text) THEN attendees ELSE attendees || to_jsonb(:user::text) END,
         updated_at = now()
       WHERE call_id = :call
       RETURNING ${COLUMNS}`,
      [s('call', callId), s('user', userId)],
    );
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async attend(callId: string, userId: string) {
    await this.exec(
      `UPDATE meeting_assistants SET attendees = attendees || to_jsonb(:user::text), updated_at = now()
       WHERE call_id = :call AND NOT (attendees @> to_jsonb(:user::text))`,
      [s('call', callId), s('user', userId)],
    );
  }

  async appendLine(line: Omit<TranscriptLine, 'seq'>) {
    const rows = await this.exec(
      `WITH claimed AS (
         UPDATE meeting_assistants SET next_seq = next_seq + 1, lines_stored = lines_stored + 1, updated_at = now()
         WHERE call_id = :call AND state = 'listening'
           AND NOT EXISTS (SELECT 1 FROM meeting_transcript_lines WHERE call_id = :call AND caption_id = :caption)
         RETURNING call_id, tenant, next_seq - 1 AS seq)
       INSERT INTO meeting_transcript_lines (call_id, seq, tenant, user_id, participant_id, speaker_name, text, at, caption_id, start_ms, end_ms, speakers)
       SELECT call_id, seq, tenant, :user, :participant, :speaker, :text, :at::timestamptz, :caption, :start, :end, :speakers::jsonb FROM claimed
       RETURNING ${LINE_COLUMNS}`,
      [s('call', line.callId), s('caption', line.captionId), s('user', line.userId), s('participant', line.participantId),
        s('speaker', line.speakerName), s('text', line.text), s('at', iso(line.at)),
        nOrNull('start', line.startMs ?? null), nOrNull('end', line.endMs ?? null),
        sOrNull('speakers', line.speakers ? JSON.stringify(line.speakers) : null)],
    );
    return rows[0] ? lineFromRow(rows[0]) : null;
  }

  async addRequest(callId: string, request: PendingRequest) {
    // Append, then keep the newest MAX_PENDING_REQUESTS: jsonb arrays are sliced by index.
    await this.exec(
      `UPDATE meeting_assistants SET requests = requests + 1,
         pending_requests = (
           SELECT COALESCE(jsonb_agg(e ORDER BY i), '[]'::jsonb) FROM (
             SELECT e, i FROM jsonb_array_elements(pending_requests || :request::jsonb) WITH ORDINALITY AS t(e, i)
             ORDER BY i DESC LIMIT ${MAX_PENDING_REQUESTS}) kept),
         updated_at = now()
       WHERE call_id = :call`,
      [s('call', callId), s('request', JSON.stringify([request]))],
    );
  }

  async lines(callId: string, after: number, limit: number) {
    const rows = await this.exec(
      `SELECT ${LINE_COLUMNS} FROM meeting_transcript_lines
       WHERE call_id = :call AND seq > :after ORDER BY seq ASC LIMIT :limit`,
      [s('call', callId), n('after', after), n('limit', limit)],
    );
    return rows.map(lineFromRow);
  }

  async createAction(action: AssistantAction) {
    const rows = await this.exec(
      `INSERT INTO meeting_assistant_actions (call_id, action_id, tenant, message_id, asked_by, tool_name, args_digest, status, created_at)
       SELECT :call, :action, tenant, :message, :asked, :tool, :digest, :status, :at::timestamptz FROM meeting_assistants WHERE call_id = :call
       ON CONFLICT (call_id, action_id) DO NOTHING
       RETURNING ${ACTION_COLUMNS}`,
      [s('call', action.callId), s('action', action.actionId), s('message', action.messageId), s('asked', action.askedBy),
        s('tool', action.toolName), s('digest', action.argsDigest), s('status', action.status), s('at', iso(action.createdAt))],
    );
    if (rows[0]) return { action: actionFromRow(rows[0]), created: true };
    const existing = await this.getAction(action.callId, action.actionId);
    if (!existing) throw new Error('meeting assistant action vanished between insert and read (or the call has no assistant)');
    return { action: existing, created: false };
  }

  async getAction(callId: string, actionId: string) {
    const rows = await this.exec(`SELECT ${ACTION_COLUMNS} FROM meeting_assistant_actions WHERE call_id = :call AND action_id = :action`,
      [s('call', callId), s('action', actionId)]);
    return rows[0] ? actionFromRow(rows[0]) : null;
  }

  async decideAction(callId: string, actionId: string, change: ActionChange) {
    const rows = await this.exec(
      `UPDATE meeting_assistant_actions SET status = :to, decided_by = :by, decided_at = :at::timestamptz,
         result_text = COALESCE(:result, result_text)
       WHERE call_id = :call AND action_id = :action AND status IN (${list(change.from)})
       RETURNING ${ACTION_COLUMNS}`,
      [s('call', callId), s('action', actionId), s('to', change.to), s('by', change.by), s('at', iso(change.at)),
        sOrNull('result', change.resultText ?? null)],
    );
    return rows[0] ? actionFromRow(rows[0]) : null;
  }

  async sweepLines(cutoffMs: number) {
    const rows = await this.exec(
      `WITH gone AS (DELETE FROM meeting_transcript_lines WHERE at <= :cutoff::timestamptz RETURNING 1) SELECT count(*) AS removed FROM gone`,
      [s('cutoff', iso(cutoffMs))],
    );
    return Number(rows[0]?.['removed'] ?? 0);
  }
}
