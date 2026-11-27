// Pure deck-page logic, kept apart from React so `node --test` covers it.

import type { DeckDetailCore as DeckDetail, DeckPendingRun, DeckRunRef, DeckRevisionInfo, DeckRunState, DeckSpec } from './deckApi.ts';

export const DECK_PREVIEW_DEBOUNCE_MS = 400;

export function isRunFinished(run: Pick<DeckRunState, 'status'>): boolean {
  return run.status === 'completed' || run.status === 'failed';
}

/** One line for a run's progress: "phase — detail", whichever exist. */
export function runProgressLabel(run: Pick<DeckRunState, 'status' | 'progress'> | null | undefined): string {
  if (!run) return 'Starting…';
  const phase = run.progress?.phase?.trim();
  const detail = run.progress?.detail?.trim();
  if (phase && detail) return `${phase} — ${detail}`;
  return phase || detail || (run.status === 'running' ? 'Working…' : run.status);
}

/** The id to open: the server's active revision, else the newest (revisions are newest first), else null. */
export function openRevisionId(deck: Pick<DeckDetail, 'revisions' | 'activeRevisionId'>): string | null {
  if (deck.activeRevisionId && deck.revisions.some((r) => r.id === deck.activeRevisionId && r.specAvailable !== false)) return deck.activeRevisionId;
  return deck.revisions.find(r => r.specAvailable !== false)?.id ?? null;
}

/** Revisions as the editor's picker takes them (createdAt pre-formatted by the host). */
export function toEditorRevisions(
  revisions: readonly DeckRevisionInfo[],
  format: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): Array<Omit<DeckRevisionInfo, 'createdAt'> & { createdAt?: string }> {
  return revisions.map((r) => ({ ...r, ...(r.createdAt ? { createdAt: format(r.createdAt) } : {}) }));
}

/**
 * What a render depends on. Speaker notes never reach a slide, so typing them
 * must not cost a preview; whether a slide HAS notes stays in the key.
 */
export function deckRenderKey(spec: DeckSpec): string {
  return JSON.stringify({
    ...spec,
    slides: spec.slides.map(({ notes, ...slide }) => ({ ...slide, hasNotes: !!notes?.trim() })),
  });
}

/** The ids the editor shows as "Generating…" while an agent revision runs. */
export function generatingIds(spec: DeckSpec | null, slideId: string | undefined, running: boolean): string[] {
  if (!running || !spec) return [];
  return slideId ? [slideId] : spec.slides.map((s) => s.id);
}

/** True when `pending` names a run that has not been seen finished. */
export function hasPendingRun(deck: Pick<DeckDetail, 'pendingRun'> | null): deck is { pendingRun: DeckPendingRun } {
  return !!deck?.pendingRun?.runId;
}

/**
 * The server's download name: "<title-slug>-v<seq>.pptx" (providers/assessment-decks.ts
 * renderRevisionFile). The slug is lowercase [a-z0-9-], at most 60 characters.
 */
export function deckFileName(title: string, seq: number): string {
  return deckExportName(title, seq, 'pptx');
}

/** The download formats a saved version offers (`GET …/revisions/:rid/file?format=`). */
export type DeckExportFormat = 'pptx' | 'pdf' | 'png';

export const DECK_EXPORTS: ReadonlyArray<{ format: DeckExportFormat; label: string; mime: string; suffix: string }> = [
  { format: 'pptx', label: 'PowerPoint (.pptx)', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', suffix: '.pptx' },
  { format: 'pdf', label: 'PDF (.pdf)', mime: 'application/pdf', suffix: '.pdf' },
  { format: 'png', label: 'Images (.zip)', mime: 'application/zip', suffix: '-slides.zip' },
];

export const isDeckExportFormat = (v: unknown): v is DeckExportFormat => DECK_EXPORTS.some((e) => e.format === v);

/** The server's download name for a format: "<slug>-v<seq>.pptx", ".pdf" or "-slides.zip". */
export function deckExportName(title: string, seq: number, format: DeckExportFormat): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'review-deck';
  return `${slug}-v${seq}${DECK_EXPORTS.find((e) => e.format === format)!.suffix}`;
}

/** A PowerPoint download name ("x-v3.pptx") as another format's ("x-v3.pdf", "x-v3-slides.zip"). */
export function deckExportFallbackName(pptxName: string, format: DeckExportFormat): string {
  return `${pptxName.replace(/\.pptx$/i, '')}${DECK_EXPORTS.find((e) => e.format === format)!.suffix}`;
}

/** The download URL of a format: the PowerPoint file is the route's default, so its URL is unchanged. */
export function deckExportUrl(fileUrl: string, format: DeckExportFormat): string {
  if (format === 'pptx') return fileUrl;
  return `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}format=${format}`;
}

/** A revision's sequence number: revisions are newest first and append-only, so it is its position from the end. */
export function revisionSeq(revisions: readonly DeckRevisionInfo[], revisionId: string): number {
  const index = revisions.findIndex((r) => r.id === revisionId);
  return index < 0 ? revisions.length : revisions.length - index;
}

/** The failed most-recent run to surface, if any (not while another run is pending). */
export function failedLastRun(deck: Pick<DeckDetail, 'pendingRun' | 'lastRun'> | null): DeckRunRef | null {
  if (!deck || deck.pendingRun) return null;
  return deck.lastRun?.status === 'failed' ? deck.lastRun : null;
}

/** Whether a manual edit is allowed for this session: the one deck write rule (RunAssessmentAgent). */
export function deckReadOnly(can: (action: 'RunAssessmentAgent') => boolean): boolean {
  return !can('RunAssessmentAgent');
}

/** The sentence shown when a run ends badly. */
export function runFailureMessage(run: Pick<DeckRunState, 'error' | 'summary'>): string {
  return run.error?.trim() || run.summary?.trim() || 'The run failed.';
}

/** The deck's own citations for the editor's source picker: every document its slides cite, once. */
export function deckSourceOptions(spec: DeckSpec | null): Array<{ documentId: string; title: string; kind: 'document' }> {
  const seen = new Map<string, { documentId: string; title: string; kind: 'document' }>();
  for (const slide of spec?.slides ?? []) {
    for (const source of slide.sources ?? []) {
      if (source.documentId && !seen.has(source.documentId)) seen.set(source.documentId, { documentId: source.documentId, title: source.title || source.documentId, kind: 'document' });
    }
  }
  return [...seen.values()];
}
