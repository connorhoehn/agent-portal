// Word tokens for the search projection's postings (docs/user-search-goal.md U3).
//
// No trigrams, no SQL text search: a doc is posted under each word of its
// title and text, each word's plural-stripped stem, and — for title words
// only — every prefix of 3 to 10 letters, so "kube" finds a record titled
// "Kubernetes" while a long body does not explode into thousands of postings.
// A query term is looked up as itself and as its stem. Both implementations
// (memory, kv) use exactly these functions, which is what makes them answer
// the same.

const WORD_RE = /[\p{L}\p{N}]+/gu;
export const MIN_PREFIX = 3;
export const MAX_PREFIX = 10;

export function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

/** A plural-stripped stem: "collectors" → "collector", "policies" → "policy". Short words are left alone. */
export function stem(word: string): string {
  if (word.length <= 4 || /\d/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * The verb or noun a "-tion" word is made from: "transcription" → "transcript", "connections" → "connect".
 * Posted beside the word so a query for "transcripts" (stem "transcript") finds a message about the
 * transcription queue. Only long words: "action" and "nation" stay whole. Query terms are not rooted.
 */
export function tionRoot(word: string): string | null {
  return word.length >= 8 && /tions?$/.test(word) && !/\d/.test(word) ? word.replace(/ions?$/, '') : null;
}

/** Every posting key a doc with this title and text is filed under. */
export function docTokens(title: string, text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(title)) {
    out.add(w); out.add(stem(w));
    const titleRoot = tionRoot(w); if (titleRoot) out.add(titleRoot);
    for (let n = MIN_PREFIX; n <= Math.min(MAX_PREFIX, w.length - 1); n++) out.add(w.slice(0, n));
  }
  for (const w of words(text)) { out.add(w); out.add(stem(w)); const root = tionRoot(w); if (root) out.add(root); }
  return out;
}

/** The posting keys one query term is looked up under. */
export function termKeys(term: string): string[] {
  const t = term.toLowerCase();
  return [...new Set([t, stem(t)])].filter(Boolean);
}

/** Facet values are matched case-insensitively. */
export const facetValue = (value: string): string => value.trim().toLowerCase();
