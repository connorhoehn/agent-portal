import { SEARCH_LABELS, SEARCH_TYPES, type SearchRecord, type SearchRecordType, type SearchSort } from './searchTypes.ts';

/** A scoped browse starts with its work. Explicit filters and text searches
 * keep their meaning, including an explicit All results choice. */
export function searchResultType(value: string | null, scope: string, query: string): SearchRecordType | 'all' {
  if (value === 'all' || SEARCH_TYPES.includes(value as SearchRecordType)) return value as SearchRecordType | 'all';
  return scope && !query.trim() ? 'work' : 'all';
}

export interface ResultGroup {
  id: SearchRecordType | 'all';
  label: string;
  count: number;
  records: SearchRecord[];
}

/**
 * One collection per view. The rail owns type navigation; All results keeps
 * the server's relevance/recent ordering instead of regrouping each page into
 * successive People, Work, Documents, etc. Pagination applies to this list.
 */
export function groupResults(
  results: SearchRecord[],
  type: SearchRecordType | 'all',
  total: number,
  lowerBound = false,
): ResultGroup[] {
  if (!results.length) return [];
  return [{ id: type, label: `${SEARCH_LABELS[type]}${lowerBound ? ', at least' : ''}`,
    count: Math.max(total, results.length), records: results }];
}

/**
 * A tab or rail row's label and count. The library slots (`ScopeHeaderTab`,
 * `RailNavListItem`) take `count` as a number and draw it bare, so a count
 * that is a floor — `totalIsLowerBound`: a source failed or was read through a
 * capped window, and the server's every count is then a minimum — moves into
 * the label as "44+", the same spelling as the footer and the pager.
 */
export function countedLabel(label: string, count: number | undefined, lowerBound = false): { label: string; count?: number } {
  if (count === undefined) return { label };
  return lowerBound ? { label: `${label} ${count}+` } : { label, count };
}

/** The partial-source banner's title: what an incomplete read means for the numbers. */
export function partialSourcesTitle(partial: string[]): string {
  return partial.length === 1
    ? 'One source is incomplete — counts are minimums'
    : `${partial.length} sources are incomplete — counts are minimums`;
}

const OPEN_LABELS: Record<SearchRecordType, string> = {
  person: 'Open profile', initiative: 'Open initiative', work: 'Open work item',
  decision: 'Open decision', knowledge: 'Open document', asset: 'Open in library', recording: 'Open recording',
};
/** The labelled row action a scoped search draws (the library appends ↗). */
export const openLabelFor = (type: SearchRecordType) => OPEN_LABELS[type];

/** "2 results in Design System API" when scoped, "12 results" otherwise; "200+ results" when the count is a floor. */
export function resultsFooter(total: number, scopeName?: string | null, lowerBound = false): string {
  const noun = total === 1 && !lowerBound ? 'result' : 'results';
  const n = lowerBound ? `${total}+` : `${total}`;
  return scopeName ? `${n} ${noun} in ${scopeName}` : `${n} ${noun}`;
}

export function parseSort(value: string | null): SearchSort {
  return value === 'recent' ? 'recent' : 'relevance';
}
