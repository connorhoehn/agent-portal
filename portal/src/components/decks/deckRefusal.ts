// A deck the format would refuse, said as a person would say it: "Slide 2 needs a title", never the validator's
// "invalid DeckSpec: slides[1].title: required". Used for Save's disabled reason, a refused save and a refused
// set of operations. Also the placeholder title a slide added in the editor starts with, so the deck stays saveable.
//
// Free of runtime imports so `node --test` can load it.

import type { DeckSpec } from './deckApi.ts';

/** The server's `LAYOUT_TITLE` (middleware lib/deck-shared/slide-starters.ts): what `add_slide` titles a slide with. */
export const LAYOUT_PLACEHOLDER_TITLE: Readonly<Record<string, string>> = {
  title: 'Title', section: 'Section', bullets: 'Key points', 'two-column': 'Two columns', chart: 'Chart', quote: 'Quote',
  image: 'Image', 'key-figures': 'Key figures', table: 'Table', comparison: 'Comparison', timeline: 'Timeline',
  agenda: 'Agenda', closing: 'Next steps',
};

/** Ids of the slides in `next` that are new since `prev` (added from the gallery, the toolbar or a duplicate). */
export function newSlideIds(prev: DeckSpec | null, next: DeckSpec): string[] {
  const before = new Set((prev?.slides ?? []).map(s => s.id));
  return next.slides.filter(s => !before.has(s.id)).map(s => s.id);
}

/** `next` with every new slide that has no title given its layout's placeholder title; a slide already there keeps what its author left. */
export function withPlaceholderTitles(prev: DeckSpec | null, next: DeckSpec): DeckSpec {
  const fresh = new Set(newSlideIds(prev, next));
  if (!next.slides.some(s => fresh.has(s.id) && !s.title.trim())) return next;
  return { ...next, slides: next.slides.map(s => (fresh.has(s.id) && !s.title.trim() ? { ...s, title: LAYOUT_PLACEHOLDER_TITLE[s.layout] ?? 'New slide' } : s)) };
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  title: 'title', eyebrow: 'eyebrow', notes: 'speaker notes', sources: 'source', bullets: 'bullet', columns: 'column',
  chart: 'chart', labels: 'label', series: 'series', values: 'values', quote: 'quote', text: 'text', by: 'attribution',
  image: 'image', alt: 'image description', figures: 'key figure', value: 'value', label: 'label', delta: 'change',
  table: 'table', header: 'header', rows: 'row', comparison: 'comparison', left: 'left side', right: 'right side',
  points: 'point', timeline: 'timeline step', date: 'date', detail: 'detail', agenda: 'agenda item', items: 'item',
  current: 'current item', closing: 'closing', line: 'closing line', nextSteps: 'next step', contact: 'contact',
  subtitle: 'subtitle', layout: 'layout', kind: 'chart kind', name: 'name', documentId: 'source', id: 'id',
};

/** `chart.labels[2]` → "chart label 3"; `timeline[0].label` → "timeline step 1 label". */
function fieldWords(path: string): string {
  const words: string[] = [];
  for (const part of path.split('.')) {
    const m = part.match(/^([A-Za-z]+)((?:\[\d+\])*)$/);
    if (!m) { words.push(part); continue; }
    words.push(FIELD_WORDS[m[1]!] ?? m[1]!.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) words.push(String(Number(idx[1]) + 1));
  }
  return words.join(' ');
}

const SLIDE_ERROR = /^(?:deck\.)?slides\[(\d+)\]\.?([^:]*):\s*(.+)$/;

/** One validator line as a sentence, or null when it does not name a slide. */
export function plainDeckError(line: string): string | null {
  const m = line.trim().match(SLIDE_ERROR);
  if (!m) return null;
  const slide = `Slide ${Number(m[1]) + 1}`;
  const path = m[2]!.trim();
  const said = m[3]!.trim().replace(/\.$/, '');
  if (!path) return `${slide}: ${said}.`;
  if (/^sources?\b/.test(path) && /source|required|cite/.test(said)) return `${slide} needs a source.`;
  const field = fieldWords(path);
  if (/^required\b/.test(said) || /must be a non-empty string$/.test(said) && !/when present/.test(said)) {
    return `${slide} needs ${/^[aeiou]/.test(field) ? 'an' : 'a'} ${field}.`;
  }
  return `${slide}: the ${field} ${/^(must|is|has|a|an|at|only|both|no|expected)\b/.test(said) ? '' : 'is '}${said}.`.replace(/ {2,}/g, ' ');
}

/**
 * The refusal as the page shows it: the plain sentences when the validator named slides (each once), else the
 * server's own sentence. `message` may already carry the validator's lines after a colon ("invalid DeckSpec: …").
 */
export function plainDeckRefusal(message: string, errors: readonly string[] = []): string {
  const lines = errors.length ? [...errors] : message.replace(/^(?:operation \d+ \([^)]*\):\s*)?invalid DeckSpec:\s*/, '').split(/;\s*/);
  const plain = [...new Set(lines.map(plainDeckError).filter((s): s is string => !!s))];
  return plain.length ? plain.join(' ') : message;
}

/** Why the format would refuse this draft, said plainly (the first few problems), or null when it would save. */
export function draftRefusal(errors: readonly string[]): string | null {
  if (!errors.length) return null;
  const plain = [...new Set(errors.map(e => plainDeckError(e) ?? e))];
  return plain.slice(0, 3).join(' ') + (plain.length > 3 ? ` And ${plain.length - 3} more.` : '');
}
