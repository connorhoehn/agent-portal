// The interview's shared code pad on the portal side (docs/interviews-tenant-plan.md, decision 11, row I4.2,
// "I0.7 answer"): the pad's names on the wire, the shared language, the block "Insert a question" adds, the
// caret colour per person and the connection state the pad shows. Pure, apart from the two functions that read
// and write the shared language on a Y.Doc. The component is pages/interviews/pad/InterviewPad.tsx.
//
// The names mirror middleware/src/lib/interviews/pad/channel.ts (the server's), and a unit test pins them by
// value: document `ivpad:<interviewId>` on channel `doc:ivpad:<interviewId>`, text `code`, and the pad's own
// map `pad` whose `language` key every pad on that document follows.
import type * as Y from 'yjs';
import { PAD_LANGUAGES, type PadLanguage } from './interviewsKit.ts';

export const PAD_DOCUMENT_PREFIX = 'ivpad:';
export const PAD_TEXT_NAME = 'code';
export const PAD_META_NAME = 'pad';
export const PAD_LANGUAGE_KEY = 'language';
/** The language a new pad starts in, before anyone picks one. */
export const PAD_DEFAULT_LANGUAGE: PadLanguage = 'python';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The pad's document id (what `useYjsDoc({ documentId })` takes), or null for an id that cannot name one. */
export function padDocumentId(interviewId: string): string | null {
  return INTERVIEW_ID.test(interviewId) ? `${PAD_DOCUMENT_PREFIX}${interviewId}` : null;
}

/** The channel the gateway carries the pad on, `doc:ivpad:<interviewId>`, or null. */
export function padChannel(interviewId: string): string | null {
  const id = padDocumentId(interviewId);
  return id ? `doc:${id}` : null;
}

/** The language guard: one of the seven the kit and the editor share. */
export function isPadLanguage(value: unknown): value is PadLanguage {
  return typeof value === 'string' && (PAD_LANGUAGES as readonly string[]).includes(value);
}

/** The shared language as a pad should show it: what the document says, or the default when it says nothing usable. */
export function padLanguageOf(value: unknown): PadLanguage {
  return isPadLanguage(value) ? value : PAD_DEFAULT_LANGUAGE;
}

/** The document's language now. */
export function readSharedLanguage(ydoc: Y.Doc): PadLanguage {
  return padLanguageOf(ydoc.getMap(PAD_META_NAME).get(PAD_LANGUAGE_KEY));
}

/** Change the language for everyone on the document. Returns whether anything changed. */
export function writeSharedLanguage(ydoc: Y.Doc, language: PadLanguage): boolean {
  const map = ydoc.getMap(PAD_META_NAME);
  if (map.get(PAD_LANGUAGE_KEY) === language) return false;
  map.set(PAD_LANGUAGE_KEY, language);
  return true;
}

/** How a line comment starts in each language. */
export const PAD_LINE_COMMENT: Readonly<Record<PadLanguage, string>> = {
  python: '#', swift: '//', javascript: '//', typescript: '//', java: '//', go: '//', cpp: '//',
};

/** How wide an inserted comment line may be, marker included: it reads in the room's pane without scrolling sideways. */
export const PAD_COMMENT_WIDTH = 60;

/** One line of prose broken at spaces so each piece fits `width` (a word longer than that stays whole). */
function wrapWords(line: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of line.trim().split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > width) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

/** The prompt as a comment block: every line commented and wrapped to `width`, blank lines kept as a bare comment marker. */
export function commentBlock(prompt: string, language: PadLanguage, width = PAD_COMMENT_WIDTH): string {
  const mark = PAD_LINE_COMMENT[language];
  const room = Math.max(16, width - mark.length - 1);
  return prompt.replace(/\r\n?/g, '\n').trim().split('\n')
    .flatMap((line) => (line.trim() ? wrapWords(line, room).map((piece) => `${mark} ${piece}`) : [mark])).join('\n');
}

/** A question as the pad takes it (U2's `PadQuestion`; the room's `RoomQuestion` fits it as it is). */
export interface PadQuestion { id: string; prompt: string; starter: ReadonlyArray<{ language: string; code: string }> }

/** What inserting a question does: the text to add at the end, and the language the pad is in afterwards. */
export interface QuestionInsertion { text: string; language: PadLanguage; switched: boolean }

/**
 * Decision 11's insert. The prompt as a comment in the pad's current language, then that language's starter
 * code; when the question has none in it, the first language it has (and the pad switches to that). It goes
 * at the end of what is there, on its own lines after a blank line, and never replaces anything.
 */
export function questionInsertion(q: PadQuestion, current: PadLanguage, existing: string): QuestionInsertion {
  const starters = q.starter.filter((s): s is { language: PadLanguage; code: string } => isPadLanguage(s.language));
  const starter = starters.find((s) => s.language === current) ?? starters[0] ?? null;
  const language = starter?.language ?? current;
  const code = starter?.code.replace(/\r\n?/g, '\n').replace(/\s+$/, '') ?? '';
  const block = `${commentBlock(q.prompt, language)}\n${code ? `${code}\n` : ''}`;
  const lead = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${lead}${block}`, language, switched: language !== current };
}

/**
 * Insert a question into a shared pad: switch the shared language if the insertion needs it, then add the
 * block at the end as one edit through `insert` (the editor's handle, so it is reported as this person's
 * insert); with no editor mounted, straight into the shared text. Returns what was inserted.
 */
export function applyQuestion(ydoc: Y.Doc, q: PadQuestion, insert?: ((text: string) => void) | null): QuestionInsertion {
  const text = ydoc.getText(PAD_TEXT_NAME);
  const plan = questionInsertion(q, readSharedLanguage(ydoc), text.toString());
  if (plan.switched) writeSharedLanguage(ydoc, plan.language);
  if (insert) insert(plan.text);
  else text.insert(text.length, plan.text);
  return plan;
}

/** Caret colours: distinct at a glance on light and dark editors. */
export const PAD_CARET_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'] as const;

/** A stable caret colour per person: the same person is the same colour on every pad and every reload. */
export function caretColor(personId: string): string {
  let h = 2166136261;
  for (let i = 0; i < personId.length; i++) h = Math.imul(h ^ personId.charCodeAt(i), 16777619);
  return PAD_CARET_COLORS[(h >>> 0) % PAD_CARET_COLORS.length]!;
}

/** The name on a person's caret: the candidate is always "Candidate". */
export function caretName(seat: 'lead' | 'panel' | 'candidate', displayName: string): string {
  return seat === 'candidate' ? 'Candidate' : displayName.trim() || 'Interviewer';
}

/** What the pad shows about its connection. */
export type PadConnection = 'offline' | 'refused' | 'connecting' | 'synced' | 'down';

/** The pad's state from the socket and the document. A refusal wins; with no gateway configured nothing else applies. */
export function padConnection(f: { configured: boolean; connectionState: string; synced: boolean; refused: boolean }): PadConnection {
  if (!f.configured) return 'offline';
  if (f.refused) return 'refused';
  if (f.connectionState === 'reconnecting' || f.connectionState === 'disconnected') return f.synced ? 'down' : 'connecting';
  return f.synced ? 'synced' : 'connecting';
}

/** Is this gateway frame the pad's channel being refused (a subscribe, an edit or a caret)? */
export function isPadRefusal(frame: unknown, channel: string): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const f = frame as { type?: unknown; channel?: unknown; service?: unknown };
  if (f.type !== 'error' && f.type !== 'crdt:error') return false;
  return f.channel === channel || (f.channel === undefined && f.service === 'crdt');
}

/** Is this frame the pad's document arriving (its snapshot)? A refusal is lifted by it. */
export function isPadSnapshot(frame: unknown, channel: string): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const f = frame as { type?: unknown; channel?: unknown };
  return f.type === 'crdt:snapshot' && f.channel === channel;
}

/** A menu label for a question: its first line, shortened. */
export function questionLabel(q: Pick<PadQuestion, 'prompt'>, max = 64): string {
  const first = q.prompt.trim().split('\n')[0]!.trim();
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

// ── Runs (row I4.4; contract U4; the plan's "The run interface") ─────────────────────────────────────────────
// Both people read the interview's ONE event stream, so a run either starts appears for both as it happens. The
// pieces here are pure: the request a Run sends, the state the stream and the reads fold into (in any order, with
// repeats after a reconnect), and the output's model, which maps one to one onto the library's `CodeRunOutput`.
// The hook is pages/interviews/pad/useInterviewRuns.ts. `base` is the side's path: the panel's
// `/api/interviews/interviews/:id` (`staffPadBase`), the candidate's `/api/interview-invite` (`GUEST_PAD_BASE`).

export const staffPadBase = (interviewId: string): string => `/api/interviews/interviews/${encodeURIComponent(interviewId)}`;
export const GUEST_PAD_BASE = '/api/interview-invite';

export type RunStatus = 'queued' | 'compiling' | 'running' | 'succeeded' | 'failed' | 'compile_error' | 'timed_out' | 'memory_exceeded' | 'cancelled' | 'internal_error';
export const RUN_STATUSES: readonly RunStatus[] = ['queued', 'compiling', 'running', 'succeeded', 'failed', 'compile_error', 'timed_out', 'memory_exceeded', 'cancelled', 'internal_error'];
const IN_FLIGHT: readonly RunStatus[] = ['queued', 'compiling', 'running'];
export const isRunStatus = (s: unknown): s is RunStatus => typeof s === 'string' && (RUN_STATUSES as readonly string[]).includes(s);
export const runInFlightStatus = (s: RunStatus): boolean => IN_FLIGHT.includes(s);

export interface RunResultView {
  status: RunStatus; exitCode: number | null; compileOutput: string; stdout: string; stderr: string;
  truncated: { stdout: boolean; stderr: boolean }; timeMs: number; peakMemoryMb: number | null; backend: string; runtimeVersion: string;
}
export interface RunView {
  runId: string; language: string; status: RunStatus;
  startedBy: { id: string; name: string; side: 'panel' | 'candidate' };
  queuedAt: string; startedAt: string | null; endedAt: string | null; result: RunResultView | null;
}
export interface RunEvent { runId: string; seq: number; stream: 'stdout' | 'stderr' | 'status'; data: string; at: string }

/** The one file a run sends is named for its language (the class a Java file holds must be `Main`). */
export const RUN_ENTRYPOINTS: Readonly<Record<PadLanguage, string>> = {
  python: 'main.py', swift: 'main.swift', javascript: 'main.js', typescript: 'main.ts', java: 'Main.java', go: 'main.go', cpp: 'main.cpp',
};
export const runEntrypoint = (language: PadLanguage): string => RUN_ENTRYPOINTS[language];

/** A fresh id per click: the server takes 8 to 80 letters, digits, dashes or underscores, and a repeat is safe. */
export function newRunId(random: () => number = Math.random, now: number = Date.now()): string {
  let tail = '';
  for (let i = 0; i < 10; i += 1) tail += Math.floor(random() * 36).toString(36);
  return `run-${now.toString(36)}-${tail}`;
}

export interface RunRequestBody { runId: string; language: PadLanguage; files: { path: string; content: string }[]; entrypoint: string }
/** What Run posts: the pad's text at that moment as the one file. */
export function runRequest(runId: string, language: PadLanguage, text: string): RunRequestBody {
  const entrypoint = runEntrypoint(language);
  return { runId, language, files: [{ path: entrypoint, content: text }], entrypoint };
}

/** Parse one stream message's data; anything malformed is dropped. */
export function parseRunEvent(data: string): RunEvent | null {
  try {
    const e = JSON.parse(data) as Partial<RunEvent>;
    if (typeof e.runId !== 'string' || typeof e.seq !== 'number' || !Number.isInteger(e.seq) || typeof e.data !== 'string') return null;
    if (e.stream !== 'stdout' && e.stream !== 'stderr' && e.stream !== 'status') return null;
    return { runId: e.runId, seq: e.seq, stream: e.stream, data: e.data, at: typeof e.at === 'string' ? e.at : '' };
  } catch { return null; }
}

export interface RunEntry {
  runId: string;
  /** The server's view (who, when, and the result once it ends); null until read. */
  view: RunView | null;
  /** The stream's events by `seq`: a repeat replaces itself, a late one slots into place. */
  events: Readonly<Record<number, RunEvent>>;
  /** First sight, for order when there is no view yet. */
  seen: number;
}
export interface RunsState { runs: Readonly<Record<string, RunEntry>>; clock: number }
export const EMPTY_RUNS: RunsState = { runs: {}, clock: 0 };
export type RunsAction = { type: 'list'; runs: readonly RunView[] } | { type: 'view'; run: RunView } | { type: 'event'; event: RunEvent };

function entryOf(state: RunsState, runId: string): RunEntry {
  return state.runs[runId] ?? { runId, view: null, events: {}, seen: state.clock + 1 };
}
/** How far along a status is: queued, compiling, running, then any end. */
const statusRank = (s: RunStatus): number => (s === 'queued' ? 0 : s === 'compiling' ? 1 : s === 'running' ? 2 : 3);
/** A view never goes back: a later read wins unless it knows less (an earlier status, or no result where one was held). */
function newerView(held: RunView | null, next: RunView): RunView {
  if (!held) return next;
  if (held.result && !next.result) return held;
  if (statusRank(held.status) > statusRank(next.status)) return held;
  return next;
}

export function runsReducer(state: RunsState, action: RunsAction): RunsState {
  if (action.type === 'event') {
    const e = action.event;
    const entry = entryOf(state, e.runId);
    if (entry.events[e.seq]?.data === e.data && entry.events[e.seq]?.stream === e.stream) return state;
    return { clock: Math.max(state.clock, entry.seen), runs: { ...state.runs, [e.runId]: { ...entry, events: { ...entry.events, [e.seq]: e } } } };
  }
  const views = action.type === 'list' ? [...action.runs].reverse() : [action.run];
  let next = state;
  for (const v of views) {
    const entry = entryOf(next, v.runId);
    next = { clock: Math.max(next.clock, entry.seen), runs: { ...next.runs, [v.runId]: { ...entry, view: newerView(entry.view, v) } } };
  }
  return next;
}

const ordered = (entry: RunEntry): RunEvent[] => Object.values(entry.events).sort((a, b) => a.seq - b.seq);

/** Where the run is: the result's when it ended, else the newest status the stream sent, else the view's. */
export function entryStatus(entry: RunEntry): RunStatus {
  if (entry.view?.result) return entry.view.result.status;
  const fromStream = ordered(entry).filter((e) => e.stream === 'status' && isRunStatus(e.data)).at(-1)?.data as RunStatus | undefined;
  const held = entry.view?.status;
  if (!fromStream) return held ?? 'queued';
  if (!held) return fromStream;
  // The further along wins; two ends that differ are the server's record.
  if (statusRank(held) === 3) return held;
  return statusRank(fromStream) >= statusRank(held) ? fromStream : held;
}

/** Newest first: by when it was queued, a run seen only on the stream by when it was first seen. */
export function runsNewestFirst(state: RunsState): RunEntry[] {
  return Object.values(state.runs).sort((a, b) => {
    const ta = a.view ? Date.parse(a.view.queuedAt) : NaN;
    const tb = b.view ? Date.parse(b.view.queuedAt) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return b.seen - a.seen;
  });
}
export const latestRun = (state: RunsState): RunEntry | null => runsNewestFirst(state)[0] ?? null;
/** The run Cancel stops: the newest still queued, compiling or running. */
export const cancellableRun = (state: RunsState): RunEntry | null => runsNewestFirst(state).find((e) => runInFlightStatus(entryStatus(e))) ?? null;
/** A run needs its view read: never read, or ended on the stream with no result held yet. */
export const runNeedsRead = (entry: RunEntry): boolean => !entry.view || (!runInFlightStatus(entryStatus(entry)) && !entry.view.result);

/** The output's model: exactly `CodeRunOutput`'s fields. */
export interface RunOutputModel {
  status: RunStatus | null;
  stdout: string; stderr: string; compileOutput: string;
  truncated: { stdout: boolean; stderr: boolean };
  exitCode: number | null; timeMs: number | null; peakMemoryMb: number | null;
  runBy?: string; languageLabel?: string; runtimeVersion?: string;
}
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  python: 'Python', swift: 'Swift', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', go: 'Go', cpp: 'C++',
};
/**
 * Who ran it, as the reader reads it: "you" for one's own run; the panel sees "Candidate" or the panel member's
 * name; the candidate sees "Interviewer" (the server names no panel member to a guest).
 */
export function runByLabel(view: RunView | null, selfId: string | null): string | undefined {
  if (!view) return undefined;
  if (selfId && view.startedBy.id === selfId) return 'Run by you';
  return `Run by ${view.startedBy.name}`;
}
export function runOutputModel(entry: RunEntry | null, selfId: string | null = null): RunOutputModel {
  if (!entry) return { status: null, stdout: '', stderr: '', compileOutput: '', truncated: { stdout: false, stderr: false }, exitCode: null, timeMs: null, peakMemoryMb: null };
  const r = entry.view?.result ?? null;
  const events = ordered(entry);
  const text = (stream: 'stdout' | 'stderr') => events.filter((e) => e.stream === stream).map((e) => e.data).join('');
  const language = entry.view?.language;
  return {
    status: entryStatus(entry),
    stdout: r ? r.stdout : text('stdout'),
    stderr: r ? r.stderr : text('stderr'),
    compileOutput: r?.compileOutput ?? '',
    truncated: { stdout: r?.truncated.stdout ?? false, stderr: r?.truncated.stderr ?? false },
    exitCode: r?.exitCode ?? null,
    timeMs: r?.timeMs ?? null,
    peakMemoryMb: r?.peakMemoryMb ?? null,
    ...(runByLabel(entry.view, selfId) ? { runBy: runByLabel(entry.view, selfId)! } : {}),
    ...(language && LANGUAGE_NAMES[language] ? { languageLabel: LANGUAGE_NAMES[language] } : {}),
    ...(r?.runtimeVersion ? { runtimeVersion: r.runtimeVersion } : {}),
  };
}

/** A refusal is the server's sentence; with none (no answer at all), one of ours. */
export const RUN_FAILED_SENTENCE = 'The run could not be started just now. Try again.';
export const CANCEL_FAILED_SENTENCE = 'The run could not be stopped just now. Try again.';

// ── The pad log reporter (row I4.3; contract U3) ─────────────────────────────────────────────────────────────
// Best effort: the pad's edits, pastes, language changes and inserted questions are batched and posted every few
// seconds and when the pad goes (at most 50 a post); a snapshot of the text goes every 30 seconds while it has
// changed, and one at each Run, each in its own post (the app's body limit is 100 KB). A refused or failed post
// is dropped: it never blocks typing and never shows an error.

export interface PadEventIn {
  kind: 'edit' | 'paste' | 'snapshot' | 'language' | 'insert';
  clientAt: string;
  from?: number; inserted?: number; deleted?: number; length?: number; lines?: number;
  via?: 'paste' | 'drop'; language?: string; questionId?: string; text?: string;
}
export const PAD_LOG_MAX_PER_POST = 50;
export const PAD_LOG_FLUSH_MS = 3_000;
export const PAD_LOG_SNAPSHOT_MS = 30_000;
export const PAD_LOG_MAX_SNAPSHOT_BYTES = 64 * 1024;
/** Past this many waiting, the oldest are dropped (best effort, bounded memory). */
export const PAD_LOG_MAX_QUEUED = 500;

const iso = (ms: number): string => new Date(ms).toISOString();
export const editEvent = (e: { from: number; inserted: number; deleted: number; length: number; at: number }): PadEventIn =>
  ({ kind: 'edit', clientAt: iso(e.at), from: e.from, inserted: e.inserted, deleted: e.deleted, length: e.length });
export const pasteEvent = (p: { characters: number; lines: number; from: number; at: number; via: 'paste' | 'drop' }): PadEventIn =>
  ({ kind: 'paste', clientAt: iso(p.at), from: p.from, inserted: p.characters, lines: p.lines, via: p.via });
export const languageEvent = (language: string, at: number): PadEventIn => ({ kind: 'language', clientAt: iso(at), language });
export const insertEvent = (questionId: string, at: number): PadEventIn => ({ kind: 'insert', clientAt: iso(at), questionId });
export const snapshotEvent = (text: string, language: string, at: number): PadEventIn => ({ kind: 'snapshot', clientAt: iso(at), text, language });
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export interface PadLogDeps {
  now(): number;
  /** One post; its answer is ignored apart from settling. */
  post(events: PadEventIn[], opts: { final: boolean }): Promise<unknown>;
  /** The pad's text and language right now; null when there is no pad. */
  read(): { text: string; language: string } | null;
}

/** The reporter's state machine, with the clock and the post injected (the hook ticks it). */
export class PadLogBatcher {
  private queue: PadEventIn[] = [];
  private lastSnapshotText: string | null = null;
  private lastSnapshotAt: number;
  private lastFlushAt: number;
  private stopped = false;
  private readonly deps: PadLogDeps;
  constructor(deps: PadLogDeps) {
    this.deps = deps;
    this.lastSnapshotAt = deps.now();
    this.lastFlushAt = deps.now();
  }
  get waiting(): number { return this.queue.length; }
  push(event: PadEventIn): void {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > PAD_LOG_MAX_QUEUED) this.queue.splice(0, this.queue.length - PAD_LOG_MAX_QUEUED);
  }
  /** Called every second or so: posts what waits every `PAD_LOG_FLUSH_MS`, a changed text every `PAD_LOG_SNAPSHOT_MS`. */
  tick(): void {
    if (this.stopped) return;
    const now = this.deps.now();
    if (now - this.lastSnapshotAt >= PAD_LOG_SNAPSHOT_MS) {
      this.lastSnapshotAt = now;
      const pad = this.deps.read();
      if (pad && pad.text !== this.lastSnapshotText) this.snapshot(pad.text, pad.language);
    }
    if (now - this.lastFlushAt >= PAD_LOG_FLUSH_MS) this.flush(false);
  }
  /** A snapshot now (each Run sends one), in its own post. Too large for the server: skipped. */
  snapshot(text: string, language: string): void {
    if (this.stopped || utf8Bytes(text) > PAD_LOG_MAX_SNAPSHOT_BYTES) return;
    this.lastSnapshotText = text;
    this.lastSnapshotAt = this.deps.now();
    this.send([snapshotEvent(text, language, this.deps.now())], false);
  }
  /** Post everything waiting, at most 50 a post. */
  flush(final: boolean): void {
    this.lastFlushAt = this.deps.now();
    while (this.queue.length) this.send(this.queue.splice(0, PAD_LOG_MAX_PER_POST), final);
  }
  /** The pad is going: what waits goes in a last post, and nothing more is taken. */
  stop(): void {
    if (this.stopped) return;
    this.flush(true);
    this.stopped = true;
  }
  private send(events: PadEventIn[], final: boolean): void {
    try { void this.deps.post(events, { final }).catch(() => undefined); } catch { /* dropped */ }
  }
}

// ── The wire (both sides: the cookie only, nothing cached, no Referer; as pages/join/guestApi.ts) ─────────────
const WIRE: RequestInit = { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' };
export const runsEventsUrl = (base: string): string => `${base}/runs/events`;
export type RunWrite = { ok: true; run: RunView } | { ok: false; error: string };

async function runWrite(url: string, body: unknown, fallback: string, fetcher: typeof fetch): Promise<RunWrite> {
  try {
    const res = await fetcher(url, { ...WIRE, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { run?: RunView; error?: string };
    if (res.ok && json.run) return { ok: true, run: json.run };
    return { ok: false, error: typeof json.error === 'string' && json.error ? json.error : fallback };
  } catch {
    return { ok: false, error: fallback };
  }
}
export const startRun = (base: string, body: RunRequestBody, fetcher: typeof fetch = fetch): Promise<RunWrite> =>
  runWrite(`${base}/runs`, body, RUN_FAILED_SENTENCE, fetcher);
export const cancelRun = (base: string, runId: string, fetcher: typeof fetch = fetch): Promise<RunWrite> =>
  runWrite(`${base}/runs/${encodeURIComponent(runId)}/cancel`, {}, CANCEL_FAILED_SENTENCE, fetcher);

/** The interview's runs, newest first; null when there is no answer (not live, not let in, no reply). */
export async function readRuns(base: string, fetcher: typeof fetch = fetch): Promise<RunView[] | null> {
  try {
    const res = await fetcher(`${base}/runs`, WIRE);
    if (!res.ok) return null;
    const json = (await res.json()) as { runs?: RunView[] };
    return Array.isArray(json.runs) ? json.runs : null;
  } catch { return null; }
}
export async function readRun(base: string, runId: string, fetcher: typeof fetch = fetch): Promise<RunView | null> {
  try {
    const res = await fetcher(`${base}/runs/${encodeURIComponent(runId)}`, WIRE);
    if (!res.ok) return null;
    return ((await res.json()) as { run?: RunView }).run ?? null;
  } catch { return null; }
}
/** One pad log post; `final` (the pad going) asks the browser to finish it after the page has gone. */
export function postPadEvents(base: string, events: PadEventIn[], final = false, fetcher: typeof fetch = fetch): Promise<Response | null> {
  return fetcher(`${base}/pad/events`, {
    ...WIRE, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }), ...(final ? { keepalive: true } : {}),
  }).catch(() => null);
}
