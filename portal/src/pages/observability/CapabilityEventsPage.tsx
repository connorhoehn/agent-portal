import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Card,
  InlinePlaceholder,
  Select,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  Inline,
  PageSection,
  SearchInput,
  T,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { ObservabilityCommandSection } from './ObservabilityCommandSection';
import { OBSERVABILITY_GRAMMARS, matchesAny } from './observabilityCommands';

type CapabilityKind =
  | 'browser_navigate'
  | 'browser_screenshot'
  | 'browser_launch'
  | 'browser_close'
  | 'code_execute';

interface CapabilityEvent {
  id: string;
  kind: CapabilityKind;
  startedAt: string;
  durationMs: number;
  sessionId: string;
  detail: Record<string, string | number | boolean | undefined>;
  ok: boolean;
  error?: string;
}

type KindFilter = 'all' | 'browser' | 'code';

function CapabilityEventsPage() {
  const { data: capEvents, refresh } = useFetch<{ events: CapabilityEvent[] }>(
    '/api/observability/capability-events?limit=50',
    5000,
  );
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');

  const events = capEvents?.events ?? [];

  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (kindFilter === 'browser' && !ev.kind.startsWith('browser')) return false;
      if (kindFilter === 'code' && ev.kind !== 'code_execute') return false;
      return matchesAny(query, ev.sessionId, ev.kind, formatCapDetail(ev), ev.error);
    });
  }, [events, kindFilter, query]);

  const adapter = collectionCommandAdapter(OBSERVABILITY_GRAMMARS.capabilityEvents, {
    setQuery, refresh,
    setFilter: (value) => setKindFilter(value === 'browser' || value === 'code' ? value : 'all'),
    scopeNote: 'Search and the kind filter apply to the events this process holds in memory. Refresh rereads that feed. Nothing here launches a browser or runs code.',
  });

  return (
    <PageSection
      title="Capability Events"
      description="Browser + code interpreter activity · live · 5s refresh"
      actions={
        <Inline gap="sm" align="center">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search capability events"
          aria-label="Search capability events"
          className="w-[220px]"
        />
        <Select
          aria-label="Filter by capability kind"
          size="sm"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as KindFilter)}
          options={[
            { value: 'all', label: 'All kinds' },
            { value: 'browser', label: 'Browser' },
            { value: 'code', label: 'Code execute' },
          ]}
        />
        </Inline>
      }
    >
      <ObservabilityCommandSection adapter={adapter}>
      <Card padding="md">
        {filtered.length === 0 ? (
          <InlinePlaceholder align="center" className="text-xs p-6">
            {events.length === 0 ? (
              <>
                No browser or code-interpreter activity in this process. The feed is
                held in memory and starts empty whenever the middleware restarts, so
                this is not a claim that the capabilities have never run. Trigger some
                from the{' '}
                <Link to="/admin/capabilities" className="text-[var(--color-primary)] no-underline">
                  Capabilities page
                </Link>.
              </>
            ) : 'No events match the current search or filter.'}
          </InlinePlaceholder>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Session</TableTh>
                <TableTh>When</TableTh>
                <TableTh>Kind</TableTh>
                <TableTh>Detail</TableTh>
                <TableTh>Duration</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((ev) => {
                const detailText = formatCapDetail(ev);
                return (
                  <TableRow key={ev.id}>
                    <TableTd className="text-[var(--color-text-tertiary)]">
                      <T className="font-mono">{ev.sessionId ? ev.sessionId.slice(0, 12) + '…' : '—'}</T>
                    </TableTd>
                    <TableTd className="text-[var(--color-text-tertiary)] whitespace-nowrap" title={new Date(ev.startedAt).toLocaleString()}>
                      {relativeTime(ev.startedAt)}
                    </TableTd>
                    <TableTd>
                      <Chip tone={ev.kind.startsWith('browser') ? 'neutral' : 'info'} size="xs">
                        {ev.kind.replace('_', ' ')}
                      </Chip>
                    </TableTd>
                    <TableTd
                      className="text-xs max-w-[380px] overflow-hidden text-ellipsis whitespace-nowrap"
                      title={detailText}
                    >
                      {detailText}
                    </TableTd>
                    <TableTd className="text-[var(--color-text-tertiary)]">
                      {(ev.durationMs / 1000).toFixed(2)}s
                    </TableTd>
                    <TableTd>
                      {ev.ok ? (
                        <Chip tone="success" size="xs">
                          ok
                        </Chip>
                      ) : (
                        <Chip tone="danger" size="xs">
                          err
                        </Chip>
                      )}
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      </ObservabilityCommandSection>
    </PageSection>
  );
}

function formatCapDetail(ev: CapabilityEvent): string {
  const d = ev.detail || {};
  switch (ev.kind) {
    case 'browser_launch':
      return `${d['agentName'] ?? ''} → ${d['url'] ?? 'about:blank'}${
        d['pageTitle'] ? ` (${d['pageTitle']})` : ''
      }`;
    case 'browser_navigate':
      return `→ ${d['url']}${d['pageTitle'] ? ` (${d['pageTitle']})` : ''}`;
    case 'browser_screenshot':
      return `${d['bytes']} bytes`;
    case 'browser_close':
      return 'session closed';
    case 'code_execute':
      return `${d['codeSnippet']} → ${d['outputSnippet']}`;
    default:
      return JSON.stringify(d);
  }
}

export default CapabilityEventsPage;
