// Which route the composer's Edit takes (docs/deck-edit-operations.md, "Proposals").
// A request that changes the deck's structure, a slide's layout, the style or
// theme, a decoration, an emphasis or a chart is asked as typed operations: the
// agent proposes, the person applies. Anything else (rewording, shortening, a
// different tone) stays the saved-version revise, which keeps the slide list
// and the theme by design and so cannot make those changes.

export type DeckEditIntent = 'operations' | 'revise';

const LAYOUT_WORDS = [
  'title', 'section', 'bullets?', 'two[- ]column', 'chart', 'quote', 'image', 'key[- ]figures?', 'table', 'comparison', 'timeline',
  'agenda', 'closing', 'big[- ]quote', 'process', 'cards', 'matrix', 'big[- ]number', 'image[- ]text', 'full[- ]image', 'people', 'funnel', 'kpi',
].join('|');

const OPERATION_PATTERNS: readonly RegExp[] = [
  // Structure: add, remove, move, reorder, duplicate a slide.
  /\b(add|insert|append|remove|delete|drop|move|reorder|swap)\b.*\bslides?\b/,
  /\bslides?\b.*\b(to the (start|end|beginning)|before|after) (slide|the)\b/,
  // Layout: "make slide 3 a KPI slide", "turn this into a timeline", "use the cards layout".
  new RegExp(`\\b(make|turn|change|convert|switch)\\b.*\\b(into |to |an? )(${LAYOUT_WORDS})\\b`),
  /\blayout\b/,
  // Style, theme, decoration.
  /\b(style|theme|decoration|graphic|blob|waves|dots|badge|rocket)\b/,
  /\b(editorial|minimal|playful|corporate) (look|feel)\b/,
  // Emphasis on words.
  /\b(emphasi[sz]e|highlight|underline|bold|accent)\b/,
  // Charts and reports.
  /\b(pie|bar|line|stacked)( chart)?\b.*\bon slide\b/,
  /\b(chart|graph|report|spend|runs by|findings by|jobs by)\b/,
];

export function deckEditIntent(text: string): DeckEditIntent {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return OPERATION_PATTERNS.some((p) => p.test(t)) ? 'operations' : 'revise';
}
