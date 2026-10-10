// The tenant-neutral half of a deck's facts: the plan shape every tenant's deck
// builder fills (assessment, initiative, pipeline run), `clip`, and the slide
// assembly the narrative merge re-applies. assessment-deck/facts.ts re-exports
// these for compatibility.

import {
  MAX_BULLET_CHARS, MAX_TITLE_CHARS,
  type DeckSlide, type DeckSpec,
} from '@connorhoehnslalom/realtime-modules/deck';

export type DeckSlideKind =
  | 'title' | 'executive-summary' | 'overview' | 'dimension' | 'not-applicable'
  | 'overall-summary' | 'recommendations' | 'next-steps';

/** Slide kinds the drafter writes prose for. Everything else is facts only. */
export const NARRATIVE_KINDS: ReadonlySet<string> = new Set<string>([
  'executive-summary', 'dimension', 'overall-summary', 'next-steps',
]);

export type FactValue = string | number;

export interface DeckEvidence { id: string; excerpt: string }

/**
 * One slide: its facts (what the drafter is told), the evidence it may quote,
 * and where its prose lives. The assembled slide is
 *   bullets layout:  bullets = factBullets ++ prose
 *   column layout:   columns = [factColumn, excerptBullets ++ prose]
 *   none:            the template slide, entirely facts.
 */
export interface SlidePlan {
  slideId: string;
  /** Assessment kinds, or another tenant's own (the pipelines run report reuses this plan shape). */
  kind: DeckSlideKind | (string & {});
  dimensionId?: string;
  facts: Record<string, FactValue>;
  evidence: DeckEvidence[];
  prose: 'bullets' | 'column' | 'none';
  maxProse: number;
  factBullets: string[];
  factColumn?: string[];
  excerptBullets?: string[];
  templateProse: string[];
  templateNotes?: string;
  /** The slide with template prose — what the deck says before any narrative. */
  base: DeckSlide;
}

export interface DeckFacts {
  teamId: string;
  spec: DeckSpec;
  slides: SlidePlan[];
}

/** Shortens to `max` characters, marking the cut. A clip keeps a verbatim prefix. */
export function clip(text: string, max: number = MAX_BULLET_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function assemble(plan: Omit<SlidePlan, 'base'>, frame: Omit<DeckSlide, 'bullets' | 'columns'>, prose: string[], notes?: string): DeckSlide {
  const slide: DeckSlide = { ...frame };
  if (plan.prose === 'column') {
    slide.columns = [[...(plan.factColumn ?? [])], [...(plan.excerptBullets ?? []), ...prose]];
  } else if (plan.prose === 'bullets') {
    slide.bullets = [...plan.factBullets, ...prose];
  } else if (plan.factBullets.length) {
    slide.bullets = [...plan.factBullets];
  }
  if (notes) slide.notes = notes;
  else delete slide.notes;
  return slide;
}

/** The frame of a slide: every field that is not bullets/columns/notes. */
export function slideFrame(slide: DeckSlide): Omit<DeckSlide, 'bullets' | 'columns' | 'notes'> {
  const { bullets: _b, columns: _c, notes: _n, ...frame } = slide;
  return frame;
}

/** Builds a slide from its plan with the given prose (capped) and notes. */
export function slideWithProse(plan: SlidePlan, prose: string[], notes: string | undefined, title?: string): DeckSlide {
  const capped = prose.map((p) => clip(p)).filter(Boolean).slice(0, plan.maxProse);
  return assemble(plan, { ...slideFrame(plan.base), ...(title ? { title: clip(title, MAX_TITLE_CHARS) } : {}) }, capped, notes);
}

export function makePlan(plan: Omit<SlidePlan, 'base'>, frame: Omit<DeckSlide, 'bullets' | 'columns'>): SlidePlan {
  return { ...plan, base: assemble(plan, frame, plan.templateProse, plan.templateNotes) };
}
