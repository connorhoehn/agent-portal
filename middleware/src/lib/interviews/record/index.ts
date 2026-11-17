// The interview record (row I5.1, contract E2): the header, the recording's part, the transcript's part and the markers,
// assembled for a reader the route has already found on the panel side of a finished interview. Nothing here decides who
// may read; nothing here logs any of it.
import { consentStore } from '../consent/store.js';
import { suggestionStore } from '../coach/store.js';
import { deletionStore } from '../retention/store.js';
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

/** Read every part of the record now. */
export async function readRecord(s: RecordSubject): Promise<InterviewRecordView> {
  const i = s.interview;
  const [consent, deletions, log, transcript] = await Promise.all([
    consentStore().getConsent(i.id),
    deletionStore().forCandidate(s.candidate.id),
    suggestionStore().listSuggestions(i.id),
    recordTranscript(i),
  ]);
  const removed = removedKinds(deletions, i.id);
  const recording = recordingPart(i.id, consent, removed);
  const transcriptState = partState({
    agreed: consent ? consent.transcription : null,
    removed: removed.has('transcript-and-minutes'),
    present: (transcript?.lines.length ?? 0) > 0,
  });
  const startedAt = transcript?.startedAt ?? i.scheduledAt ?? null;
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
  };
}
