// The SQL store (schema/meeting_assistant_schema.sql), over the RDS Data API's `exec` shape.
// The executor is injected so unit tests can assert the statements and map canned rows
// (__tests__/store-sql.test.ts); production passes providers/aurora.ts `exec`.
//
// Every write that must be atomic is ONE statement: a line's `seq` is claimed by the UPDATE that
// bumps `next_seq`, guarded by `state = 'listening'` and by the caption not being stored yet, and
// the INSERT reads the claimed seq from it. No transaction needed, no lost or doubled line numbers.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { AssistantAction, AssistantRecord, MinutesActionItem, MinutesRecord, MinutesWriterKind, AssistantSession, AssistantState, AssistantTurn, PendingRequest, TranscriptLine, TurnKind, TurnStatus } from './types.js';
import { MAX_PENDING_REQUESTS, type ActionChange, type AssistantStore, type MinutesFilter, type StateChange, type TurnChange, type TurnFilter } from './store.js';

export type SqlExec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;

const s = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const sOrNull = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : s(name, value));
const n = (name: string, value: number): SqlParameter => ({ name, value: { longValue: Math.trunc(value) } });
const nOrNull = (name: string, value: number | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : n(name, value));
const LINE_COLUMNS = 'call_id, seq, user_id, participant_id, speaker_name, text, at, caption_id, start_ms, end_ms, speakers';
const ACTION_COLUMNS = 'call_id, action_id, message_id, asked_by, tool_name, args_digest, status, created_at, decided_by, decided_at, result_text';
const TURN_COLUMNS = 'call_id, turn_id, asked_by, tool_name, tool_args, kind, status, action_id, created_at, expires_at';
const iso = (ms: number): string => new Date(ms).toISOString();

const COLUMNS = `call_id, tenant, lobby, initiative_id, state, invited_by, invited_at, paused_by, left_at, left_by,
  acked, attendees, present_at_invite, requests, lines_stored, next_seq, pending_requests, session`;

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
    ...(r['session'] != null ? { session: jsonObject<Partial<AssistantSession>>(r['session']) as AssistantSession } : {}),
  };
}

const jsonObject = <T>(v: unknown): T => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as T;
  if (typeof v === 'string' && v) { try { const p: unknown = JSON.parse(v); if (p && typeof p === 'object') return p as T; } catch { /* below */ } }
  return {} as T;
};

const jsonValue = (v: unknown): unknown => {
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v) as unknown; } catch { return null; }
};

export function turnFromRow(r: Record<string, unknown>): AssistantTurn {
  return { turnId: str(r['turn_id']), callId: str(r['call_id']), askedBy: str(r['asked_by']), tool: { name: str(r['tool_name']), args: jsonValue(r['tool_args']) },
    kind: str(r['kind']) as TurnKind, status: str(r['status']) as TurnStatus, ...(r['action_id'] != null ? { actionId: str(r['action_id']) } : {}),
    createdAt: ms(r['created_at']), expiresAt: ms(r['expires_at']) };
}

export function lineFromRow(r: Record<string, unknown>): TranscriptLine {
  return { callId: str(r['call_id']), seq: Number(r['seq']), userId: strOrNull(r['user_id']), participantId: str(r['participant_id']),
    speakerName: str(r['speaker_name']), text: str(r['text']), at: ms(r['at']), captionId: str(r['caption_id']),
    ...(r['start_ms'] != null ? { startMs: Number(r['start_ms']) } : {}), ...(r['end_ms'] != null ? { endMs: Number(r['end_ms']) } : {}),
    ...(r['speakers'] != null ? { speakers: json<string[]>(r['speakers'], []) } : {}) };
}

export function actionFromRow(r: Record<string, unknown>): AssistantAction {
  return { callId: str(r['call_id']), actionId: str(r['action_id']), messageId: str(r['message_id']), askedBy: str(r['asked_by']),
    toolName: str(r['tool_name']), argsDigest: str(r['args_digest']), status: str(r['status']) as AssistantAction['status'],
    createdAt: ms(r['created_at']), decidedBy: strOrNull(r['decided_by']), decidedAt: msOrNull(r['decided_at']), resultText: strOrNull(r['result_text']) };
}

const MINUTES_COLUMNS = 'call_id, tenant, lobby, initiative_id, call_name, started_at, ended_at, invited_by, attendees, summary, decisions, action_items, topics, line_count, truncated, writer, created_at, deleted_at, deleted_by';

export function minutesFromRow(r: Record<string, unknown>): MinutesRecord {
  return {
    callId: str(r['call_id']), tenant: str(r['tenant']), lobby: str(r['lobby']), initiativeId: strOrNull(r['initiative_id']), callName: str(r['call_name']),
    startedAt: ms(r['started_at']), endedAt: ms(r['ended_at']), invitedBy: str(r['invited_by']), attendees: json<string[]>(r['attendees'], []),
    summary: str(r['summary']), decisions: json<string[]>(r['decisions'], []), actionItems: json<MinutesActionItem[]>(r['action_items'], []), topics: json<string[]>(r['topics'], []),
    lineCount: Number(r['line_count'] ?? 0), truncated: r['truncated'] === true || r['truncated'] === 't', writer: str(r['writer']) as MinutesWriterKind, createdAt: ms(r['created_at']),
    ...(r['deleted_at'] != null ? { deleted: { at: ms(r['deleted_at']), by: str(r['deleted_by']) } } : {}),
  };
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
      `INSERT INTO meeting_assistants (call_id, tenant, lobby, initiative_id, state, invited_by, invited_at, acked, attendees, present_at_invite, session)
       VALUES (:call, :tenant, :lobby, :initiative, :state, :by, :at::timestamptz, :acked::jsonb, :attendees::jsonb, :present::jsonb, :session::jsonb)
       ON CONFLICT (call_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [s('call', record.callId), s('tenant', record.tenant), s('lobby', record.lobby), sOrNull('initiative', record.initiativeId),
        s('state', record.state), s('by', record.invitedBy), s('at', iso(record.invitedAt)), s('acked', JSON.stringify(record.acked)),
        s('attendees', JSON.stringify(record.attendees)), s('present', JSON.stringify(record.presentAtInvite)),
        s('session', JSON.stringify(record.session ?? {}))],
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
       WHERE call_id = :call AND state <> 'left' AND NOT (attendees @> to_jsonb(:user::text))`,
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
      [s('call', line.callId), s('caption', line.captionId), sOrNull('user', line.userId), s('participant', line.participantId),
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

  async patchSession(callId: string, patch: Partial<AssistantSession>) {
    const rows = await this.exec(
      `UPDATE meeting_assistants SET session = session || :patch::jsonb, updated_at = now() WHERE call_id = :call RETURNING ${COLUMNS}`,
      [s('call', callId), s('patch', JSON.stringify(patch))],
    );
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async bumpRefused(callId: string) {
    const rows = await this.exec(
      `UPDATE meeting_assistants SET
         session = jsonb_set(session, '{refusedCalls}', to_jsonb(COALESCE((session->>'refusedCalls')::int, 0) + 1)), updated_at = now()
       WHERE call_id = :call RETURNING (session->>'refusedCalls')::int AS refused`,
      [s('call', callId)],
    );
    return Number(rows[0]?.['refused'] ?? 0);
  }

  async createTurn(turn: AssistantTurn) {
    const rows = await this.exec(
      `INSERT INTO meeting_assistant_turns (call_id, turn_id, tenant, asked_by, tool_name, tool_args, kind, status, action_id, created_at, expires_at)
       SELECT :call, :turn, tenant, :asked, :tool, :args::jsonb, :kind, :status, :action, :at::timestamptz, :expires::timestamptz
       FROM meeting_assistants WHERE call_id = :call
       ON CONFLICT (call_id, turn_id) DO NOTHING
       RETURNING ${TURN_COLUMNS}`,
      [s('call', turn.callId), s('turn', turn.turnId), s('asked', turn.askedBy), s('tool', turn.tool.name), s('args', JSON.stringify(turn.tool.args ?? null)),
        s('kind', turn.kind), s('status', turn.status), sOrNull('action', turn.actionId ?? null), s('at', iso(turn.createdAt)), s('expires', iso(turn.expiresAt))],
    );
    if (rows[0]) return { turn: turnFromRow(rows[0]), created: true };
    const existing = await this.getTurn(turn.callId, turn.turnId);
    if (!existing) throw new Error('meeting assistant turn vanished between insert and read (or the call has no assistant)');
    return { turn: existing, created: false };
  }

  async getTurn(callId: string, turnId: string) {
    const rows = await this.exec(`SELECT ${TURN_COLUMNS} FROM meeting_assistant_turns WHERE call_id = :call AND turn_id = :turn`, [s('call', callId), s('turn', turnId)]);
    return rows[0] ? turnFromRow(rows[0]) : null;
  }

  async listTurns(callId: string, filter: TurnFilter = {}) {
    const rows = await this.exec(
      `SELECT ${TURN_COLUMNS} FROM meeting_assistant_turns
       WHERE call_id = :call${filter.askedBy ? ' AND asked_by = :asked' : ''}${filter.statuses ? ` AND status IN (${list(filter.statuses)})` : ''}
       ORDER BY created_at ASC, turn_id ASC`,
      [s('call', callId), ...(filter.askedBy ? [s('asked', filter.askedBy)] : [])],
    );
    return rows.map(turnFromRow);
  }

  async dueTurns(nowMs: number, limit: number) {
    const rows = await this.exec(
      `SELECT ${TURN_COLUMNS} FROM meeting_assistant_turns
       WHERE status IN ('pending', 'running') AND expires_at <= :now::timestamptz
       ORDER BY expires_at ASC, turn_id ASC LIMIT :limit`,
      [s('now', iso(nowMs)), n('limit', limit)],
    );
    return rows.map(turnFromRow);
  }

  async moveTurn(callId: string, turnId: string, change: TurnChange) {
    const rows = await this.exec(
      `UPDATE meeting_assistant_turns SET status = :to, action_id = COALESCE(:action, action_id)
       WHERE call_id = :call AND turn_id = :turn AND status IN (${list(change.from)})
       RETURNING ${TURN_COLUMNS}`,
      [s('call', callId), s('turn', turnId), s('to', change.to), sOrNull('action', change.actionId ?? null)],
    );
    return rows[0] ? turnFromRow(rows[0]) : null;
  }

  async sweepLines(cutoffMs: number) {
    const rows = await this.exec(
      `WITH gone AS (DELETE FROM meeting_transcript_lines WHERE at <= :cutoff::timestamptz RETURNING 1) SELECT count(*) AS removed FROM gone`,
      [s('cutoff', iso(cutoffMs))],
    );
    return Number(rows[0]?.['removed'] ?? 0);
  }
  async getMinutes(callId: string) {
    const rows = await this.exec(`SELECT ${MINUTES_COLUMNS} FROM meeting_minutes WHERE call_id = :call`, [s('call', callId)]);
    return rows[0] ? minutesFromRow(rows[0]) : null;
  }

  async putMinutes(m: MinutesRecord) {
    const rows = await this.exec(
      `INSERT INTO meeting_minutes (call_id, tenant, lobby, initiative_id, call_name, started_at, ended_at, invited_by, attendees, summary, decisions, action_items, topics, line_count, truncated, writer, created_at)
       VALUES (:call, :tenant, :lobby, :initiative, :name, :started::timestamptz, :ended::timestamptz, :by, :attendees::jsonb, :summary, :decisions::jsonb, :items::jsonb, :topics::jsonb, :lines, :truncated, :writer, :created::timestamptz)
       ON CONFLICT (call_id) DO NOTHING
       RETURNING ${MINUTES_COLUMNS}`,
      [s('call', m.callId), s('tenant', m.tenant), s('lobby', m.lobby), sOrNull('initiative', m.initiativeId), s('name', m.callName), s('started', iso(m.startedAt)), s('ended', iso(m.endedAt)),
        s('by', m.invitedBy), s('attendees', JSON.stringify(m.attendees)), s('summary', m.summary), s('decisions', JSON.stringify(m.decisions)), s('items', JSON.stringify(m.actionItems)),
        s('topics', JSON.stringify(m.topics)), n('lines', m.lineCount), { name: 'truncated', value: { booleanValue: m.truncated } }, s('writer', m.writer), s('created', iso(m.createdAt))],
    );
    if (rows[0]) return { minutes: minutesFromRow(rows[0]), created: true };
    const existing = await this.getMinutes(m.callId);
    if (!existing) throw new Error('meeting minutes vanished between insert and read (or the call has no assistant)');
    return { minutes: existing, created: false };
  }

  async listMinutes(f: MinutesFilter) {
    const rows = await this.exec(
      `SELECT ${MINUTES_COLUMNS} FROM meeting_minutes
       WHERE tenant = :tenant AND deleted_at IS NULL AND attendees ? :user${f.initiativeId ? ' AND initiative_id = :initiative' : ''}${f.before !== undefined ? ' AND ended_at < :before::timestamptz' : ''}
       ORDER BY ended_at DESC, call_id ASC LIMIT :limit`,
      [s('tenant', f.tenant), s('user', f.userId), ...(f.initiativeId ? [s('initiative', f.initiativeId)] : []), ...(f.before !== undefined ? [s('before', iso(f.before))] : []), n('limit', f.limit)],
    );
    return rows.map(minutesFromRow);
  }

  async tombstoneMinutes(callId: string, by: string, at: number) {
    // One statement: the lines go, and the minutes row is written or blanked as a tombstone. A call with no assistant record has nothing to hold the row.
    const rows = await this.exec(
      `WITH gone AS (DELETE FROM meeting_transcript_lines WHERE call_id = :call RETURNING 1),
            marked AS (
              INSERT INTO meeting_minutes (call_id, tenant, lobby, initiative_id, started_at, ended_at, invited_by, writer, created_at, deleted_at, deleted_by)
              SELECT call_id, tenant, lobby, initiative_id, invited_at, COALESCE(left_at, invited_at), invited_by, 'none', :at::timestamptz, :at::timestamptz, :by
              FROM meeting_assistants WHERE call_id = :call
              ON CONFLICT (call_id) DO UPDATE SET call_name = '', attendees = '[]'::jsonb, summary = '', decisions = '[]'::jsonb, action_items = '[]'::jsonb, topics = '[]'::jsonb,
                line_count = 0, truncated = false, writer = 'none', deleted_at = :at::timestamptz, deleted_by = :by
              RETURNING 1)
       SELECT (SELECT count(*) FROM gone) AS removed`,
      [s('call', callId), s('at', iso(at)), s('by', by)],
    );
    return Number(rows[0]?.['removed'] ?? 0);
  }

  async sweepMinutes(cutoffMs: number) {
    const rows = await this.exec(
      `WITH gone AS (DELETE FROM meeting_minutes WHERE created_at <= :cutoff::timestamptz RETURNING 1) SELECT count(*) AS removed FROM gone`,
      [s('cutoff', iso(cutoffMs))],
    );
    return Number(rows[0]?.['removed'] ?? 0);
  }
}
