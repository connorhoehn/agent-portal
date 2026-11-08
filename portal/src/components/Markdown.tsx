// Read-only markdown for assistant responses, crawl summaries, and any other
// LLM-produced text.
//
// This was 110 lines of hand-rolled `react-markdown` with a `components={{}}`
// override and twenty inline `CSSProperties` objects for every element — its
// own h1..h4, list, link, table, blockquote and code styling, none of it
// reachable by the design system. The library ships `MarkdownView`, built on
// the SAME react-markdown + remark-gfm stack, styling with design tokens; two
// pages in this portal (`distillation/ArtifactsPage`, `assessment/knowledge/
// DocPane`) were already using it directly, so the portal had a library
// renderer and a private clone of it rendering the same kind of text
// differently.
//
// What is kept, and why this file still exists at all: the local renderer
// deliberately DE-EMPHASISED headings — h1 at 17px rather than a page title —
// because this markdown is assistant prose inside a card, not a document.
// `MarkdownView` renders a real `<h1>` at `text-xl`, and exposes no prop for a
// reduced scale, so that intent survives here as class overrides on the one
// wrapper instead of as a second markdown implementation. If the library grows
// a `scale`/`density` prop, this file becomes a direct re-export.

import { MarkdownView } from '@connorhoehn/ui-components/shared';

interface MarkdownProps {
  children: string;
  /**
   * Base font size in px. Only the sizes actually used are mapped — Tailwind
   * cannot build a class from a runtime number, and inventing arbitrary
   * `text-[Npx]` strings at call time would defeat the purge step. Anything
   * else falls back to the body scale, which is what every caller but one
   * already wanted.
   */
  size?: number;
}

const SCALE: Record<number, string> = {
  13: 'text-[13px]',
  14: 'text-sm',
};

/**
 * Assistant-prose scale: headings stepped down so a model's `#` heading reads
 * as a section inside a card rather than competing with the page title. Sizes
 * match the ones the hand-rolled renderer used (17/15/14/13px).
 */
const PROSE =
  '[&_h1]:text-[17px] [&_h1]:mt-3.5 [&_h1]:mb-1.5 '
  + '[&_h2]:text-[15px] [&_h2]:mt-3 [&_h2]:mb-1.5 '
  + '[&_h3]:text-sm [&_h3]:mt-2.5 [&_h3]:mb-1 '
  + '[&_h4]:text-[13px] [&_h4]:mt-2 [&_h4]:mb-1';

export function Markdown({ children, size = 14 }: MarkdownProps) {
  return <MarkdownView markdown={children} className={`${SCALE[size] ?? 'text-sm'} ${PROSE}`} />;
}
