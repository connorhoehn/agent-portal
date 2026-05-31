import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

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
  const { data: capEvents } = useFetch<{ events: CapabilityEvent[] }>(
    '/api/observability/capability-events?limit=50',
    5000,
  );
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const events = capEvents?.events ?? [];

  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (kindFilter === 'browser') return ev.kind.startsWith('browser');
      if (kindFilter === 'code') return ev.kind === 'code_execute';
      return true;
    });
  }, [events, kindFilter]);

  return (
    <PageSection
      title="Capability Events"
      description="Browser + code interpreter activity · live · 5s refresh"
      actions={
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as KindFilter)}
          style={selectStyle}
        >
          <option value="all">All kinds</option>
          <option value="browser">Browser</option>
          <option value="code">Code execute</option>
        </select>
      }
    >
      <Card padding="md">
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            {events.length === 0
              ? 'No browser or code-interpreter activity yet. Use the Capabilities page to trigger some.'
              : 'No events match the current filter.'}
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Kind</TableTh>
                <TableTh>Session</TableTh>
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
                    <TableTd
                      style={{
                        fontSize: 11,
                        color: 'var(--color-text-tertiary)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {new Date(ev.startedAt).toLocaleTimeString()}
                    </TableTd>
                    <TableTd>
                      <Chip tone={ev.kind.startsWith('browser') ? 'neutral' : 'info'} size="xs">
                        {ev.kind.replace('_', ' ')}
                      </Chip>
                    </TableTd>
                    <TableTd
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: 'var(--color-text-tertiary)',
                      }}
                    >
                      {ev.sessionId ? ev.sessionId.slice(0, 12) + '…' : '—'}
                    </TableTd>
                    <TableTd
                      style={{
                        fontSize: 12,
                        maxWidth: 380,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={detailText}
                    >
                      {detailText}
                    </TableTd>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
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

const selectStyle: CSSProperties = {
  fontSize: 12,
  padding: '4px 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

export default CapabilityEventsPage;
