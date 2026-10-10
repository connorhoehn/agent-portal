export type SearchRecordType = 'person' | 'initiative' | 'work' | 'decision' | 'knowledge' | 'asset' | 'recording';
export interface SearchRef { type: SearchRecordType; id: string }
export interface SearchRecord extends SearchRef {
  title: string;
  description?: string;
  href: string;
  status?: string;
  subtitle?: string;
  /** Authorized directory portrait; absence uses the shared avatar's initials. */
  avatarUrl?: string;
  sourceRefs?: SearchRef[];
  /** Why the record matched ("Title match", "Matched through initiative membership"…). */
  matchReason?: string;
  /** The query terms the record matched, for marking in the row. */
  highlights?: string[];
  updatedAt?: string;
}
export interface SearchEdge { id: string; source: string; target: string; label: string }
export interface SearchResponse {
  query: string;
  results: SearchRecord[];
  counts: Record<SearchRecordType | 'all', number>;
  total: number;
  /** The server read a bounded window of some source, or a source failed: `total` and `counts` are floors. */
  totalIsLowerBound?: boolean;
  partial?: string[];
  related?: SearchRecord[];
  edges?: SearchEdge[];
}
export type SearchTab = 'results' | 'answer' | 'connections';
export type SearchSort = 'relevance' | 'recent';
export const SEARCH_TYPES: SearchRecordType[] = ['person', 'initiative', 'work', 'decision', 'knowledge', 'recording', 'asset'];
export const SEARCH_LABELS: Record<SearchRecordType | 'all', string> = {
  all: 'All results', person: 'People', initiative: 'Initiatives', work: 'Work', decision: 'Decisions', knowledge: 'Knowledge', asset: 'Agent library', recording: 'Recordings',
};
export const recordKey = (record: SearchRef) => `${record.type}:${record.id}`;
export function parseRecordKeys(value: string | null): SearchRef[] {
  return (value ?? '').split(',').flatMap(key => {
    const colon = key.indexOf(':');
    const type = key.slice(0, colon) as SearchRecordType;
    const id = key.slice(colon + 1);
    return colon > 0 && SEARCH_TYPES.includes(type) && id ? [{ type, id }] : [];
  }).slice(0, 30);
}
