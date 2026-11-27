// The preview of an unfinished draft. The editor previews on every edit, and a
// slide just added from the layout gallery has no title and blank fields, which
// the format (rightly) refuses to save. The preview still draws it: blanks are
// shown as an ellipsis, a missing title as "Untitled slide", fields left over
// from another layout are set aside, and a payload that still does not pass is
// shown with the layout's starter words. Each slide drawn that way is named in
// the warnings ("is unfinished"), so the page can say what to fill in.
// Nothing here is saved: save validates the real spec, unchanged.

import { validateDeckSpec, type DeckSpec, type SlideLayout } from '@connorhoehn/realtime-modules/deck';
import { LAYOUT_PAYLOAD, SLIDE_LAYOUTS, STARTERS, UNSOURCED_SOURCE } from './slide-starters.js';

export const DRAFT_TITLE = 'Untitled slide';
const BLANK = '…';
const PAYLOAD_FIELDS = Object.values(LAYOUT_PAYLOAD) as string[];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => typeof v === 'string' && !v.trim();

/** Every blank string inside `v` (deeply) becomes an ellipsis; numbers and the rest are kept. */
function fillBlanks(v: unknown): unknown {
  if (blank(v)) return BLANK;
  if (Array.isArray(v)) return v.map(fillBlanks);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillBlanks(x)]));
  return v;
}

const probeErrors = (slide: Record<string, unknown>): string[] => {
  const out = validateDeckSpec({ title: 'probe', slides: [slide] });
  return out.ok ? [] : out.errors.map((e) => e.replace(/^(deck\.)?slides\[0\]\.?\s*:?\s*/, '').trim());
};

/** What to tell the author about a slide's own errors, in a few words. */
function missing(errors: string[]): string {
  const words = errors.map((e) => (/^title: required/.test(e) ? 'a title'
    : /must cite/.test(e) ? 'a source'
    : /must be a non-empty string|non-empty/.test(e) ? 'its blank fields'
      : /needs (at least one )?(\w[\w -]*)$/.exec(e)?.[0]?.replace(/^needs /, '') ?? e));
  return [...new Set(words)].slice(0, 3).join(', ');
}

export interface PreviewableDraft {
  spec: DeckSpec;
  /** One sentence per slide that was drawn from a stand-in: "Slide 4 (s-1) is unfinished: needs a title." */
  unfinished: string[];
}

/**
 * A spec the format accepts, drawn from an unfinished draft, or null when the
 * draft is not a deck at all (no slides, an unknown layout, a duplicate id) or
 * cannot be drawn even from starters. Only for the preview: never saved.
 */
export function previewableDraft(raw: unknown): PreviewableDraft | null {
  if (!isObj(raw) || !Array.isArray(raw.slides) || raw.slides.length === 0) return null;
  const unfinished: string[] = [];
  const slides: Record<string, unknown>[] = [];
  for (const [index, entry] of raw.slides.entries()) {
    if (!isObj(entry) || typeof entry.id !== 'string' || !(SLIDE_LAYOUTS as readonly unknown[]).includes(entry.layout)) return null;
    const layout = entry.layout as SlideLayout;
    const own = LAYOUT_PAYLOAD[layout];
    const before = probeErrors(entry);
    if (before.length === 0) { slides.push(entry); continue; }
    const slide: Record<string, unknown> = { ...entry };
    for (const field of PAYLOAD_FIELDS) if (field !== own) delete slide[field];
    if (typeof slide.title !== 'string' || !slide.title.trim()) slide.title = DRAFT_TITLE;
    if (!Array.isArray(slide.sources) || slide.sources.length === 0) slide.sources = [UNSOURCED_SOURCE];
    for (const key of ['bullets', 'eyebrow', ...(own ? [own] : [])]) if (slide[key] !== undefined) slide[key] = fillBlanks(slide[key]);
    if (Array.isArray(slide.bullets) && slide.bullets.length === 0) delete slide.bullets;
    if (probeErrors(slide).length > 0) {
      // The payload itself does not pass (too few steps, a leftover shape): show the layout's starter.
      if (own) delete slide[own];
      if (layout === 'bullets') delete slide.bullets;
      Object.assign(slide, structuredClone(STARTERS[layout] ?? {}));
      if (probeErrors(slide).length > 0) return null;
    }
    slides.push(slide);
    unfinished.push(`Slide ${index + 1} (${entry.id}) is unfinished: it needs ${missing(before)}.`);
  }
  const deck = { ...raw, slides, title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled presentation' };
  const valid = validateDeckSpec(deck);
  return valid.ok ? { spec: valid.spec, unfinished } : null;
}
