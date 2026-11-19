// The record page's one clock (docs/interviews-tenant-plan.md row I5.1): the pad log becomes frames for the library's
// CodePlayback, and the questions, runs and pastes become the places to jump to. Pure, apart from the paged read.
//
// Times: every event counts from the interview's start (`interview.startedAt` of the record), so the recording, the
// transcript and the code share one clock. A paste is an event, not an accusation: it is named by its size only.
import type { CodePlaybackFrame, CodePlaybackMarker } from '@connorhoehn/ui-components/code-pad';
import type { InterviewRecordView, RecordMarker } from './interviewsRecord.ts';
import type { RunView } from './interviewsPad.ts';

/** The pad log's read (contract U3), as the panel's route answers it. */
export interface PadLogEvent {
  /** `tests`, `imports` and `helper`: Milo's own edits (its interview tools), written by the server on side `milo`. */
  /** `reveal`: the lead put a question's provided design on the shared board (POST /board/reveal), with `questionId`. */
  seq: number; kind: 'edit' | 'paste' | 'snapshot' | 'language' | 'insert' | 'tests' | 'imports' | 'helper' | 'reveal'; at: string;
  who: { id: string; name: string; side: 'panel' | 'candidate' | 'milo' };
  inserted?: number; lines?: number; via?: 'paste' | 'drop'; language?: string; questionId?: string; text?: string;
}
export interface PadLogPage { events: PadLogEvent[]; lastSeq: number; more: boolean }

/** A jump place; a run's carries the run to show under the code. */
export type PlaybackMarker = CodePlaybackMarker & { runId?: string };

/** Pages are at most 500 events; this many pages is far past any interview (caps: 20,000 events). */
const MAX_PAGES = 60;

/** Read the whole log, page after page from `lastSeq` while `more`. Null when the first read fails (no code to show), what was read when a later one does. */
export async function readWholePadLog(readPage: (after: number) => Promise<PadLogPage | null>): Promise<PadLogEvent[] | null> {
  const events: PadLogEvent[] = [];
  let after = 0;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await readPage(after);
    if (!page) return i === 0 ? null : events;
    events.push(...page.events);
    if (!page.more || page.lastSeq <= after) return events;
    after = page.lastSeq;
  }
  return events;
}

/** Milo's own edits on the playback (marker kind `milo`, the letter M). */
export const MILO_EDIT_LABEL: Readonly<Record<'tests' | 'imports' | 'helper', string>> = {
  tests: 'Milo added test cases', imports: 'Milo added an import', helper: 'Milo added a helper',
};

export const padLogUrl = (interviewId: string, after: number): string =>
  `/api/interviews/interviews/${encodeURIComponent(interviewId)}/pad/log?after=${after}`;

function msFrom(startedAt: string | null, at: string): number {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const t = Date.parse(at);
  return Number.isFinite(start) && Number.isFinite(t) ? Math.max(0, t - start) : 0;
}

/** The snapshots as frames, in time order. */
export function framesOf(events: readonly PadLogEvent[], startedAt: string | null): CodePlaybackFrame[] {
  return events
    .filter((e) => e.kind === 'snapshot' && typeof e.text === 'string')
    .map((e): CodePlaybackFrame => ({ atMs: msFrom(startedAt, e.at), text: e.text!, ...(e.language ? { language: e.language } : {}) }))
    .sort((a, b) => a.atMs - b.atMs);
}

/** "Paste, 12 lines"; with no line count, by characters. */
export function pasteLabel(e: Pick<PadLogEvent, 'lines' | 'inserted' | 'via'>): string {
  const what = e.via === 'drop' ? 'Drop' : 'Paste';
  if (e.lines && e.lines > 0) return `${what}, ${e.lines} ${e.lines === 1 ? 'line' : 'lines'}`;
  if (e.inserted && e.inserted > 0) return `${what}, ${e.inserted} ${e.inserted === 1 ? 'character' : 'characters'}`;
  return what;
}

const clip = (text: string, max = 56): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

const RUN_ENDING: Partial<Record<RunView['status'], string>> = {
  succeeded: 'passed', failed: 'failed', compile_error: 'did not compile', timed_out: 'ran out of time', runner_timeout: 'could not be started', memory_exceeded: 'ran out of memory', cancelled: 'was cancelled', internal_error: 'could not finish',
};

/**
 * Every place to jump to, in time order: questions (the lead's marked moments and the pad's inserted questions, once
 * each: an inserted question the record already marks with the same words is not repeated), runs and pastes.
 */
export function markersOf(input: {
  events: readonly PadLogEvent[]; startedAt: string | null; recordMarkers: readonly RecordMarker[];
  runs: readonly RunView[]; questions: readonly { id: string; prompt: string }[];
  /** The playback's length: with it, markers of one kind closer than 2% of it become one (see `mergeCloseMarkers`). */
  durationMs?: number;
}): PlaybackMarker[] {
  const out: Array<PlaybackMarker & { runNo?: number }> = [];
  const marked = new Set(input.recordMarkers.map((m) => m.label.trim()));
  for (const m of input.recordMarkers) out.push({ atMs: m.atMs, kind: 'question', label: clip(m.label), detail: m.kind === 'milo-asked' ? `Milo asked: ${m.label}` : `Question asked: ${m.label}` });
  for (const e of input.events) {
    if (e.kind === 'insert') {
      const prompt = input.questions.find((q) => q.id === e.questionId)?.prompt ?? null;
      if (prompt && marked.has(prompt.trim())) continue;
      out.push({ atMs: msFrom(input.startedAt, e.at), kind: 'question', label: prompt ? clip(prompt) : 'A question was put in the pad', detail: prompt ? `Put in the pad: ${prompt}` : 'A question was put in the pad' });
    } else if (e.kind === 'paste') {
      out.push({ atMs: msFrom(input.startedAt, e.at), kind: 'paste', label: pasteLabel(e), detail: `${e.who.name}: ${pasteLabel(e)}` });
    } else if (e.kind === 'reveal') {
      const prompt = input.questions.find((q) => q.id === e.questionId)?.prompt ?? null;
      out.push({ atMs: msFrom(input.startedAt, e.at), kind: 'reveal', label: 'Provided design shown', detail: `${e.who.name} showed the provided design${prompt ? ` for "${prompt}"` : ''} to the candidate` });
    } else if (e.kind === 'tests' || e.kind === 'imports' || e.kind === 'helper') {
      out.push({ atMs: msFrom(input.startedAt, e.at), kind: 'milo', label: MILO_EDIT_LABEL[e.kind], detail: `${MILO_EDIT_LABEL[e.kind]} (${e.lines ?? 0} line${e.lines === 1 ? '' : 's'})` });
    }
  }
  input.runs.forEach((r, i) => {
    const ending = RUN_ENDING[r.status];
    out.push({ atMs: msFrom(input.startedAt, r.queuedAt), kind: 'run', label: `Run ${i + 1}`, detail: `Run ${i + 1} ${ending ?? 'was started'}, by ${r.startedBy.name}`, runId: r.runId, runNo: i + 1 });
  });
  const sorted = out.sort((a, b) => a.atMs - b.atMs);
  return input.durationMs && input.durationMs > 0 ? mergeCloseMarkers(sorted, input.durationMs) : sorted.map(({ runNo: _n, ...m }) => m);
}

/** A board round's record: when the lead showed the provided design, for its Moments list. */
export function revealMoments(events: readonly PadLogEvent[], startedAt: string | null): Array<{ questionId: string; atMs: number; label: string; by: string }> {
  return events.filter((e) => e.kind === 'reveal').map((e) => ({ questionId: e.questionId ?? '', atMs: msFrom(startedAt, e.at), label: 'Provided design shown to the candidate', by: e.who.name }));
}

/** Markers of one kind this close (a share of the playback's length) draw on top of each other on the slider. */
export const MARKER_MERGE_SHARE = 0.02;

const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
const listed = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

/**
 * Markers of the same kind closer together than 2% of `durationMs` (each to the one before it in its kind) become one
 * marker: at the first one's time, its label naming them all ("Runs 1 and 2 at 11:50"). Markers of different kinds are
 * left alone. The run the page shows is chosen by time, so every run stays reachable with the slider.
 */
export function mergeCloseMarkers(markers: ReadonlyArray<PlaybackMarker & { runNo?: number }>, durationMs: number): PlaybackMarker[] {
  const gap = durationMs * MARKER_MERGE_SHARE;
  const clusters: Array<Array<PlaybackMarker & { runNo?: number }>> = [];
  const open = new Map<string, Array<PlaybackMarker & { runNo?: number }>>();
  for (const m of [...markers].sort((a, b) => a.atMs - b.atMs)) {
    const cur = open.get(m.kind);
    if (cur && m.atMs - cur.at(-1)!.atMs < gap) { cur.push(m); continue; }
    const next = [m];
    open.set(m.kind, next);
    clusters.push(next);
  }
  return clusters.map((group) => {
    const [first, ...rest] = group;
    if (!rest.length) { const { runNo: _n, ...single } = first!; return single; }
    const { runNo: _n, ...head } = first!;
    const at = clock(head.atMs);
    const label = head.kind === 'run'
      ? `Runs ${listed(group.map((g) => String(g.runNo ?? g.label.replace(/\D+/g, ''))))} at ${at}`
      : head.kind === 'paste' ? `${group.length} pastes at ${at}: ${group.map((g) => g.label).join(', ')}`
      : `${group.length} questions at ${at}: ${group.map((g) => g.label).join(' · ')}`;
    return { ...head, label, detail: group.map((g) => g.detail ?? g.label).join('; ') };
  }).sort((a, b) => a.atMs - b.atMs);
}

/** The interview's length on the clock: the recording's, else from start to end, else the last thing that happened (at least a minute). */
export function playbackDurationMs(record: Pick<InterviewRecordView, 'interview' | 'recording'>, lastEventMs: number): number {
  const rec = record.recording.durationSeconds ? record.recording.durationSeconds * 1000 : 0;
  const span = record.interview.startedAt && record.interview.endedAt ? Math.max(0, Date.parse(record.interview.endedAt) - Date.parse(record.interview.startedAt)) : 0;
  return Math.max(rec || span, lastEventMs, 60_000);
}

/** The run a moment falls in or just after: the last run started at or before `timeMs`, or null before the first. */
export function runAtTime(runs: readonly RunView[], startedAt: string | null, timeMs: number): RunView | null {
  let found: RunView | null = null;
  for (const r of runs) if (msFrom(startedAt, r.queuedAt) <= timeMs) found = r;
  return found;
}

export { msFrom as eventMs };
