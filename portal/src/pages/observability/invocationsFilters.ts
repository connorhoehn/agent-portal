// Pure helpers for seeding InvocationsPage's filters from the URL.
//
// Split out so the "which query params does this page honour on arrival"
// contract is unit-testable without mounting the page. Several links point
// here expecting to land pre-filtered: Health's "Read the failures on …"
// (?status=error, and one day ?agent=<name>), the Architecture graph and the
// agent detail page (?agentId=<name>) — see DEFECTS.md #7.

export type StatusFilter = 'all' | 'ok' | 'blocked' | 'error';

export const STATUS_VALUES: StatusFilter[] = ['all', 'ok', 'blocked', 'error'];

/** `agentId` is the existing convention (Architecture graph, agent detail
 *  page); `agent` is the name Health's copy uses. Either seeds the filter. */
export function parseAgentFilter(params: URLSearchParams): string {
  return params.get('agentId') ?? params.get('agent') ?? 'all';
}

export function parseStatusFilter(params: URLSearchParams): StatusFilter {
  const raw = params.get('status');
  return (STATUS_VALUES as string[]).includes(raw ?? '') ? (raw as StatusFilter) : 'all';
}

/** The write-side counterpart to parseAgentFilter/parseStatusFilter — keeps
 *  `location.search` describing exactly what the page shows. Returns a NEW
 *  URLSearchParams (the caller's is left untouched) with `agentId`/`status`
 *  set to the active filters, or removed when a filter is back to "all", and
 *  the legacy `agent` alias always dropped once it has been read (parsed by
 *  parseAgentFilter above) so it can't linger and re-seed a different agent
 *  than the canonical `agentId` this writes. Every other existing param is
 *  preserved untouched (DEFECTS.md #26 — Clear filters used to leave the old
 *  query string in place because nothing wrote back to it at all). */
export function applyFiltersToParams(
  params: URLSearchParams,
  agentFilter: string,
  statusFilter: StatusFilter,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('agent');
  if (agentFilter === 'all') {
    next.delete('agentId');
  } else {
    next.set('agentId', agentFilter);
  }
  if (statusFilter === 'all') {
    next.delete('status');
  } else {
    next.set('status', statusFilter);
  }
  return next;
}

/** The RESPONSE cell shows this for an error, with the full text left for
 *  hover (`title=`) and the detail page. A raw CSS `truncate` clips at a
 *  pixel width wherever that lands, mid-word — this cuts at the first
 *  sentence boundary instead so the visible text always reads as a whole
 *  thought (DEFECTS.md #15). Falls back to a word-boundary cut with an
 *  ellipsis when the first "sentence" is itself longer than `maxLen`, or
 *  there's no sentence-ending punctuation at all (e.g. a bare id/path). */
export function firstSentence(text: string, maxLen = 140): string {
  const trimmed = text.trim();
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/);
  const candidate = sentenceEnd >= 0 ? trimmed.slice(0, sentenceEnd + 1) : trimmed;
  if (candidate.length <= maxLen) return candidate;
  const cut = candidate.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
