import { useParams, Link } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

interface ProjectDetail {
  id: string;
  name: string;
  status: string | null;
  createdAt: string | null;
  contributors: Array<{
    personId: string;
    name: string;
    title: string | null;
    role: string | null;
    weight: number;
  }>;
}

// ─── Status chip ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  active: { bg: '#dcfce7', text: '#166534' },
  archived: { bg: '#f3f4f6', text: '#6b7280' },
  planning: { bg: '#dbeafe', text: '#1e40af' },
};

function StatusChip({ status }: { status: string | null }) {
  const label = status ?? 'unknown';
  const colors = STATUS_COLORS[label.toLowerCase()] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 12px',
        borderRadius: 9999,
        fontSize: 13,
        fontWeight: 600,
        background: colors.bg,
        color: colors.text,
        textTransform: 'capitalize',
        letterSpacing: '0.01em',
      }}
    >
      {label}
    </span>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useFetch<ProjectDetail>(
    id ? `/api/graph/projects/${encodeURIComponent(id)}` : '',
  );

  const backLink = (
    <Link
      to="/iq/projects"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 13,
        color: 'var(--color-text-secondary, #6b7280)',
        textDecoration: 'none',
        marginBottom: 20,
      }}
    >
      &larr; Back to Projects
    </Link>
  );

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-tertiary, #9ca3af)' }}>
        Loading project...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        {backLink}
        <div style={{ color: 'var(--color-error, #dc2626)' }}>
          Failed to load project: {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 24 }}>
        {backLink}
        <div style={{ color: 'var(--color-text-tertiary, #9ca3af)' }}>
          Project not found.
        </div>
      </div>
    );
  }

  return (
    <PageSection title={data.name}>
      {backLink}

      {/* Header card */}
      <div
        style={{
          background: 'var(--color-surface, #fff)',
          border: '1px solid var(--color-border, #e5e7eb)',
          borderRadius: 10,
          padding: '20px 24px',
          marginBottom: 24,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 24,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, marginBottom: 8 }}>
            {data.name}
          </h2>
          <StatusChip status={data.status} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 160 }}>
          {data.createdAt && (
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #6b7280)' }}>
              <span style={{ fontWeight: 500 }}>Created:</span>{' '}
              {new Date(data.createdAt).toLocaleDateString()}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #6b7280)' }}>
            <span style={{ fontWeight: 500 }}>Contributors:</span>{' '}
            {data.contributors.length}
          </div>
        </div>
      </div>

      {/* Contributors table */}
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Contributors</h3>

      {data.contributors.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--color-text-tertiary, #9ca3af)' }}>
          No contributors recorded for this project.
        </div>
      ) : (
        <div
          style={{
            background: 'var(--color-surface, #fff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr
                style={{
                  background: 'var(--color-surface-raised, #f9fafb)',
                  borderBottom: '1px solid var(--color-border, #e5e7eb)',
                }}
              >
                {['Name', 'Title', 'Role', 'Weight'].map((col) => (
                  <th
                    key={col}
                    style={{
                      padding: '10px 16px',
                      textAlign: col === 'Weight' ? 'right' : 'left',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--color-text-secondary, #6b7280)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.contributors.map((c, idx) => (
                <tr
                  key={c.personId}
                  style={{
                    borderBottom:
                      idx < data.contributors.length - 1
                        ? '1px solid var(--color-border, #e5e7eb)'
                        : 'none',
                  }}
                >
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: 'var(--color-text, #111827)',
                      }}
                    >
                      {c.name}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      fontSize: 13,
                      color: 'var(--color-text-secondary, #6b7280)',
                    }}
                  >
                    {c.title ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      fontSize: 13,
                      color: 'var(--color-text-secondary, #6b7280)',
                    }}
                  >
                    {c.role ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      textAlign: 'right',
                    }}
                  >
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          width: 60,
                          height: 6,
                          borderRadius: 3,
                          background: 'var(--color-border, #e5e7eb)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(c.weight * 100, 100)}%`,
                            height: '100%',
                            background: 'var(--color-primary, #6366f1)',
                            borderRadius: 3,
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: 'var(--color-text-secondary, #6b7280)',
                          minWidth: 36,
                          textAlign: 'right',
                        }}
                      >
                        {(c.weight * 100).toFixed(0)}%
                      </span>
                    </div>
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

export default ProjectDetailPage;
