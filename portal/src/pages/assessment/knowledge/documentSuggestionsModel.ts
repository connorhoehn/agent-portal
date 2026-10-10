// Per-suggestion review of an agent's proposed edit (agentic-flows slice 9) —
// the pure half. Port of realtime-examples' /doc suggestions
// (`frontend/src/editor/suggestions/DocumentSuggestionsPane.tsx`,
// `useRunSuggestionReview.ts`) onto the stored proposal metadata.
//
// The installed ui-components 2.410.0 `doc-editor` ships SuggestionCard and
// SuggestionReviewList but NO suggestion marks (no SuggestChanges / insert-delete
// mark extensions), so a suggestion here is one WHOLE BLOCK of the proposal's
// markdown, not a mark in the Y.Doc. Whole-block semantics follow
// realtime-examples' `wholeBlockResolve.test.tsx`: accepting keeps the block,
// rejecting removes it entirely (nothing marked, no empty heading or bullet
// left behind) — here because a rejected block is never inserted.
//
// Nothing durable lives in a decision. Accept/reject marks are the reviewer's
// local intent; when every block is decided, `planResolution` says what to
// commit: a Discard (nothing accepted), the stored proposal as it is (all
// accepted), or a revision narrowed to the accepted blocks followed by the
// ordinary Apply (claim, receipt, save acknowledgement).

export type SuggestionBlockKind = 'heading' | 'list' | 'code' | 'quote' | 'paragraph';
export interface SuggestionBlock {
  index: number;
  kind: SuggestionBlockKind;
  /** The block's markdown exactly as stored (no surrounding blank lines). */
  markdown: string;
  /** Readable text for the review card. */
  text: string;
}
export type SuggestionMark = 'accept' | 'reject';
export type SuggestionMarks = Readonly<Record<number, SuggestionMark>>;

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST = /^\s{0,3}([-*+]|\d+[.)])\s/;
const QUOTE = /^\s{0,3}>/;

function kindOf(lines: string[]): SuggestionBlockKind {
  const first = lines[0] ?? '';
  if (FENCE.test(first)) return 'code';
  if (HEADING.test(first)) return 'heading';
  if (LIST.test(first)) return 'list';
  if (QUOTE.test(first)) return 'quote';
  return 'paragraph';
}

function plain(markdown: string, kind: SuggestionBlockKind): string {
  if (kind === 'code') return markdown.split('\n').filter(line => !FENCE.test(line)).join('\n').trim();
  return markdown.split('\n').map(line => line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')).join('\n').trim();
}

/**
 * Split markdown into blocks. This is deliberately the same split Apply uses
 * (`insertContentFor`: runs of blank lines), so a block here is exactly one
 * node that would land in the page — what is shown is what is inserted.
 */
export function splitSuggestionBlocks(markdown: string): SuggestionBlock[] {
  return markdown.replace(/\r\n/g, '\n').split(/\n{2,}/).map(block => block.trim()).filter(Boolean).map((block, index) => {
    const kind = kindOf(block.split('\n'));
    return { index, kind, markdown: block, text: plain(block, kind) };
  });
}

/** Re-join blocks the way the drafter writes them: one blank line between blocks. */
export function joinSuggestionBlocks(blocks: readonly Pick<SuggestionBlock, 'markdown'>[]): string {
  return blocks.map(block => block.markdown).join('\n\n');
}

export type ResolutionPlan =
  /** Some blocks are still undecided; nothing is committed. */
  | { action: 'wait'; undecided: number[] }
  /** Nothing was accepted: the proposal is discarded and the page never changes. */
  | { action: 'discard' }
  /** Everything was accepted: the stored proposal applies as it is. */
  | { action: 'apply'; narrowed: false }
  /** A subset was accepted: revise to this content, then apply. */
  | { action: 'apply'; narrowed: true; content: string; accepted: number[] };

export function planResolution(markdown: string, marks: SuggestionMarks): ResolutionPlan {
  const blocks = splitSuggestionBlocks(markdown);
  const undecided = blocks.filter(block => marks[block.index] === undefined).map(block => block.index);
  if (undecided.length) return { action: 'wait', undecided };
  const accepted = blocks.filter(block => marks[block.index] === 'accept');
  if (accepted.length === 0) return { action: 'discard' };
  if (accepted.length === blocks.length) return { action: 'apply', narrowed: false };
  return { action: 'apply', narrowed: true, content: joinSuggestionBlocks(accepted), accepted: accepted.map(block => block.index) };
}

/** Marks for a proposal whose blocks all get one verdict. */
export function allMarks(markdown: string, mark: SuggestionMark): SuggestionMarks {
  return Object.fromEntries(splitSuggestionBlocks(markdown).map(block => [block.index, mark]));
}
