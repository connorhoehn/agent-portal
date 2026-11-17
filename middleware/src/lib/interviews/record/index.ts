// The interview record (row I5.1, contract E2): the header, the recording's part, the transcript's part and the markers,
// assembled for a reader the route has already found on the panel side of a finished interview. Nothing here decides who
// may read; nothing here logs any of it.
import { consentStore } from '../consent/store.js';
import { suggestionStore } from '../coach/store.js';
import { deletionStore, type DeletionRow } from '../retention/store.js';
import { runView, listRuns, type RunView } from '../runs/index.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import type { Application, Candidate, Interview, InterviewState, Opening, RoundType } from '../types.js';
import { recordMarkers, type RecordMarker } from './markers.js';
import { partState, recordingPart, removedKinds, type PartState, type RecordingPart } from './recording.js';
import { recordTranscript, type RecordSide, type RecordTranscript } from './transcript.js';

export { recordTranscript, type RecordTranscript } from './transcript.js';

/** The states in which an interview has a record: it has ended. */
export const RECORD_STATES: readonly InterviewState[] = ['ended', 'scored', 'reviewed'];

export interface RecordLineView { seq: number; atMs: number; side: RecordSide; speaker: string; text: string }

/** E2's `record`. */
export interface InterviewRecordView {
  interview: {
    id: string; state: InterviewState; startedAt: string | null; endedAt: string | null;
    round: { name: string; type: RoundType; minutes: number };
    candidate: { id: string; name: string };
    opening: { id: string; title: string };
  };
  recording: RecordingPart;
  transcript: { state: PartState; lines: RecordLineView[] };
  markers: RecordMarker[];
  /** The code runs of a technical round, oldest first (none for a behavioural round). The runs routes are for live rounds only; the record carries them afterwards under the record rule. */
  runs: RunView[];
  /** The questions chosen for a technical round, in the order chosen: what the pad's "insert a question" put in is named by these words. */
  questions: { id: string; prompt: string }[];
  /**
   * Why a technical round's code (its pad log and runs) is gone, when the deletion log removed it for this interview: at the
   * end of its keeping period, or because the candidate asked for their data to be deleted; null when nothing removed it
   * (and for a behavioural round). The page says so in place of "no code was written".
   */
  codeRemoved: CodeRemoval | null;
}

export type CodeRemoval = 'period' | 'request';
const CODE_KINDS: ReadonlySet<string> = new Set(['pad-log', 'runs']);

/** The first deletion (oldest first) that removed this interview's pad log or runs, and why; null when none did. */
export function codeRemovedBy(rows: readonly Pick<DeletionRow, 'interviewIds' | 'removed' | 'reason' | 'requestedAt'>[], interviewId: string): CodeRemoval | null {
  const first = rows
    .filter((r) => r.interviewIds.includes(interviewId) && r.removed.some((x) => CODE_KINDS.has(x.kind) && x.count > 0))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
  return first ? (first.reason === 'request' ? 'request' : 'period') : null;
}

/** Lines as ms from `startedAt` (never negative); a line with no usable time sits at the start. */
export function linesFrom(t: RecordTranscript, startedAt: string | null): RecordLineView[] {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  return t.lines.map((l) => {
    const at = Date.parse(l.at) - start;
    return { seq: l.seq, atMs: Number.isFinite(at) ? Math.max(0, at) : 0, side: l.side, speaker: l.speaker, text: l.text };
  });
}

export interface RecordSubject { interview: Interview; application: Application; opening: Opening; candidate: Candidate }

/** A technical round's runs, oldest first, as the runs routes show them to the panel. */
export async function recordRuns(i: Pick<Interview, 'id' | 'type'>): Promise<RunView[]> {
  if (i.type !== 'technical') return [];
  const rows = await runWithDbTenant(INTERVIEWS_TENANT, () => listRuns(i.id));
  // The candidate's guest id is never shown to the panel: a candidate's run is named by the side alone.
  return rows.map(runView).reverse().map((r) => (r.startedBy.side === 'candidate' ? { ...r, startedBy: { ...r.startedBy, id: 'candidate' } } : r));
}

/** Read every part of the record now. */
export async function readRecord(s: RecordSubject): Promise<InterviewRecordView> {
  const i = s.interview;
  const [consent, deletions, log, transcript, runs] = await Promise.all([
    consentStore().getConsent(i.id),
    deletionStore().forCandidate(s.candidate.id),
    suggestionStore().listSuggestions(i.id),
    recordTranscript(i),
    recordRuns(i),
  ]);
  const removed = removedKinds(deletions, i.id);
  const recording = recordingPart(i.id, consent, removed);
  const transcriptState = partState({
    agreed: consent ? consent.transcription : null,
    removed: removed.has('transcript-and-minutes'),
    present: (transcript?.lines.length ?? 0) > 0,
  });
  // The record's clock and header: when it actually started, else when the transcript began, else the set time.
  const startedAt = i.startedAt ?? transcript?.startedAt ?? i.scheduledAt ?? null;
  const round = s.opening.kit.rounds.find((r) => r.id === i.roundId);
  return {
    interview: {
      id: i.id, state: i.state, startedAt, endedAt: i.endedAt,
      round: { name: round?.name ?? 'Round', type: i.type, minutes: i.minutes },
      candidate: { id: s.candidate.id, name: s.candidate.name },
      opening: { id: s.opening.id, title: s.opening.title },
    },
    recording,
    transcript: { state: transcriptState, lines: transcriptState === 'available' && transcript ? linesFrom(transcript, startedAt) : [] },
    markers: recordMarkers(log, startedAt),
    runs,
    codeRemoved: i.type === 'technical' ? codeRemovedBy(deletions, i.id) : null,
    questions: i.type === 'technical' ? i.questionIds.flatMap((id) => { const q = s.opening.kit.questions.find((x) => x.id === id); return q ? [{ id, prompt: q.prompt }] : []; }) : [],
  };
}
