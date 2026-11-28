// What a new slide starts with, shared by the deck operations (`add_slide`) and
// the preview of an unfinished draft: the layouts, the payload fields each owns,
// starter words per layout, and the placeholder citation of a slide that cites
// nothing yet.
//
// Starter words read like the first draft of a real slide (so a preview looks
// like a slide, not a form), but never carry numbers anyone could mistake for
// data: figures say "TBD" and a chart has no starter at all.

import type { DeckSlide, DeckSource, SlideLayout } from '@connorhoehn/realtime-modules/deck';

export const SLIDE_LAYOUTS: readonly SlideLayout[] = [
  'title', 'section', 'bullets', 'two-column', 'chart', 'quote', 'image',
  'key-figures', 'table', 'comparison', 'timeline', 'agenda', 'closing',
  'big-quote', 'process', 'cards', 'matrix', 'big-number', 'image-text', 'image-full', 'people', 'funnel', 'kpi',
];

/**
 * The layouts that need a picture. There is no asset store yet, so a slide of
 * one of these shows the engine's placeholder (and its image-missing finding);
 * the templates leave them out.
 */
export const IMAGE_LAYOUTS: readonly SlideLayout[] = ['image', 'image-text', 'image-full'];

/** The payload fields each layout owns, the one it needs first (the engine's OWNERS table, by layout). */
export const LAYOUT_PAYLOADS: Readonly<Record<SlideLayout, readonly (keyof DeckSlide)[]>> = {
  title: [], section: [], bullets: [],
  'two-column': ['columns'], chart: ['chart'], quote: ['quote'], image: ['image'], 'key-figures': ['figures'],
  table: ['table'], comparison: ['comparison'], timeline: ['timeline'], agenda: ['agenda'], closing: ['closing'],
  'big-quote': ['quote'], process: ['items'], cards: ['items'], matrix: ['matrix'], 'big-number': ['figures'],
  'image-text': ['image'], 'image-full': ['image'], people: ['people'], funnel: ['funnel'], kpi: ['figures', 'chart'],
};

/** The main payload field of each layout (the first of `LAYOUT_PAYLOADS`). */
export const LAYOUT_PAYLOAD: Readonly<Partial<Record<SlideLayout, keyof DeckSlide>>> = Object.fromEntries(
  Object.entries(LAYOUT_PAYLOADS).filter(([, f]) => f.length > 0).map(([l, f]) => [l, f[0]]),
);

/** Every payload field any layout owns. */
export const PAYLOAD_FIELDS: readonly string[] = [...new Set(Object.values(LAYOUT_PAYLOADS).flat())];

/**
 * The layouts that draw `bullets`: as the points of a bullets slide, a cover's or
 * divider's standfirst, a two-column takeaway, a big number's story, or an image
 * slide's words. Every other layout ignores them, so moving a slide there drops them.
 */
export const BULLET_LAYOUTS: readonly SlideLayout[] = ['title', 'section', 'bullets', 'two-column', 'big-number', 'image-text', 'image-full'];

export const UNSOURCED_SOURCE: DeckSource = { documentId: 'example:unsourced', documentLabel: 'Needs a source', title: 'Needs a source: this slide was added by an edit and cites nothing yet' };

/**
 * Starting content for a slide added without its layout's payload. A chart has
 * none: its data must come from `fields.chart` or a `set_chart` later in the
 * same list (a kpi slide likewise needs its chart from one of those).
 */
export const STARTERS: Partial<Record<SlideLayout, Partial<DeckSlide>>> = {
  bullets: { bullets: ['The one point this slide makes'] },
  'two-column': { columns: [['What works today'], ['What we would change']] },
  quote: { quote: { text: 'Write the words exactly as they were said.', by: 'Who said it, and their role' } },
  image: { image: { alt: 'Describe the picture this slide will show' } },
  'image-text': { image: { alt: 'Describe the picture this slide will show' } },
  'image-full': { image: { alt: 'Describe the picture this slide will show' } },
  'key-figures': { figures: [{ value: 'TBD', label: 'The first number to report' }, { value: 'TBD', label: 'The second number to report' }] },
  'big-number': { figures: [{ value: 'TBD', label: 'The one number this slide is about', context: 'What it is measured against' }] },
  table: { table: { header: ['Item', 'Detail'], rows: [['First row', 'What it says']] } },
  comparison: { comparison: { left: { title: 'Option A', points: ['What it gives us'] }, right: { title: 'Option B', points: ['What it gives us'] } } },
  timeline: { timeline: [{ date: 'Start', label: 'Kick-off' }, { date: 'Next', label: 'First milestone' }, { date: 'Then', label: 'Hand-over' }] },
  agenda: { agenda: { items: ['Where we are', 'What comes next'] } },
  closing: { closing: { line: 'Thank you.' } },
  'big-quote': { quote: { text: 'Write the words exactly as they were said.', by: 'Who said it, and their role' } },
  process: {
    items: [
      { title: 'Gather', text: 'Collect what we already know', icon: 'search' },
      { title: 'Decide', text: 'Agree the approach with the owners', icon: 'handshake' },
      { title: 'Deliver', text: 'Ship it and measure the result', icon: 'rocket' },
    ],
  },
  cards: {
    items: [
      { title: 'First theme', text: 'One sentence on what it means for us', icon: 'lightbulb' },
      { title: 'Second theme', text: 'One sentence on what it means for us', icon: 'target' },
      { title: 'Third theme', text: 'One sentence on what it means for us', icon: 'users' },
    ],
  },
  matrix: {
    matrix: {
      x: ['Low effort', 'High effort'], y: ['Low value', 'High value'],
      quadrants: [
        { title: 'Quick wins', text: 'Do these first' }, { title: 'Big bets', text: 'Plan these carefully' },
        { title: 'Fill-ins', text: 'Do when there is slack' }, { title: 'Money pits', text: 'Leave these out' },
      ],
    },
  },
  people: { people: [{ name: 'Name to add', role: 'Their role on this work' }, { name: 'Name to add', role: 'Their role on this work' }] },
  funnel: { funnel: [{ label: 'First stage', value: 'TBD' }, { label: 'Second stage', value: 'TBD' }, { label: 'Third stage', value: 'TBD' }] },
};

export const LAYOUT_TITLE: Record<SlideLayout, string> = {
  title: 'Title', section: 'Section', bullets: 'Key points', 'two-column': 'Two columns', chart: 'Chart', quote: 'Quote',
  image: 'Image', 'key-figures': 'Key figures', table: 'Table', comparison: 'Comparison', timeline: 'Timeline',
  agenda: 'Agenda', closing: 'Next steps', 'big-quote': 'In their words', process: 'How it works', cards: 'Three themes',
  matrix: 'Where each option sits', 'big-number': 'The number that matters', 'image-text': 'Picture and words',
  'image-full': 'Full-bleed picture', people: 'Who is involved', funnel: 'From first touch to done', kpi: 'Headline and trend',
};
