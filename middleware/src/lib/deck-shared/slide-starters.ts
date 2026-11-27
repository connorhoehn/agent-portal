// What a new slide starts with, shared by the deck operations (`add_slide`) and
// the preview of an unfinished draft: the layouts, the payload field each owns,
// placeholder words per layout, and the placeholder citation of a slide that
// cites nothing yet.

import type { DeckSlide, DeckSource, SlideLayout } from '@connorhoehn/realtime-modules/deck';

export const SLIDE_LAYOUTS: readonly SlideLayout[] = [
  'title', 'section', 'bullets', 'two-column', 'chart', 'quote', 'image',
  'key-figures', 'table', 'comparison', 'timeline', 'agenda', 'closing',
];

/** The payload field each layout owns (bullets and eyebrow may sit on any slide). */
export const LAYOUT_PAYLOAD: Readonly<Partial<Record<SlideLayout, keyof DeckSlide>>> = {
  'two-column': 'columns', chart: 'chart', quote: 'quote', image: 'image', 'key-figures': 'figures',
  table: 'table', comparison: 'comparison', timeline: 'timeline', agenda: 'agenda', closing: 'closing',
};

export const UNSOURCED_SOURCE: DeckSource = { documentId: 'example:unsourced', title: 'Needs a source: this slide was added by an edit and cites nothing yet' };

/**
 * Starting content for a slide added without its layout's payload: words that
 * read as placeholders, never numbers. A chart has none: its data must come
 * from `fields.chart` or a `set_chart` later in the same list.
 */
export const STARTERS: Partial<Record<SlideLayout, Partial<DeckSlide>>> = {
  bullets: { bullets: ['First point'] },
  'two-column': { columns: [['Left point'], ['Right point']] },
  quote: { quote: { text: 'The quote goes here.', by: 'Who said it' } },
  image: { image: { alt: 'Describe the image' } },
  'key-figures': { figures: [{ value: 'TBD', label: 'First figure' }, { value: 'TBD', label: 'Second figure' }] },
  table: { table: { header: ['Item', 'Detail'], rows: [['First row', 'To fill in']] } },
  comparison: { comparison: { left: { title: 'Option A', points: ['First point'] }, right: { title: 'Option B', points: ['First point'] } } },
  timeline: { timeline: [{ date: 'Start', label: 'First step' }, { date: 'Next', label: 'Second step' }, { date: 'Then', label: 'Third step' }] },
  agenda: { agenda: { items: ['First item', 'Second item'] } },
  closing: { closing: { line: 'Thank you.' } },
};

export const LAYOUT_TITLE: Record<SlideLayout, string> = {
  title: 'Title', section: 'Section', bullets: 'Key points', 'two-column': 'Two columns', chart: 'Chart', quote: 'Quote',
  image: 'Image', 'key-figures': 'Key figures', table: 'Table', comparison: 'Comparison', timeline: 'Timeline',
  agenda: 'Agenda', closing: 'Next steps',
};
