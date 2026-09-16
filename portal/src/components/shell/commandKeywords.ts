// Making the palette's own hint text findable.
//
// WHAT WAS WRONG. Every entry in `PAGES` carries a `hint` — "Epics, stories,
// decisions and contributors", "MicroVM fleet + task runner" — and the palette
// renders it under the label, so the reader is looking straight at the words.
// None of them were searchable. The command handed to the library carries
// `label`, `hint`, `group`, `keywords` and `run`, but only the id, the label
// and the keywords reach the matcher; the hint is display-only. So the palette
// showed a user the word "epics" and then found nothing when they typed it.
//
// The fix is not a scorer. The library's `CommandPaletteProps` exposes no
// filter or ranking hook — that gap is real, it is already the last row of
// docs/ui-components-queue.md, and a scorer written here could never reach the
// rendered order. What the portal DOES own is the keyword list, so the hint's
// words go in there and the existing matcher finds them.
//
// Stopwords are dropped because the matcher is a loose subsequence match: a
// hint's worth of "the/and/with" in every entry is shared noise that makes
// common-letter queries match more things, not fewer.

/**
 * Words too common to discriminate between 73 entries. Deliberately short —
 * this is not a linguistic stopword list, it is the set of words that appear
 * in so many hints that including them would make every query match everything.
 */
const STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'what', 'from', 'that', 'this', 'into',
  'its', 'per', 'all', 'any', 'each', 'every', 'plus', 'via', 'you', 'your',
  // Interrogatives and auxiliaries. A hint reads "What is deployed and how it
  // is reached"; none of those five words narrows 73 entries down.
  'how', 'who', 'why', 'are', 'was', 'were', 'has', 'have', 'had', 'been',
  'does', 'did', 'can', 'not', 'but',
]);

/** Below this a word is punctuation or an article, not a search term. */
const MIN_LENGTH = 3;

/**
 * The searchable words in a hint: lowercased, de-punctuated, stopwords and
 * very short tokens dropped, order preserved, duplicates removed.
 */
export function hintKeywords(hint: string | undefined): string[] {
  if (!hint) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hint.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * The full keyword list for one command: the path (so pasting a URL fragment
 * still matches), the author's own synonyms, then the hint's words. The
 * author's synonyms come first because they are chosen; the hint's are
 * incidental, and the matcher reads the string left to right.
 *
 * Anything already present — in the path, the synonyms, or the label, which
 * the matcher sees separately — is dropped, so the value string does not grow
 * with repeats that only dilute a fuzzy match.
 */
export function commandKeywords(
  path: string,
  label: string,
  authored: string[] | undefined,
  hint: string | undefined,
): string[] {
  const chosen = [path, ...(authored ?? [])];
  const already = new Set<string>();
  for (const w of [...chosen, label].join(' ').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w) already.add(w);
  }
  return [...chosen, ...hintKeywords(hint).filter((w) => !already.has(w))];
}
