// The record's markers (row I5.1): the moments the record page can jump to, from what exists today.
//
// Each suggestion the lead answered `ask` ("Question asked") or `milo-ask` ("Milo asked"), at its answer time, labelled
// with the question's words. Skipped and dropped suggestions are not moments. Pastes and runs belong to the pad's phase
// and are not built here. Pure: the caller reads the suggestion log.
import type { SuggestionRecord } from '../coach/store.js';

export type MarkerKind = 'question' | 'milo-asked';
export interface RecordMarker { kind: MarkerKind; atMs: number; label: string }

/** Markers from the suggestion log, ms from `startedAt`, in time order. Without a start there is nothing to place them against. */
export function recordMarkers(log: readonly Pick<SuggestionRecord, 'answer' | 'answeredAt' | 'text' | 'dropped'>[], startedAt: string | null): RecordMarker[] {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return [];
  return log
    .flatMap((s): RecordMarker[] => {
      if (s.dropped || !s.answeredAt || !s.text.trim() || (s.answer !== 'ask' && s.answer !== 'milo-ask')) return [];
      const at = Date.parse(s.answeredAt) - start;
      if (!Number.isFinite(at) || at < 0) return [];
      return [{ kind: s.answer === 'ask' ? 'question' : 'milo-asked', atMs: at, label: s.text }];
    })
    .sort((a, b) => a.atMs - b.atMs);
}
