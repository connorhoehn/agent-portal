// The whiteboard's checkpoints (WHITEBOARD-PLAN step 1): while a board round is live, the lead's room posts the
// board's elements every so often and when it closes, so the record page shows the final board and a few timed
// snapshots beside the recording and the transcript. The pad log's pattern (../pad/log/): a memory store for the mock
// world and a SQL store (schema/interviews_schema.sql `interview_board_snapshots`), append-only, capped per
// interview, erased with the interview's media by the retention sweep.
//
// A snapshot is the scene as the library's Excalidraw binding holds it: a JSON array of elements. Only its shape and
// its size are checked; a snapshot identical to the last one is not stored again.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../../config.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { isoOf, type SqlExec } from '../store-sql.js';
import { INTERVIEWS_TENANT } from '../types.js';

/** At most this many checkpoints an interview (one a minute covers a three-hour round), each at most this big. */
export const MAX_BOARD_SNAPSHOTS = 200;
export const MAX_BOARD_SCENE_BYTES = 512 * 1024;
export const MAX_BOARD_ELEMENTS = 2000;

export type BoardSide = 'panel' | 'candidate';

export interface BoardSnapshotRecord {
  interviewId: string;
  seq: number;
  at: string;
  whoId: string;
  side: BoardSide;
  /** How many live elements the scene holds. */
  elements: number;
  /** The scene: a JSON array of Excalidraw elements. */
  scene: string;
}

export type NewBoardSnapshot = Omit<BoardSnapshotRecord, 'interviewId' | 'seq'>;

export interface BoardSnapshotStore {
  /** How many checkpoints the interview has. */
  count(interviewId: string): Promise<number>;
  /** The last checkpoint, or null. */
  latest(interviewId: string): Promise<BoardSnapshotRecord | null>;
  /** Append one with the next `seq`. */
  append(interviewId: string, snapshot: NewBoardSnapshot): Promise<BoardSnapshotRecord>;
  /** Every checkpoint of the interview, oldest first. */
  list(interviewId: string): Promise<BoardSnapshotRecord[]>;
  /** Remove every checkpoint of these interviews; how many went. */
  erase(interviewIds: readonly string[]): Promise<number>;
}

// ── memory ───────────────────────────────────────────────────────────────────

export class MemoryBoardSnapshotStore implements BoardSnapshotStore {
  private readonly rows: BoardSnapshotRecord[] = [];
  private of(id: string): BoardSnapshotRecord[] { return this.rows.filter((r) => r.interviewId === id).sort((a, b) => a.seq - b.seq); }
  async count(interviewId: string): Promise<number> { return this.of(interviewId).length; }
  async latest(interviewId: string): Promise<BoardSnapshotRecord | null> { const mine = this.of(interviewId); return mine.length ? { ...mine[mine.length - 1]! } : null; }
  async append(interviewId: string, s: NewBoardSnapshot): Promise<BoardSnapshotRecord> {
    const mine = this.of(interviewId);
    const row = { ...s, interviewId, seq: (mine[mine.length - 1]?.seq ?? 0) + 1 };
    this.rows.push(row);
    return { ...row };
  }
  async list(interviewId: string): Promise<BoardSnapshotRecord[]> { return this.of(interviewId).map((r) => ({ ...r })); }
  async erase(interviewIds: readonly string[]): Promise<number> {
    const ids = new Set(interviewIds);
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !ids.has(r.interviewId)));
    return before - this.rows.length;
  }
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const COLUMNS = 'interview_id, seq, at, who_id, side, elements, scene';
export const COUNT_BOARD_SNAPSHOTS_SQL = 'SELECT COUNT(*) AS n FROM interview_board_snapshots WHERE interview_id = :interview_id';
export const LATEST_BOARD_SNAPSHOT_SQL = `SELECT ${COLUMNS} FROM interview_board_snapshots WHERE interview_id = :interview_id ORDER BY seq DESC LIMIT 1`;
export const INSERT_BOARD_SNAPSHOT_SQL = `INSERT INTO interview_board_snapshots (${COLUMNS})
  SELECT :interview_id, COALESCE(MAX(seq), 0) + 1, CAST(:at AS TIMESTAMPTZ), :who_id, :side, :elements, :scene
  FROM interview_board_snapshots WHERE interview_id = :interview_id
  RETURNING ${COLUMNS}`;
export const LIST_BOARD_SNAPSHOTS_SQL = `SELECT ${COLUMNS} FROM interview_board_snapshots WHERE interview_id = :interview_id ORDER BY seq`;
export const ERASE_BOARD_SNAPSHOTS_SQL = 'DELETE FROM interview_board_snapshots WHERE interview_id = ANY(string_to_array(:interview_ids, \',\')) RETURNING seq';

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const long = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const fromRow = (r: Record<string, unknown>): BoardSnapshotRecord => ({
  interviewId: String(r['interview_id']), seq: Number(r['seq']), at: isoOf(r['at']), whoId: String(r['who_id']),
  side: String(r['side']) as BoardSide, elements: Number(r['elements']), scene: String(r['scene']),
});
const isDuplicate = (e: unknown): boolean => /duplicate key|unique constraint|23505/i.test(String((e as Error)?.message ?? e));

export class SqlBoardSnapshotStore implements BoardSnapshotStore {
  constructor(private readonly exec: SqlExec) {}
  async count(interviewId: string): Promise<number> {
    return Number((await this.exec(COUNT_BOARD_SNAPSHOTS_SQL, [text('interview_id', interviewId)]))[0]?.['n'] ?? 0);
  }
  async latest(interviewId: string): Promise<BoardSnapshotRecord | null> {
    const row = (await this.exec(LATEST_BOARD_SNAPSHOT_SQL, [text('interview_id', interviewId)]))[0];
    return row ? fromRow(row) : null;
  }
  async append(interviewId: string, s: NewBoardSnapshot): Promise<BoardSnapshotRecord> {
    const params = [text('interview_id', interviewId), text('at', s.at), text('who_id', s.whoId), text('side', s.side), long('elements', s.elements), text('scene', s.scene)];
    // Two posts racing for one `seq` meet the primary key; the loser tries again on the new last (up to three times).
    for (let attempt = 1; ; attempt++) {
      try {
        const row = (await this.exec(INSERT_BOARD_SNAPSHOT_SQL, params))[0];
        if (!row) throw new Error('board snapshot not stored');
        return fromRow(row);
      } catch (e) {
        if (attempt >= 3 || !isDuplicate(e)) throw e;
      }
    }
  }
  async list(interviewId: string): Promise<BoardSnapshotRecord[]> {
    return (await this.exec(LIST_BOARD_SNAPSHOTS_SQL, [text('interview_id', interviewId)])).map(fromRow);
  }
  async erase(interviewIds: readonly string[]): Promise<number> {
    const ids = interviewIds.filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
    if (!ids.length) return 0;
    return (await this.exec(ERASE_BOARD_SNAPSHOTS_SQL, [text('interview_ids', ids.join(','))])).length;
  }
}

let current: BoardSnapshotStore | null = null;
export function boardSnapshotStore(): BoardSnapshotStore {
  return (current ??= config.mock?.aurora
    ? new MemoryBoardSnapshotStore()
    : new SqlBoardSnapshotStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params)));
}
export function setBoardSnapshotStore(next: BoardSnapshotStore | null): void { current = next; }

// ── the service ──────────────────────────────────────────────────────────────

/** A posted scene: a list of elements, each a plain object with a string `id` and `type`; the live ones are kept. */
export function checkBoardScene(raw: unknown): { scene: string; elements: number } | null {
  if (!Array.isArray(raw) || raw.length > MAX_BOARD_ELEMENTS) return null;
  const live: unknown[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const r = e as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || typeof r['type'] !== 'string') return null;
    if (r['isDeleted'] !== true) live.push(r);
  }
  const scene = JSON.stringify(live);
  return Buffer.byteLength(scene, 'utf8') > MAX_BOARD_SCENE_BYTES ? null : { scene, elements: live.length };
}

/** Store a checkpoint unless it repeats the last one or the interview is at its cap. Whether one was stored. */
export async function saveBoardSnapshot(interviewId: string, writer: { id: string; side: BoardSide }, checked: { scene: string; elements: number }, now = new Date()): Promise<boolean> {
  return runWithDbTenant(INTERVIEWS_TENANT, async () => {
    const store = boardSnapshotStore();
    const last = await store.latest(interviewId);
    if (last && last.scene === checked.scene) return false;
    if (last && (await store.count(interviewId)) >= MAX_BOARD_SNAPSHOTS) return false;
    await store.append(interviewId, { at: now.toISOString(), whoId: writer.id, side: writer.side, elements: checked.elements, scene: checked.scene });
    return true;
  });
}

/** The record's view: every checkpoint, oldest first, with the writer's name and the elements parsed. */
export async function readBoardSnapshots(interviewId: string, nameOf: (id: string) => string): Promise<Array<{ seq: number; at: string; who: { id: string; name: string }; elements: unknown[] }>> {
  const rows = await runWithDbTenant(INTERVIEWS_TENANT, () => boardSnapshotStore().list(interviewId));
  return rows.map((r) => {
    let elements: unknown[] = [];
    try { const parsed = JSON.parse(r.scene) as unknown; if (Array.isArray(parsed)) elements = parsed; } catch { /* an unreadable row shows empty */ }
    return { seq: r.seq, at: r.at, who: { id: r.whoId, name: r.side === 'candidate' ? 'Candidate' : nameOf(r.whoId) }, elements };
  });
}

/** Remove these interviews' board checkpoints (the retention sweep's `board-snapshots` eraser, class `media`). */
export async function eraseBoardSnapshots(interviewIds: readonly string[]): Promise<number> {
  if (!interviewIds.length) return 0;
  return runWithDbTenant(INTERVIEWS_TENANT, () => boardSnapshotStore().erase(interviewIds));
}
