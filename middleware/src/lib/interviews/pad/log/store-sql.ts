// The pad log's SQL store (schema/interviews_schema.sql `interview_pad_events`), over the RDS Data API's `exec` shape,
// injected as lib/interviews/milo-notes/store-sql.ts injects it so the contract test runs the statements against
// canned rows. Timestamps travel as ISO text, CAST in the statement; a post's events travel as one JSON array.
//
// Append-only in the statements themselves: one INSERT … SELECT, the reads, and the retention DELETE by interview. No
// UPDATE. The `seq` of a post is the interview's last plus the event's place in the post, worked out inside the INSERT;
// two posts racing for the same `seq` meet the primary key, and the loser is tried again on the new last (up to three
// times), so the numbers only grow and never repeat.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../../store-sql.js';
import type { PadEventKind, PadSide } from './rules.js';
import type { NewPadEvent, PadEventRecord, PadLogCounts, PadLogStore } from './store.js';

const COLUMNS = 'interview_id, seq, at, client_at, who_id, side, kind, from_pos, inserted, deleted, doc_length, lines, via, language, question_id, text';

export const COUNT_PAD_EVENTS_SQL = `SELECT COUNT(*) AS events, COUNT(*) FILTER (WHERE kind = 'snapshot') AS snapshots, COALESCE(MAX(seq), 0) AS last_seq
  FROM interview_pad_events WHERE interview_id = :interview_id`;
export const INSERT_PAD_EVENTS_SQL = `INSERT INTO interview_pad_events (${COLUMNS})
  SELECT :interview_id, base.last_seq + e.ord, CAST(e.ev->>'at' AS TIMESTAMPTZ), CAST(e.ev->>'clientAt' AS TIMESTAMPTZ), e.ev->>'whoId', e.ev->>'side', e.ev->>'kind',
    CAST(e.ev->>'from' AS INTEGER), CAST(e.ev->>'inserted' AS INTEGER), CAST(e.ev->>'deleted' AS INTEGER), CAST(e.ev->>'length' AS INTEGER), CAST(e.ev->>'lines' AS INTEGER),
    e.ev->>'via', e.ev->>'language', e.ev->>'questionId', e.ev->>'text'
  FROM jsonb_array_elements(CAST(:events AS JSONB)) WITH ORDINALITY AS e(ev, ord),
    (SELECT COALESCE(MAX(seq), 0) AS last_seq FROM interview_pad_events WHERE interview_id = :interview_id) AS base
  RETURNING ${COLUMNS}`;
export const LIST_PAD_EVENTS_SQL = `SELECT ${COLUMNS} FROM interview_pad_events
  WHERE interview_id = :interview_id AND seq > :after_seq ORDER BY seq LIMIT :limit`;
export const LATEST_PAD_SNAPSHOT_SQL = `SELECT ${COLUMNS} FROM interview_pad_events
  WHERE interview_id = :interview_id AND kind = 'snapshot' ORDER BY seq DESC LIMIT 1`;
export const POSTED_QUESTION_IDS_SQL = `SELECT question_id FROM interview_pad_events
  WHERE interview_id = :interview_id AND kind = 'insert' AND question_id IS NOT NULL ORDER BY seq`;
export const ERASE_PAD_EVENTS_SQL = `DELETE FROM interview_pad_events WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING seq`;

export const PAD_LOG_STATEMENTS = [COUNT_PAD_EVENTS_SQL, INSERT_PAD_EVENTS_SQL, LIST_PAD_EVENTS_SQL, LATEST_PAD_SNAPSHOT_SQL, POSTED_QUESTION_IDS_SQL, ERASE_PAD_EVENTS_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const long = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function padEventFromRow(r: Record<string, unknown>): PadEventRecord {
  return {
    interviewId: String(r['interview_id']), seq: Number(r['seq']), at: isoOf(r['at']), clientAt: isoOf(r['client_at']),
    whoId: String(r['who_id']), side: String(r['side']) as PadSide, kind: String(r['kind']) as PadEventKind,
    from: intOrNull(r['from_pos']), inserted: intOrNull(r['inserted']), deleted: intOrNull(r['deleted']), length: intOrNull(r['doc_length']),
    lines: intOrNull(r['lines']), via: strOrNull(r['via']) as PadEventRecord['via'], language: strOrNull(r['language']),
    questionId: strOrNull(r['question_id']), text: strOrNull(r['text']),
  };
}

const isDuplicate = (e: unknown): boolean => /duplicate key|unique constraint|23505/i.test(String((e as Error)?.message ?? e));

export class SqlPadLogStore implements PadLogStore {
  constructor(private readonly exec: SqlExec) {}

  async counts(interviewId: string): Promise<PadLogCounts> {
    const row = (await this.exec(COUNT_PAD_EVENTS_SQL, [text('interview_id', interviewId)]))[0] ?? {};
    return { events: Number(row['events'] ?? 0), snapshots: Number(row['snapshots'] ?? 0), lastSeq: Number(row['last_seq'] ?? 0) };
  }

  async append(interviewId: string, events: readonly NewPadEvent[]): Promise<PadEventRecord[]> {
    if (!events.length) return [];
    // JSON nulls come out of `->>` as SQL NULL, so an absent count stays NULL in the row.
    const payload = JSON.stringify(events.map((e) => ({
      at: e.at, clientAt: e.clientAt, whoId: e.whoId, side: e.side, kind: e.kind, from: e.from, inserted: e.inserted, deleted: e.deleted,
      length: e.length, lines: e.lines, via: e.via, language: e.language, questionId: e.questionId, text: e.text,
    })));
    for (let attempt = 1; ; attempt++) {
      try {
        const rows = await this.exec(INSERT_PAD_EVENTS_SQL, [text('interview_id', interviewId), text('events', payload)]);
        if (rows.length !== events.length) throw new Error('pad events not stored');
        return rows.map(padEventFromRow).sort((a, b) => a.seq - b.seq);
      } catch (e) {
        if (attempt >= 3 || !isDuplicate(e)) throw e;
      }
    }
  }

  async listAfter(interviewId: string, afterSeq: number, limit: number): Promise<PadEventRecord[]> {
    if (limit <= 0) return [];
    const rows = await this.exec(LIST_PAD_EVENTS_SQL, [text('interview_id', interviewId), long('after_seq', Math.max(0, Math.floor(afterSeq))), long('limit', Math.floor(limit))]);
    return rows.map(padEventFromRow);
  }

  async latestSnapshot(interviewId: string): Promise<PadEventRecord | null> {
    const row = (await this.exec(LATEST_PAD_SNAPSHOT_SQL, [text('interview_id', interviewId)]))[0];
    return row ? padEventFromRow(row) : null;
  }

  async postedQuestionIds(interviewId: string): Promise<string[]> {
    const rows = await this.exec(POSTED_QUESTION_IDS_SQL, [text('interview_id', interviewId)]);
    return [...new Set(rows.map((r) => strOrNull(r['question_id'])).filter((id): id is string => id !== null))];
  }

  async erase(interviewIds: readonly string[]): Promise<number> {
    // Interview ids carry no comma (lib/interviews/spend.ts's id rule); anything else names no interview.
    const ids = interviewIds.filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
    if (!ids.length) return 0;
    return (await this.exec(ERASE_PAD_EVENTS_SQL, [text('interview_ids', ids.join(','))])).length;
  }
}
