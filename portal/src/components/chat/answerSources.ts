// answerSources — pull `[Source: …]` / `[Sources: …, …]` citation brackets out
// of agent prose so raw s3:// URIs never flood the chat. Returns the cleaned
// text plus an ordered, deduped source list for compact chip rendering
// (SourceChips). Pure and defensive: bracket groups with no recognizable URI
// are left untouched, and a dangling unclosed group at the end of a streaming
// chunk is hidden rather than flashed mid-write.

export interface AnswerSource {
  /** 1-based citation number, assigned in order of first appearance. */
  n: number;
  uri: string;
  /** Human label — last path segment, extension stripped, URI-decoded. */
  label: string;
}

export interface ExtractedSources {
  cleaned: string;
  sources: AnswerSource[];
}

// A bracket group like `[Source: s3://…]` or `[Sources: s3://a, https://b]`.
// URIs inside are split on commas only — s3 keys may contain spaces
// ("perf-Theo Williams.txt"), so whitespace is not a separator.
const SOURCE_GROUP_RE = /\[\s*Sources?\s*:\s*([^\]]*)\]/gi;
// An unclosed group at the very end (mid-stream or truncated output).
const DANGLING_TAIL_RE = /\[\s*Sources?\s*:[^\]]*$/i;
const URI_RE = /^(s3:\/\/|https?:\/\/)/i;

function labelFor(uri: string): string {
  const noScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const segments = noScheme.split('/').filter(Boolean);
  let last = segments[segments.length - 1] ?? noScheme;
  last = last.split(/[?#]/)[0] ?? last;
  try {
    last = decodeURIComponent(last);
  } catch {
    /* malformed escape — keep the raw segment */
  }
  // Strip a trailing file extension ("perf-Theo Williams.txt" → "perf-Theo
  // Williams") without eating dot-names that are all extension.
  const stripped = last.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  if (stripped.trim()) last = stripped;
  return last.trim() || uri;
}

/** Collapse the whitespace/punctuation debris left where a bracket group was. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+([.,;:!?])/g, '$1') // "word ." → "word."
    .replace(/\(\s*\)/g, '') // empty parens left behind
    .replace(/[ \t]{2,}/g, ' ') // doubled spaces
    .replace(/[ \t]+$/gm, '') // trailing spaces per line
    .replace(/\n{3,}/g, '\n\n') // blank-line runs
    .trim();
}

/**
 * Find every `[Source: <uri>]` / `[Sources: <uri>, <uri>, …]` group in the
 * text, remove them from the prose, and return the deduped sources in order
 * of first appearance. Safe on partial (streaming) text: only completed
 * bracket groups match, and an unclosed trailing group is suppressed.
 */
export function extractSources(text: string): ExtractedSources {
  if (!text || typeof text !== 'string') return { cleaned: text ?? '', sources: [] };

  const seen = new Set<string>();
  const sources: AnswerSource[] = [];

  const withoutGroups = text.replace(SOURCE_GROUP_RE, (whole, inner: string) => {
    const uris = inner
      .split(',')
      .map((s) => s.trim())
      .filter((s) => URI_RE.test(s));
    // A bracket group with no recognizable URI isn't a citation — leave it be.
    if (uris.length === 0) return whole;
    for (const uri of uris) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ n: sources.length + 1, uri, label: labelFor(uri) });
    }
    return '';
  });

  return { cleaned: tidy(withoutGroups.replace(DANGLING_TAIL_RE, '')), sources };
}
