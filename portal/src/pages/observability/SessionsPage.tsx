import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

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
  const { data, refresh } = useFetch<{ sessions: SessionSummary[] }>('/api/sessions', 15000);
  const [query, setQuery] = useState('');

  const sessions = data?.sessions ?? [];

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
    <div style={{ padding: 24 }}>
      <Card padding="md">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            Chat Sessions{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              from AgentCore Memory · 15s refresh
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="search"
              placeholder="Filter by title, agent, session id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                fontSize: 12,
                padding: '4px 8px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                width: 240,
              }}
            />
            <button
              type="button"
              onClick={() => refresh()}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                cursor: 'pointer',
              }}
            >
              Refresh
            </button>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {filtered.length} session{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            {sessions.length === 0
              ? 'No chat sessions yet. Start a conversation on the Invoke Agent page.'
              : 'No sessions match the current filter.'}
          </div>
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
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={s.title}
                  >
                    {s.title ?? <span style={{ color: 'var(--color-text-tertiary)' }}>untitled</span>}
                  </TableTd>
                  <TableTd>
                    {s.agentName ? (
                      <Chip tone="neutral" size="xs">
                        {s.agentName.replace('orgiq-', '')}
                      </Chip>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>—</span>
                    )}
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      fontFamily: 'monospace',
                    }}
                  >
                    {s.actorId ?? '—'}
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {new Date(s.createdAt).toLocaleString()}
                  </TableTd>
                  <TableTd
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : '—'}
                  </TableTd>
                  <TableTd style={{ fontSize: 12 }}>{s.messageCount ?? '—'}</TableTd>
                  <TableTd
                    style={{
                      fontSize: 10,
                      fontFamily: 'monospace',
                      color: 'var(--color-text-tertiary)',
                    }}
                    title={s.sessionId}
                  >
                    {s.sessionId.slice(0, 12)}…
                  </TableTd>
                  <TableTd>
                    <Link
                      to={`/invoke?session=${encodeURIComponent(s.sessionId)}`}
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        background: 'none',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-secondary)',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        textDecoration: 'none',
                      }}
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
    </div>
  );
}

export default SessionsPage;
