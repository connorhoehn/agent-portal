// What the preview found, as the editor shows it: one compact line with the
// kinds that matter named, and a list grouped by kind under it ("No speaker
// notes: slides 2 to 7"). Overflow, example sources and unfinished slides count
// as things to check before sharing; missing speaker notes and style advice are
// listed but never counted. Also: the placeholder source a slide added in the
// editor cites, the same one the server's `add_slide` gives.

import type { DeckSpec } from './deckApi.ts';

/** The server's `UNSOURCED_SOURCE` (middleware lib/deck-shared/slide-starters.ts; docs/deck-edit-operations.md). */
export const UNSOURCED_SOURCE = { documentId: 'example:unsourced', title: 'Needs a source: this slide was added by an edit and cites nothing yet' } as const;

/**
 * `next` with every slide that is new since `prev` and cites nothing given the
 * placeholder source, so Save stays on and the findings ask for the real one.
 * A slide that was already there keeps what its author left, even nothing.
 */
export function withPlaceholderSources(prev: DeckSpec | null, next: DeckSpec): DeckSpec {
  const before = new Set((prev?.slides ?? []).map(s => s.id));
  if (!next.slides.some(s => !before.has(s.id) && s.sources.length === 0)) return next;
  return { ...next, slides: next.slides.map(s => (!before.has(s.id) && s.sources.length === 0 ? { ...s, sources: [{ ...UNSOURCED_SOURCE }] } : s)) };
}

export type DeckFindingKind = 'overflow' | 'unfinished' | 'example-sources' | 'notes' | 'advice';

export interface DeckFindingGroup {
  kind: DeckFindingKind;
  label: string;
  /** 1-based slide numbers, ascending. */
  slides: number[];
  /** Counted toward "N things to check before sharing". */
  counts: boolean;
  /** The server's sentences, for the full list. */
  sentences: string[];
}

export interface DeckFindings {
  /** Findings that count (overflow, unfinished, example sources), one per slide each. */
  count: number;
  groups: DeckFindingGroup[];
  /** Slide number → the kinds found on it, for the slide list. */
  bySlide: Map<number, DeckFindingKind[]>;
}

const ORDER: DeckFindingKind[] = ['overflow', 'unfinished', 'example-sources', 'notes', 'advice'];
const LABEL: Record<DeckFindingKind, string> = {
  overflow: 'Overflow', unfinished: 'Unfinished', 'example-sources': 'Example sources', notes: 'No speaker notes', advice: 'Style advice',
};

function kindOf(sentence: string): DeckFindingKind {
  if (/ is unfinished:/.test(sentence)) return 'unfinished';
  if (/has no speaker notes\.$/.test(sentence)) return 'notes';
  if (/cites only (the template's example source|a placeholder)/.test(sentence)) return 'example-sources';
  // A layout finding reads "Slide N (id) region: detail" (middleware render.ts findingWarning).
  if (/^Slide \d+ \([^)]*\) [\w -]+: /.test(sentence) && !/wrap/i.test(sentence)) return 'overflow';
  return 'advice';
}

/** Groups the preview's warning sentences by kind. `slideCount` turns "every slide" into words. */
export function groupDeckWarnings(warnings: readonly string[]): DeckFindings {
  const groups = new Map<DeckFindingKind, DeckFindingGroup>();
  const bySlide = new Map<number, DeckFindingKind[]>();
  const exampleSlides = warnings.some(w => kindOf(w) === 'example-sources');
  for (const sentence of warnings) {
    // "Every slide cites the same source" says nothing new while the slides cite a template's example.
    if (/^Every slide cites the same source/.test(sentence) && exampleSlides) continue;
    const kind = kindOf(sentence);
    const group = groups.get(kind) ?? { kind, label: LABEL[kind], slides: [], counts: kind === 'overflow' || kind === 'unfinished' || kind === 'example-sources', sentences: [] };
    group.sentences.push(sentence);
    const n = Number(/^Slide (\d+)\b/.exec(sentence)?.[1] ?? NaN);
    if (Number.isFinite(n)) {
      if (!group.slides.includes(n)) group.slides.push(n);
      const kinds = bySlide.get(n) ?? [];
      if (!kinds.includes(kind)) bySlide.set(n, [...kinds, kind]);
    }
    groups.set(kind, group);
  }
  const ordered = ORDER.flatMap(k => (groups.has(k) ? [groups.get(k)!] : []));
  for (const g of ordered) g.slides.sort((a, b) => a - b);
  const count = ordered.filter(g => g.counts).reduce((n, g) => n + Math.max(g.slides.length, g.sentences.length && !g.slides.length ? 1 : 0), 0);
  return { count, groups: ordered, bySlide };
}

const SLIDE_FINDING_TONE: Partial<Record<DeckFindingKind, 'warning' | 'info'>> = { overflow: 'warning', unfinished: 'warning', 'example-sources': 'info' };

/**
 * The findings each slide's thumbnail is marked with (`PresentationEditor slideFindings`): overflow and unfinished as
 * warnings, an example or placeholder source as info. Speaker notes and style advice stay in the findings line only.
 * Keyed by slide id; a slide number the spec no longer has is dropped.
 */
export function deckSlideFindings(warnings: readonly string[], spec: Pick<DeckSpec, 'slides'>): Record<string, { tone: 'warning' | 'info'; label: string }[]> {
  const out: Record<string, { tone: 'warning' | 'info'; label: string }[]> = {};
  for (const [n, kinds] of groupDeckWarnings(warnings).bySlide) {
    const id = spec.slides[n - 1]?.id;
    if (!id) continue;
    const marks = ORDER.filter(k => kinds.includes(k) && SLIDE_FINDING_TONE[k]).map(k => ({ tone: SLIDE_FINDING_TONE[k]!, label: LABEL[k] }));
    if (marks.length) out[id] = marks;
  }
  return out;
}

/** "slide 4", "slides 2 and 5", "slides 2 to 7", "slides 1, 3 and 6"; "every slide" when it is all of them. */
export function slideRange(slides: readonly number[], slideCount?: number): string {
  if (slides.length === 0) return '';
  if (slideCount && slides.length === slideCount && slideCount > 1) return 'every slide';
  if (slides.length === 1) return `slide ${slides[0]}`;
  const contiguous = slides.every((n, i) => i === 0 || n === slides[i - 1]! + 1);
  if (contiguous && slides.length > 2) return `slides ${slides[0]} to ${slides[slides.length - 1]}`;
  return `slides ${slides.slice(0, -1).join(', ')} and ${slides[slides.length - 1]}`;
}

/** The compact line: "8 things to check before sharing" and the kinds that count, named with where. */
export function findingsSummary(findings: DeckFindings, slideCount?: number): { title: string; hint: string; tone: 'warning' | 'neutral' } | null {
  if (findings.groups.length === 0) return null;
  const counted = findings.groups.filter(g => g.counts);
  const named = (gs: DeckFindingGroup[]) => gs.slice(0, 3).map(g => `${g.label} (${slideRange(g.slides, slideCount) || 'the deck'})`).join(' · ');
  if (counted.length === 0) {
    return { title: 'Advice before sharing', hint: named(findings.groups), tone: 'neutral' };
  }
  const n = findings.count;
  return { title: `${n === 1 ? 'One thing' : `${n} things`} to check before sharing`, hint: named(counted), tone: 'warning' };
}
