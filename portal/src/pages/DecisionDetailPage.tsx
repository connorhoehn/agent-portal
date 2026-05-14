import { useParams, Link } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DecisionParticipant {
  personId: string;
  name: string;
  title: string | null;
  role: string | null;
  weight: number;
}

interface DecisionDetail {
  id: string;
  topic: string;
  summary: string | null;
  decidedAt: string | null;
  participants: DecisionParticipant[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function weightBar(weight: number): React.ReactNode {
  const pct = Math.min(Math.max(weight, 0), 1) * 100;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--color-border, #e5e7eb)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--color-accent, #2563eb)',
            borderRadius: 3,
          }}
        />
      </div>
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary, #6b7280)', minWidth: 32 }}>
        {weight.toFixed(2)}
      </span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function DecisionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useFetch<DecisionDetail>(
    id ? `/api/graph/decisions/${encodeURIComponent(id)}` : '',
  );

  if (!id) {
    return (
      <div style={{ padding: 24, color: 'var(--color-error, #dc2626)' }}>
        Invalid decision ID.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-tertiary, #9ca3af)' }}>
        Loading decision...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--color-error, #dc2626)' }}>
        Failed to load decision: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-secondary, #6b7280)' }}>
        Decision not found.
      </div>
    );
  }

  return (
    <PageSection title="Decision Detail">
      {/* Back link */}
      <div style={{ marginBottom: 20 }}>
        <Link
          to="/decisions"
          style={{
            fontSize: 13,
            color: 'var(--color-accent, #2563eb)',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ← Back to Decisions
        </Link>
      </div>

      {/* Header card */}
      <div
        style={{
          background: 'var(--color-surface, #ffffff)',
          border: '1px solid var(--color-border, #e5e7eb)',
          borderRadius: 10,
          padding: '20px 24px',
          marginBottom: 24,
        }}
      >
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: 'var(--color-text-primary, #111827)',
            margin: '0 0 8px',
            lineHeight: 1.35,
          }}
        >
          {data.topic}
        </h2>

        <div
          style={{
            fontSize: 13,
            color: 'var(--color-text-tertiary, #9ca3af)',
            marginBottom: data.summary ? 16 : 0,
          }}
        >
          Decided on {formatDate(data.decidedAt)}
        </div>

        {data.summary && (
          <p
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary, #6b7280)',
              lineHeight: 1.65,
              margin: 0,
            }}
          >
            {data.summary}
          </p>
        )}
      </div>

      {/* Participants table */}
      <h3
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--color-text-primary, #111827)',
          marginBottom: 12,
        }}
      >
        Participants ({data.participants.length})
      </h3>

      {data.participants.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--color-text-tertiary, #9ca3af)' }}>
          No participants recorded for this decision.
        </p>
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
                {(['Name', 'Title', 'Role', 'Weight'] as const).map((col) => (
                  <th
                    key={col}
                    style={{
                      padding: '10px 16px',
                      textAlign: col === 'Weight' ? 'left' : 'left',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--color-text-tertiary, #9ca3af)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      borderBottom: '1px solid var(--color-border, #e5e7eb)',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr
                  key={p.personId}
                  style={{ borderBottom: '1px solid var(--color-border, #e5e7eb)' }}
                >
                  <td
                    style={{
                      padding: '11px 16px',
                      fontSize: 14,
                      fontWeight: 500,
                      color: 'var(--color-text-primary, #111827)',
                    }}
                  >
                    {p.name}
                  </td>
                  <td
                    style={{
                      padding: '11px 16px',
                      fontSize: 13,
                      color: 'var(--color-text-secondary, #6b7280)',
                    }}
                  >
                    {p.title ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: '11px 16px',
                      fontSize: 13,
                      color: 'var(--color-text-secondary, #6b7280)',
                    }}
                  >
                    {p.role ?? '—'}
                  </td>
                  <td style={{ padding: '11px 16px', minWidth: 140 }}>
                    {weightBar(p.weight)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

export default DecisionDetailPage;
