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
): ResultGroup[] {
  return RESULT_GROUP_ORDER.flatMap(type => {
    const records = results.filter(record => record.type === type);
    if (!records.length) return [];
    const count = Math.max(counts[type] ?? records.length, records.length);
    return [{ id: type, label: SEARCH_LABELS[type], count, records, ...(count > records.length ? { seeAllHref: seeAllHref(type) } : {}) }];
  });
}

const OPEN_LABELS: Record<SearchRecordType, string> = {
  person: 'Open profile', initiative: 'Open initiative', work: 'Open work item',
  decision: 'Open decision', knowledge: 'Open document', asset: 'Open in library',
};
/** The labelled row action a scoped search draws (the library appends ↗). */
export const openLabelFor = (type: SearchRecordType) => OPEN_LABELS[type];

/** "2 results in Design System API" when scoped, "12 results" otherwise. */
export function resultsFooter(total: number, scopeName?: string | null): string {
  const noun = total === 1 ? 'result' : 'results';
  return scopeName ? `${total} ${noun} in ${scopeName}` : `${total} ${noun}`;
}

export function parseSort(value: string | null): SearchSort {
  return value === 'recent' ? 'recent' : 'relevance';
}
