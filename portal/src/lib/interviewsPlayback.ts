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
  seq: number; kind: 'edit' | 'paste' | 'snapshot' | 'language' | 'insert'; at: string;
  who: { id: string; name: string; side: 'panel' | 'candidate' };
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
  succeeded: 'passed', failed: 'failed', compile_error: 'did not compile', timed_out: 'ran out of time', memory_exceeded: 'ran out of memory', cancelled: 'was cancelled', internal_error: 'could not finish',
};

/**
 * Every place to jump to, in time order: questions (the lead's marked moments and the pad's inserted questions, once
 * each: an inserted question the record already marks with the same words is not repeated), runs and pastes.
 */
export function markersOf(input: {
  events: readonly PadLogEvent[]; startedAt: string | null; recordMarkers: readonly RecordMarker[];
  runs: readonly RunView[]; questions: readonly { id: string; prompt: string }[];
}): PlaybackMarker[] {
  const out: PlaybackMarker[] = [];
  const marked = new Set(input.recordMarkers.map((m) => m.label.trim()));
  for (const m of input.recordMarkers) out.push({ atMs: m.atMs, kind: 'question', label: clip(m.label), detail: m.kind === 'milo-asked' ? `Milo asked: ${m.label}` : `Question asked: ${m.label}` });
  for (const e of input.events) {
    if (e.kind === 'insert') {
      const prompt = input.questions.find((q) => q.id === e.questionId)?.prompt ?? null;
      if (prompt && marked.has(prompt.trim())) continue;
      out.push({ atMs: msFrom(input.startedAt, e.at), kind: 'question', label: prompt ? clip(prompt) : 'A question was put in the pad', detail: prompt ? `Put in the pad: ${prompt}` : 'A question was put in the pad' });
    } else if (e.kind === 'paste') {
      out.push({ atMs: msFrom(input.startedAt, e.at), kind: 'paste', label: pasteLabel(e), detail: `${e.who.name}: ${pasteLabel(e)}` });
    }
  }
  input.runs.forEach((r, i) => {
    const ending = RUN_ENDING[r.status];
    out.push({ atMs: msFrom(input.startedAt, r.queuedAt), kind: 'run', label: `Run ${i + 1}`, detail: `Run ${i + 1} ${ending ?? 'was started'}, by ${r.startedBy.name}`, runId: r.runId });
  });
  return out.sort((a, b) => a.atMs - b.atMs);
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
