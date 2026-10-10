// Wire shapes every tenant's deck API shares (assessment, initiative,
// pipeline-run, social). Tenant-specific list/detail shapes stay in the
// tenant's provider; only what was copied four times lives here.

export interface DeckRevisionSummary { id: string; label: string; createdAt: string; producedBy: string; specAvailable?: false; unavailabilityReason?: string }

export interface DeckPreviewOut {
  slides: Array<{ id: string; svg: string; title?: string; generated?: boolean }>;
  warnings: string[];
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409 | 413 | 429 | 503; reason: string; details?: Record<string, unknown> };

export interface NarrativeOutcome {
  requested: boolean;
  /** none: not asked · applied: every narrative slide used prose · partial: some kept the template · fallback: all template · unavailable: no agent reachable */
  status: 'none' | 'applied' | 'partial' | 'fallback' | 'unavailable';
  templatedSlideIds: string[];
  reason?: string;
}
