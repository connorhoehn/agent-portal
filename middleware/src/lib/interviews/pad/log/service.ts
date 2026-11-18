// The pad log's two operations behind the routes (row I4.3; contract U3): append a checked post for one writer, and
// read a page of the log with each writer's name. The routes decide who may do either; this file only applies the caps
// and shapes the answer.
import { capPost, type PadEventIn, type PadSide } from './rules.js';
import { padLogStore, type PadEventRecord } from './store.js';

/** The name a guest carries everywhere (lib/interviews/invite/realtime.ts GUEST_DISPLAY_NAME). */
export const CANDIDATE_NAME = 'Candidate';
/** The writer of the server's own edits for Milo (side `milo`), on every reader's page. */
export const MILO_NAME = 'Milo';
export const MILO_WRITER_ID = 'milo';
/** A read's page: at most this many events, and snapshot text up to READ_TEXT_BUDGET (at least one event a page). */
export const READ_PAGE_EVENTS = 500;
export const READ_TEXT_BUDGET = 2 * 1024 * 1024;

/** U3's `PadEvent`. */
export type PadEvent = PadEventIn & { seq: number; at: string; who: { id: string; name: string; side: PadSide } };

export interface PadWriter { id: string; side: PadSide }

/** Append what fits under the caps; how many of the post's events were stored. */
export async function appendPadEvents(interviewId: string, writer: PadWriter, events: readonly PadEventIn[], now: Date = new Date()): Promise<number> {
  const store = padLogStore();
  const kept = capPost(events, await store.counts(interviewId));
  if (!kept.length) return 0;
  const at = now.toISOString();
  await store.append(interviewId, kept.map((e) => ({
    at, clientAt: e.clientAt, whoId: writer.id, side: writer.side, kind: e.kind,
    from: e.from ?? null, inserted: e.inserted ?? null, deleted: e.deleted ?? null, length: e.length ?? null, lines: e.lines ?? null,
    via: e.via ?? null, language: e.language ?? null, questionId: e.questionId ?? null, text: e.kind === 'snapshot' ? (e.text ?? '') : null,
  })));
  return kept.length;
}

/** A stored row as U3's `PadEvent`: only the fields it has, and the writer's name. */
export function padEventView(r: PadEventRecord, nameOf: (id: string) => string): PadEvent {
  const out: PadEvent = {
    kind: r.kind, clientAt: r.clientAt, seq: r.seq, at: r.at,
    who: { id: r.whoId, name: r.side === 'candidate' ? CANDIDATE_NAME : r.side === 'milo' ? MILO_NAME : nameOf(r.whoId), side: r.side },
  };
  if (r.from !== null) out.from = r.from;
  if (r.inserted !== null) out.inserted = r.inserted;
  if (r.deleted !== null) out.deleted = r.deleted;
  if (r.length !== null) out.length = r.length;
  if (r.lines !== null) out.lines = r.lines;
  if (r.via !== null) out.via = r.via;
  if (r.language !== null) out.language = r.language;
  if (r.questionId !== null) out.questionId = r.questionId;
  if (r.kind === 'snapshot') out.text = r.text ?? '';
  return out;
}

/** A page of the log after `after`: `lastSeq` is the last `seq` in it (`after` when empty); `more` when a page stopped short. */
export async function readPadLog(interviewId: string, after: number, nameOf: (id: string) => string): Promise<{ events: PadEvent[]; lastSeq: number; more: boolean }> {
  const rows = await padLogStore().listAfter(interviewId, after, READ_PAGE_EVENTS + 1);
  const page: PadEventRecord[] = [];
  let budget = READ_TEXT_BUDGET;
  for (const r of rows.slice(0, READ_PAGE_EVENTS)) {
    const size = r.text ? Buffer.byteLength(r.text, 'utf8') : 0;
    if (page.length && size > budget) break;
    budget -= size;
    page.push(r);
  }
  const more = rows.length > page.length;
  return { events: page.map((r) => padEventView(r, nameOf)), lastSeq: page.length ? page[page.length - 1]!.seq : after, more };
}
