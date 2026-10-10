import { SEARCH_LABELS, SEARCH_TYPES, type SearchRecord, type SearchRecordType, type SearchSort } from './searchTypes.ts';

/** The Results tab's group order — the order the mockup draws. */
export const RESULT_GROUP_ORDER: SearchRecordType[] = SEARCH_TYPES;

export interface ResultGroup {
  id: SearchRecordType;
  label: string;
  count: number;
  records: SearchRecord[];
  seeAllHref?: string;
}

/**
 * Group one page of results by type, in display order. Each group's count is
 * the server's per-type count (the whole result set, not this page) and its
 * "See all" narrows the search to that type. A type with no rows on this page
 * is left out rather than drawn as an empty heading.
 */
export function groupResults(
  results: SearchRecord[],
  counts: Partial<Record<SearchRecordType | 'all', number>>,
  seeAllHref: (type: SearchRecordType) => string,
  lowerBound = false,
): ResultGroup[] {
  return RESULT_GROUP_ORDER.flatMap(type => {
    const records = results.filter(record => record.type === type);
    if (!records.length) return [];
    const count = Math.max(counts[type] ?? records.length, records.length);
    // The group heading draws `count` as a bare number, so a floor says so in
    // the label it sits beside: "Decisions, at least 2".
    const label = lowerBound ? `${SEARCH_LABELS[type]}, at least` : SEARCH_LABELS[type];
    return [{ id: type, label, count, records, ...(count > records.length ? { seeAllHref: seeAllHref(type) } : {}) }];
  });
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
  decision: 'Open decision', knowledge: 'Open document', asset: 'Open in library',
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
