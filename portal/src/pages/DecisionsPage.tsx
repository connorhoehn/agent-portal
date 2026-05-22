import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DecisionSummary {
  id: string;
  topic: string;
  summary: string | null;
  decidedAt: string | null;
  participantCount: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ─── Chip ─────────────────────────────────────────────────────────────────────

function ParticipantChip({ count }: { count: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 28,
        height: 22,
        borderRadius: 11,
        fontSize: 12,
        fontWeight: 600,
        padding: '0 8px',
        background: 'var(--color-accent-subtle, #eff6ff)',
        color: 'var(--color-accent, #2563eb)',
        border: '1px solid var(--color-accent-border, #bfdbfe)',
      }}
    >
      {count}
    </span>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function DecisionCard({
  decision,
  onOpen,
}: {
  decision: DecisionSummary;
  onOpen: (id: string) => void;
}) {
  return (
    <div
      style={{
        background: 'var(--color-surface, #ffffff)',
        border: '1px solid var(--color-border, #e5e7eb)',
        borderRadius: 10,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--color-text-primary, #111827)',
            lineHeight: 1.4,
            flex: 1,
          }}
        >
          {decision.topic}
        </span>
        <button
          onClick={() => onOpen(decision.id)}
          style={{
            flexShrink: 0,
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-accent, #2563eb)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 0',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          Open
        </button>
      </div>

      {decision.summary && (
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-text-secondary, #6b7280)',
            lineHeight: 1.5,
            margin: 0,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {decision.summary}
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)' }}>
          Decided {formatDate(decision.decidedAt)}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)' }}>Participants</span>
          <ParticipantChip count={decision.participantCount} />
        </div>
      </div>
    </div>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

function DecisionRow({
  decision,
  onOpen,
}: {
  decision: DecisionSummary;
  onOpen: (id: string) => void;
}) {
  return (
    <tr
      style={{
        borderBottom: '1px solid var(--color-border, #e5e7eb)',
      }}
    >
      <td
        style={{
          padding: '12px 16px',
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--color-text-primary, #111827)',
          maxWidth: 360,
        }}
      >
        {decision.topic}
      </td>
      <td
        style={{
          padding: '12px 16px',
          fontSize: 13,
          color: 'var(--color-text-secondary, #6b7280)',
          whiteSpace: 'nowrap',
        }}
      >
        {formatDate(decision.decidedAt)}
      </td>
      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
        <ParticipantChip count={decision.participantCount} />
      </td>
      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
        <button
          onClick={() => onOpen(decision.id)}
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-accent, #2563eb)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 0',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          Open
        </button>
      </td>
    </tr>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

type ViewMode = 'card' | 'table';

function DecisionsPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<ViewMode>('table');
  const { data, isLoading, error } = useFetch<DecisionSummary[]>(
    '/api/graph/decisions?limit=100',
  );

  const handleOpen = (id: string) => {
    void navigate(`/iq/decisions/${encodeURIComponent(id)}`);
  };

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-tertiary, #9ca3af)' }}>
        Loading decisions...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--color-error, #dc2626)' }}>
        Failed to load decisions: {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No decisions yet</h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--color-text-secondary, #6b7280)',
            lineHeight: 1.6,
          }}
        >
          Decisions will appear here once the ingestion agent processes documents
          containing recorded decisions and populates the Aurora <code>decisions</code> table.
        </p>
      </div>
    );
  }

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 13,
    fontWeight: 500,
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid var(--color-border, #e5e7eb)',
    cursor: 'pointer',
    background: active ? 'var(--color-accent, #2563eb)' : 'transparent',
    color: active ? '#ffffff' : 'var(--color-text-secondary, #6b7280)',
  });

  return (
    <PageSection title={`Decisions (${data.length})`}>
      {/* View toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button style={toggleStyle(view === 'table')} onClick={() => setView('table')}>
          Table
        </button>
        <button style={toggleStyle(view === 'card')} onClick={() => setView('card')}>
          Cards
        </button>
      </div>

      {view === 'card' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: 16,
          }}
        >
          {data.map((d) => (
            <DecisionCard key={d.id} decision={d} onOpen={handleOpen} />
          ))}
        </div>
      ) : (
        <div
          style={{
            background: 'var(--color-surface, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-raised, #f9fafb)' }}>
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-tertiary, #9ca3af)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: '1px solid var(--color-border, #e5e7eb)',
                  }}
                >
                  Topic
                </th>
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-tertiary, #9ca3af)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: '1px solid var(--color-border, #e5e7eb)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Decided
                </th>
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-tertiary, #9ca3af)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: '1px solid var(--color-border, #e5e7eb)',
                  }}
                >
                  Participants
                </th>
                <th
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid var(--color-border, #e5e7eb)',
                  }}
                />
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <DecisionRow key={d.id} decision={d} onOpen={handleOpen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

export default DecisionsPage;
