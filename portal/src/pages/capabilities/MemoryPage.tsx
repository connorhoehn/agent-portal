import { Link } from 'react-router';
import { Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: string;
  title?: string;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function MemoryPage() {
  const { data, error } = useFetch<{ sessions: SessionSummary[] }>('/api/sessions', 15000);
  const sessions = data?.sessions ?? [];
  const recent = sessions.slice(0, 20);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Memory</h1>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            AgentCore Memory session store. Each conversation in the Invoke page persists here as an event stream,
            keyed by{' '}
            <code style={{ fontSize: 11, padding: '1px 4px', background: 'var(--color-surface-hover)', borderRadius: 3 }}>
              MEMORY_ID
            </code>
            .
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          <Card padding="md">
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Total Sessions</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
              {data ? sessions.length : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
              for actor <code style={{ fontSize: 11 }}>portal-default</code>
            </div>
          </Card>
          <Card padding="md">
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Most Recent</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>
              {recent[0]
                ? new Date(recent[0].createdAt).toLocaleString()
                : '—'}
            </div>
            <Link
              to="/invoke"
              style={{
                display: 'inline-block',
                marginTop: 6,
                fontSize: 12,
                color: 'var(--color-primary)',
                textDecoration: 'none',
              }}
            >
              Open Invoke →
            </Link>
          </Card>
        </div>

        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              Recent Sessions{' '}
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
                newest first · top 20
              </span>
            </h2>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {sessions.length} total
            </span>
          </div>

          {!data && !error ? (
            <EmptyState>Loading memory sessions…</EmptyState>
          ) : recent.length === 0 ? (
            <EmptyState>
              No memory-backed sessions yet. Start a conversation from{' '}
              <Link to="/invoke" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>Invoke</Link>{' '}
              to populate this store.
            </EmptyState>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Created</TableTh>
                  <TableTh>Title</TableTh>
                  <TableTh>Session ID</TableTh>
                  <TableTh>Actor</TableTh>
                  <TableTh></TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {recent.map(s => (
                  <TableRow key={s.sessionId}>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                      {new Date(s.createdAt).toLocaleString()}
                    </TableTd>
                    <TableTd style={{ fontSize: 12, fontWeight: 500 }}>
                      {s.title || <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>(untitled)</span>}
                    </TableTd>
                    <TableTd style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                      {s.sessionId.length > 22 ? s.sessionId.slice(0, 16) + '…' : s.sessionId}
                    </TableTd>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{s.actorId}</TableTd>
                    <TableTd>
                      <Link
                        to="/invoke"
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
    </div>
  );
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
      {children}
    </div>
  );
}

export default MemoryPage;
