// Wire shapes every tenant's deck API shares (assessment, initiative,
// pipeline-run, social). Tenant-specific list/detail shapes stay in the
// tenant's provider; only what was copied four times lives here.

import type { RegionTextStyle } from '@connorhoehn/realtime-modules/deck/layout';

export interface DeckRevisionSummary { id: string; label: string; createdAt: string; producedBy: string; specAvailable?: false; unavailabilityReason?: string }

export interface DeckPreviewOut {
  /**
   * `regions`: the slide's editable fields and their boxes in stage points (realtime-modules `editableRegions`); a text
   * region also carries `text`, the painted font, size, colour and background, so the in-place editor looks like the slide.
   */
  slides: Array<{ id: string; svg: string; title?: string; generated?: boolean; regions?: Array<{ path: string; kind: string; box: { x: number; y: number; w: number; h: number }; value?: unknown; text?: RegionTextStyle }> }>;
  /** The resolved theme's colours the editor tints picker artwork with (realtime-modules `graphicSvg`). */
  colors?: { background: string; text: string; accent: string; accentInk: string };
  warnings: string[];
  /** The layout's measured findings (overflow, wrapped titles, crowding), also summarised in `warnings`. */
  findings?: Array<{ slideId: string; kind: string; region: string; detail: string; byPoints?: number }>;
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
