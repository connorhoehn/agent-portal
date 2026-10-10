// A recorded call's transcript as conversation lines (docs/agentic-flows-migration.md
// slice 7). The BFF reads platform-api's `GET /api/recordings/:id/transcript`
// (src/routes/recordings.ts:902: segments `{startMs,endMs,speakerId,speakerLabel,text}`,
// plus injected `kind: 'reaction'` segments) through providers/social-platform.ts
// `recordingTranscript`, which applies the proxy's authority. This module is the
// pure part: segment -> `TranscriptLine`, so /summarize and /deck cite a
// recording exactly like a message.
//
// A line's `messageId` is `recording:<recordingId>#<segmentIndex>`: the verbatim
// quote check in lib/conversation-summarize.ts and the deck's per-slide sources
// both read it unchanged, and the deck source id is that same string.

import type { TranscriptLine } from './conversation-summarize.js';

export const RECORDING_SOURCE_PREFIX = 'recording:';
export const RECORDING_LINE_LIMIT = 400;

export interface TranscriptSegmentView { index: number; startMs: number; endMs: number; speakerId: string; speaker: string; text: string }

export const recordingSegmentId = (recordingId: string, index: number): string => `${RECORDING_SOURCE_PREFIX}${recordingId}#${index}`;

/** The conversation whose members a recording belongs to: a direct message's lobby IS its chat channel; a room has no chat. */
export function recordingConversation(lobbyName: string): string | null {
  return /^social:dm:[^:]+(?::[^:]+)+$/.test(lobbyName) ? lobbyName : null;
}

/** Speech only (reactions are not said), non-empty, indexed by their place in the document. */
export function speechSegments(raw: ReadonlyArray<{ startMs?: unknown; endMs?: unknown; speakerId?: unknown; speakerLabel?: unknown; text?: unknown; kind?: unknown }>): TranscriptSegmentView[] {
  const out: TranscriptSegmentView[] = [];
  raw.forEach((s, index) => {
    const text = typeof s.text === 'string' ? s.text.replace(/\s+/g, ' ').trim() : '';
    if (!text || s.kind === 'reaction') return;
    const speakerId = typeof s.speakerId === 'string' ? s.speakerId : '';
    out.push({
      index, startMs: Number(s.startMs) || 0, endMs: Number(s.endMs) || 0, speakerId,
      speaker: typeof s.speakerLabel === 'string' && s.speakerLabel.trim() ? s.speakerLabel.trim() : speakerId || 'Speaker', text,
    });
  });
  return out;
}

export function recordingTranscriptLines(recordingId: string, startedAt: string, segments: readonly TranscriptSegmentView[]): TranscriptLine[] {
  const base = Date.parse(startedAt);
  return segments.slice(0, RECORDING_LINE_LIMIT).map(s => ({
    messageId: recordingSegmentId(recordingId, s.index), author: s.speaker, text: s.text,
    at: new Date((Number.isFinite(base) ? base : 0) + s.startMs).toISOString(),
  }));
}

/** `recording:<id>#<n>` -> its parts, or null. */
export function parseRecordingSegmentId(id: string): { recordingId: string; index: number } | null {
  const m = /^recording:(.+)#(\d+)$/.exec(id);
  return m ? { recordingId: m[1]!, index: Number(m[2]) } : null;
}
