import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  Inline,
  Input,
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
import { T } from './Text';

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
  const { data, error, refresh } = useFetch<{ sessions: SessionSummary[] }>('/api/sessions', 15000);
  const [query, setQuery] = useState('');

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
          <T className="text-[11px] text-text-tertiary">
            {filtered.length} session{filtered.length !== 1 ? 's' : ''}
          </T>
        </Inline>
      }
    >
      <Card padding="md">
        {filtered.length === 0 ? (
          <T as="div" className="p-6 text-center text-[12px] text-[var(--color-text-tertiary)]">
            {unavailable ? (
              <>
                <T as="div" className="font-semibold text-[var(--color-text-secondary)]">
                  Couldn’t load your chat sessions
                </T>
                <T as="div" className="mt-1">
                  {needsAuth
                    ? 'Your session expired — sign in to see them. Nothing has been deleted.'
                    : `The session list request failed (${error}).`}
                </T>
              </>
            ) : sessions.length === 0
              ? 'No chat sessions yet. Start a conversation on the Agent Tools page.'
              : 'No sessions match the current filter.'}
          </T>
        ) : (
          <Table>
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
              {filtered.map((s) => (
                <TableRow key={s.sessionId}>
                  <TableTd
                    className="text-[12px] font-medium max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap"
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
                      <T className="text-[11px] text-[var(--color-text-tertiary)]">—</T>
                    )}
                  </TableTd>
                  <TableTd className="text-[11px] text-[var(--color-text-tertiary)] font-mono">
                    {s.actorId ?? '—'}
                  </TableTd>
                  <TableTd className="text-[11px] text-[var(--color-text-tertiary)] whitespace-nowrap">
                    {new Date(s.createdAt).toLocaleString()}
                  </TableTd>
                  <TableTd className="text-[11px] text-[var(--color-text-tertiary)] whitespace-nowrap">
                    {s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : '—'}
                  </TableTd>
                  <TableTd className="text-[12px]">{s.messageCount ?? '—'}</TableTd>
                  <TableTd
                    className="text-[10px] font-mono text-[var(--color-text-tertiary)]"
                    title={s.sessionId}
                  >
                    {s.sessionId.slice(0, 12)}…
                  </TableTd>
                  <TableTd>
                    <Link
                      to={`/iq/invoke?session=${encodeURIComponent(s.sessionId)}`}
                      className="text-[11px] px-2 py-0.5 bg-transparent border border-[var(--color-border)] text-[var(--color-text-secondary)] rounded-[var(--radius-sm)] cursor-pointer no-underline"
                    >
                      Open
                    </Link>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageSection>
  );
}

export default SessionsPage;
