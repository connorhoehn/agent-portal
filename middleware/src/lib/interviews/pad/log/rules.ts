// The pad log's rules (docs/interviews-tenant-plan.md decision 12, row I4.3; contract U3). Pure: no store, no clock.
//
// A post is 1 to 50 events. Each event is checked field by field and rebuilt from the fields its kind uses, so an
// unknown field, or a known one its kind does not use, is dropped and never stored. One field is refused outright
// rather than dropped: `text` on anything but a `snapshot`, because an edit carries counts only (decision 12 keeps
// who, when and how much; the snapshots carry the text). A malformed post is refused whole and nothing is stored.
//
//   edit      from, inserted, deleted, length (counts, never the characters)
//   paste     from, inserted (the characters pasted), lines, via ('paste' | 'drop'); length optional
//   snapshot  text (at most 64 KB as UTF-8); language and length optional
//   language  language
//   insert    questionId; from, inserted, length, language optional
//
// The caps (`capPost`): at most 400 snapshots and 20,000 events an interview. Past either, the post is still
// accepted and the extra events are dropped (counted as not accepted); the interview goes on. The event cap stops every
// kind but snapshots: past it, snapshots (the page sends one every 30 seconds and one per run) still land under their own
// cap, so the record's playback and the coach's code view keep up while edits, pastes and the rest are refused. A log
// therefore holds at most 20,000 + 400 rows.

/** What a person's pad may post. */
export const PAD_EVENT_KINDS = ['edit', 'paste', 'snapshot', 'language', 'insert'] as const;
export type PostedPadEventKind = typeof PAD_EVENT_KINDS[number];
/** Milo's own edits, which only the server writes (side `milo`; lib/interviews/milo-tools): `tests` (test cases), `imports`
 * (import lines) and `helper` (a helper block), with from, inserted, length and lines. No post may carry any of them. */
export const MILO_PAD_EVENT_KINDS = ['tests', 'imports', 'helper'] as const;
/**
 * Every kind the log holds: the posted ones, Milo's, and `reveal`: the lead put a question's provided design (its answer
 * key's board) on the shared board, with `questionId`; only the server writes it, once per question (routes/interviews/
 * board.ts POST /board/reveal/shown), side `panel`. No post may carry it. The schema's kind CHECK holds this same list.
 */
export const PAD_LOG_KINDS = [...PAD_EVENT_KINDS, ...MILO_PAD_EVENT_KINDS, 'reveal'] as const;
export type PadEventKind = typeof PAD_LOG_KINDS[number];
/** `milo`: the server writing for Milo (its tools' edits, and the snapshot taken as it wrote them); never set by a post. */
export type PadSide = 'panel' | 'candidate' | 'milo';

/** U3's `PadEventIn`, as checked. */
export interface PadEventIn {
  kind: PadEventKind;
  clientAt: string;
  from?: number;
  inserted?: number;
  deleted?: number;
  length?: number;
  lines?: number;
  via?: 'paste' | 'drop';
  language?: string;
  questionId?: string;
  text?: string;
}

export const MAX_EVENTS_PER_POST = 50;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_SNAPSHOTS_PER_INTERVIEW = 400;
export const MAX_EVENTS_PER_INTERVIEW = 20_000;
/** Above any real document; keeps every count inside a database INTEGER. */
export const MAX_COUNT = 10_000_000;
const MAX_CLIENT_AT_CHARS = 40;
const LANGUAGE = /^[a-z][a-z0-9+#.-]{0,31}$/;
const QUESTION_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export const BAD_POST = 'The pad log could not read these events. Nothing was stored.';

type Fields = 'from' | 'inserted' | 'deleted' | 'length' | 'lines';
const NEEDS: Record<PostedPadEventKind, { counts: Fields[]; optional: Fields[] }> = {
  edit: { counts: ['from', 'inserted', 'deleted', 'length'], optional: [] },
  paste: { counts: ['from', 'inserted', 'lines'], optional: ['length'] },
  snapshot: { counts: [], optional: ['length'] },
  language: { counts: [], optional: [] },
  insert: { counts: [], optional: ['from', 'inserted', 'length'] },
};

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

function clientAtOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > MAX_CLIENT_AT_CHARS) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One event, rebuilt from the fields its kind uses; null when any of them is wrong. */
export function checkPadEvent(raw: unknown): PadEventIn | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (typeof kind !== 'string' || !(PAD_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  const k = kind as PostedPadEventKind;
  const clientAt = clientAtOf(r['clientAt']);
  if (!clientAt) return null;
  if (r['text'] !== undefined && k !== 'snapshot') return null;
  const out: PadEventIn = { kind: k, clientAt };
  for (const f of NEEDS[k].counts) {
    if (!isCount(r[f])) return null;
    out[f] = r[f] as number;
  }
  for (const f of NEEDS[k].optional) {
    if (r[f] === undefined) continue;
    if (!isCount(r[f])) return null;
    out[f] = r[f] as number;
  }
  if (k === 'paste') {
    if (r['via'] !== 'paste' && r['via'] !== 'drop') return null;
    out.via = r['via'];
  }
  if (k === 'snapshot' || k === 'language' || k === 'insert') {
    const lang = r['language'];
    if (lang !== undefined || k === 'language') {
      if (typeof lang !== 'string' || !LANGUAGE.test(lang)) return null;
      out.language = lang;
    }
  }
  if (k === 'insert') {
    if (typeof r['questionId'] !== 'string' || !QUESTION_ID.test(r['questionId'])) return null;
    out.questionId = r['questionId'];
  }
  if (k === 'snapshot') {
    if (typeof r['text'] !== 'string' || Buffer.byteLength(r['text'], 'utf8') > MAX_SNAPSHOT_BYTES) return null;
    out.text = r['text'];
  }
  return out;
}

/** The post's body `{ events }`: 1 to 50 events, each good; null refuses the whole post. */
export function checkPadPost(body: unknown): PadEventIn[] | null {
  if (!body || typeof body !== 'object') return null;
  const events = (body as Record<string, unknown>)['events'];
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS_PER_POST) return null;
  const out: PadEventIn[] = [];
  for (const e of events) {
    const checked = checkPadEvent(e);
    if (!checked) return null;
    out.push(checked);
  }
  return out;
}

/** The events of a post that fit under the interview's caps, in order, given what is stored already. */
export function capPost(events: readonly PadEventIn[], stored: { events: number; snapshots: number }): PadEventIn[] {
  let total = stored.events;
  let snapshots = stored.snapshots;
  const kept: PadEventIn[] = [];
  for (const e of events) {
    if (e.kind === 'snapshot') {
      if (snapshots >= MAX_SNAPSHOTS_PER_INTERVIEW) continue;
      snapshots += 1;
    } else if (total >= MAX_EVENTS_PER_INTERVIEW) continue;
    total += 1;
    kept.push(e);
  }
  return kept;
}
