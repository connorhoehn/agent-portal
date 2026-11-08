import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { DocumentResultList } from '@connorhoehn/ui-components';
import { Button, Inline, InlineAlert, LoadingState, SearchInput, Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type { SearchResponse } from '../../pages/search/searchTypes';

/** Assessment has no Work search grant. Use its own team-read authority and
 * native recording participant checks, without borrowing another tenant. */
export function RecordingContentSearch({ lobby, documentSourceId, onActive }: { lobby: string; documentSourceId?: string; onActive(active: boolean): void }) {
  const teamId = /^assessment:team:(TEAM-[A-Za-z0-9-]{1,120})$/.exec(lobby)?.[1];
  const scope = documentSourceId && lobby.startsWith('assessment:doc:') ? { documentSourceId } : teamId ? { teamId } : null;
  return scope ? <ScopedRecordingSearch key={JSON.stringify(scope)} scope={scope} onActive={onActive} /> : null;
}
type RecordingSearchScope = { teamId: string; documentSourceId?: never } | { documentSourceId: string; teamId?: never };
function ScopedRecordingSearch({ scope, onActive }: { scope: RecordingSearchScope; onActive(active: boolean): void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    onActive(!!query.trim());
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query, onActive]);
  useEffect(() => () => onActive(false), [onActive]);
  return <Stack gap="sm" data-testid="recording-content-search">
    <SearchInput size="sm" value={query} onChange={value => setQuery(value.slice(0, 1000))}
      placeholder="Search transcripts and summaries…" aria-label="Search recording content" />
    {query.trim() && (query.trim() !== debounced ? <LoadingState label="Searching recording content…" />
      : <RecordingSearchResults key={`${JSON.stringify(scope)}:${debounced}`} scope={scope} query={debounced} />)}
  </Stack>;
}
function RecordingSearchResults({ scope, query }: { scope: RecordingSearchScope; query: string }) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ q: query, limit: '20', offset: String(offset) });
  if (scope.documentSourceId) params.set('documentSourceId', scope.documentSourceId); else params.set('teamId', scope.teamId!);
  // The request-keyed boundary prevents old query/page results remaining visible
  // during a fresh read. The parent recording shelf is also actor-keyed.
  return <ResultPage key={params.toString()} url={`/api/assessment/recordings/search?${params}`}
    query={query} offset={offset} onOffset={setOffset} onOpen={href => navigate(href)} />;
}
function ResultPage({ url, query, offset, onOffset, onOpen }: { url: string; query: string; offset: number; onOffset(value: number): void; onOpen(href: string): void }) {
  const { data, isLoading, error, refresh } = useFetch<SearchResponse>(url);
  if (isLoading) return <LoadingState label="Searching recording content…" />;
  if (error) return <InlineAlert tone="warning">Recording content could not be searched. <Button size="sm" variant="link" onClick={refresh}>Retry</Button></InlineAlert>;
  const records = data?.results.filter(record => record.type === 'recording') ?? [];
  const incomplete = !!data?.totalIsLowerBound || !!data?.partial?.length;
  return <Stack gap="sm" data-testid="recording-content-results">
    {incomplete && <InlineAlert tone="info">Some recordings could not be searched. These results may be incomplete.</InlineAlert>}
    <DocumentResultList draggable={false} aria-label={`Recordings matching ${query}`}
      items={records.map(record => ({ id: record.id, title: record.title, summary: record.description,
        kind: 'recording' as const, folder: record.subtitle, updatedAt: record.updatedAt }))}
      onOpen={item => { const record = records.find(row => row.id === item.id); if (record) onOpen(record.href); }}
      emptyState={<T size="xs" tone="secondary">{incomplete ? 'No matching recordings in the available results.' : 'No matching transcripts or summaries.'}</T>} />
    {!!data && <Inline align="center" justify="between" gap="sm">
      <T size="xs" tone="secondary">{data.total}{incomplete ? '+' : ''} matching {data.total === 1 && !incomplete ? 'recording' : 'recordings'}</T>
      {(offset > 0 || data.total > offset + records.length) && <Inline gap="xs">
        <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - 20))}>Previous</Button>
        <Button size="sm" variant="secondary" disabled={offset + records.length >= data.total} onClick={() => onOffset(offset + 20)}>Next</Button>
      </Inline>}
    </Inline>}
  </Stack>;
}
