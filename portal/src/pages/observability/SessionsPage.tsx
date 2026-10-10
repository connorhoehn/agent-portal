import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  Inline,
  InlinePlaceholder,
  Input,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  PageSection, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { showingLabel } from '../../lib/format';

// Hand-rolled `Table` (not `DataTable`), so there's no built-in pagination
// lever — this page renders every session `/api/sessions` returns in one
// unwindowed table body. Cap it and reveal more a batch at a time, the same
// contract as everywhere else in this pass: never fewer rows shown than the
// page admits to.
const SESSIONS_PAGE_SIZE = 50;

interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: string;
  title?: string;
  agentId?: string;
  agentName?: string;
  messageCount?: number;
  lastMessageAt?: string;
}

function SessionsPage() {
  const { data, error, refresh } = useFetch<{ sessions: SessionSummary[]; memoryUnavailable?: string }>(
    '/api/sessions', 15000);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(SESSIONS_PAGE_SIZE);

  const sessions = data?.sessions ?? [];
  // /api/sessions is session-guarded, so an expired cookie 401s. "No chat
  // sessions yet" would then be the page telling the user their conversations
  // do not exist, on the strength of a request that never succeeded.
  const unavailable = Boolean(error) && !data;
  const needsAuth = /\b401\b|\b403\b/.test(error ?? '');

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.title?.toLowerCase().includes(q) ?? false) ||
        s.sessionId.toLowerCase().includes(q) ||
        (s.agentName?.toLowerCase().includes(q) ?? false) ||
        (s.actorId?.toLowerCase().includes(q) ?? false),
    );
  }, [sessions, query]);
  // Reset the reveal window whenever the filter changes, so a narrower
  // search doesn't inherit a stale "show more" position from a wider one.
  useEffect(() => { setLimit(SESSIONS_PAGE_SIZE); }, [query]);
  const visible = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  return (
    <PageSection
      title="Chat Sessions"
      description="From AgentCore Memory · 15s refresh"
      actions={
        <Inline gap="sm" align="center">
          <Input
            type="search"
            size="sm"
            placeholder="Filter by title, agent, session id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-[240px]"
          />
          <Button variant="secondary" size="sm" onClick={() => refresh()}>
            Refresh
          </Button>
          <T size="xs" className="text-text-tertiary">{showingLabel(visible.length, filtered.length, 'sessions')}</T>
        </Inline>
      }
    >
      <Card padding="md">
        {filtered.length === 0 ? (
          unavailable ? (
            <UnavailableNotice
              error={
                needsAuth
                  ? 'Your session expired — sign in to see them. Nothing has been deleted.'
                  : (error ?? 'The session list request failed.')
              }
              what="your chat sessions"
              onRetry={refresh}
            />
          ) : (
            <InlinePlaceholder align="center" className="text-xs p-6">
              {/* "Start a conversation" is only useful advice when a
                  conversation could actually be recorded. Offline it cannot:
                  AgentCore Memory is unconfigured under dev:mock, so
                  `recordTurn` writes nothing and the instruction sends the
                  reader off to do something that silently no-ops. Name the
                  cause instead — the treatment CapabilityEventsPage already
                  gives its own in-memory feed. */}
              {sessions.length === 0
                ? (data?.memoryUnavailable
                  ? `${data.memoryUnavailable}. This is not a claim that no one has ever chatted with an agent — nothing can be read here until Memory is configured.`
                  : 'No chat sessions yet. Start a conversation on the Agent Tools page.')
                : 'No sessions match the current filter.'}
            </InlinePlaceholder>
          )
        ) : (
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableTh>Title</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Actor</TableTh>
                <TableTh>Started</TableTh>
                <TableTh>Last Message</TableTh>
                <TableTh>Messages</TableTh>
                <TableTh>Session ID</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((s) => (
                <TableRow key={s.sessionId}>
                  <TableTd
                    className="text-xs max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap"
                    title={s.title}
                  >
                    {s.title ?? <T className="text-[var(--color-text-tertiary)]">untitled</T>}
                  </TableTd>
                  <TableTd>
                    {s.agentName ? (
                      <Chip tone="neutral" size="xs">
                        {s.agentName.replace('orgiq-', '')}
                      </Chip>
                    ) : (
                      <T size="xs" className="text-[var(--color-text-tertiary)]">—</T>
                    )}
                  </TableTd>
                  <TableTd className="text-[var(--color-text-tertiary)] font-mono">
                    {s.actorId ?? '—'}
                  </TableTd>
                  <TableTd className="text-[var(--color-text-tertiary)] whitespace-nowrap">
                    {new Date(s.createdAt).toLocaleString()}
                  </TableTd>
                  <TableTd className="text-[var(--color-text-tertiary)] whitespace-nowrap">
                    {s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : '—'}
                  </TableTd>
                  <TableTd>{s.messageCount ?? '—'}</TableTd>
                  <TableTd
                    className="text-xs font-mono text-[var(--color-text-tertiary)]"
                    title={s.sessionId}
                  >
                    {s.sessionId.slice(0, 12)}…
                  </TableTd>
                  <TableTd>
                    <Link
                      to={`/iq/invoke?session=${encodeURIComponent(s.sessionId)}`}
                      className="text-xs px-2 py-0.5 bg-transparent border border-[var(--color-border)] text-[var(--color-text-secondary)] rounded-[var(--radius-sm)] cursor-pointer no-underline"
                    >
                      Open
                    </Link>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {hasMore && (
          <Inline justify="center" className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + SESSIONS_PAGE_SIZE)}>
              Show {Math.min(SESSIONS_PAGE_SIZE, filtered.length - visible.length)} more
            </Button>
          </Inline>
        )}
      </Card>
    </PageSection>
  );
}

export default SessionsPage;
