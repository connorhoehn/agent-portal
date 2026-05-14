// TODO(D2): wire post-merge —
//   1. middleware/src/index.ts: mount projectsRouter at /api/graph/projects BEFORE gated graph router.
//   2. portal/src/App.tsx: lazy ProjectsPage + ProjectDetailPage; add /projects and /projects/:id.
//   3. portal/src/components/shell/Layout.tsx: NAV_ITEMS insert { path: '/projects', label: 'Projects' } after Scores.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

interface ProjectSummary {
  id: string;
  name: string;
  status: string | null;
  contributorCount: number;
  createdAt: string | null;
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
        padding: '2px 10px',
        borderRadius: 9999,
        fontSize: 12,
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

// ─── Filter chips ─────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['all', 'active', 'planning', 'archived'];

function FilterChips({
  selected,
  onChange,
}: {
  selected: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
      {STATUS_OPTIONS.map((s) => {
        const active = selected === s;
        return (
          <button
            key={s}
            onClick={() => onChange(s)}
            style={{
              padding: '4px 14px',
              borderRadius: 9999,
              border: active
                ? '2px solid var(--color-primary, #6366f1)'
                : '2px solid var(--color-border, #e5e7eb)',
              background: active ? 'var(--color-primary, #6366f1)' : 'transparent',
              color: active ? '#fff' : 'var(--color-text-secondary, #6b7280)',
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
              textTransform: 'capitalize',
              transition: 'all 0.15s',
            }}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function ProjectsPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useFetch<ProjectSummary[]>(
    '/api/graph/projects?limit=100',
  );
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    if (statusFilter === 'all') return data;
    return data.filter((p) => (p.status ?? '').toLowerCase() === statusFilter);
  }, [data, statusFilter]);

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-tertiary, #9ca3af)' }}>
        Loading projects...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--color-error, #dc2626)' }}>
        Failed to load projects: {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No projects yet</h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary, #6b7280)', lineHeight: 1.6 }}>
          Run <code>python schema/seed.py</code> to populate Aurora with project data,
          or ingest documents via the Ingest page to build the knowledge graph.
        </p>
      </div>
    );
  }

  return (
    <PageSection title="Projects">
      <FilterChips selected={statusFilter} onChange={setStatusFilter} />

      {filtered.length === 0 ? (
        <div style={{ padding: 32, color: 'var(--color-text-tertiary, #9ca3af)', textAlign: 'center' }}>
          No projects match the selected filter.
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
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-secondary, #6b7280)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Project
                </th>
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-secondary, #6b7280)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Status
                </th>
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'right',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-secondary, #6b7280)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Contributors
                </th>
                <th
                  style={{
                    padding: '10px 16px',
                    textAlign: 'right',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--color-text-secondary, #6b7280)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((project, idx) => (
                <tr
                  key={project.id}
                  style={{
                    borderBottom:
                      idx < filtered.length - 1
                        ? '1px solid var(--color-border, #e5e7eb)'
                        : 'none',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      'var(--color-surface-raised, #f9fafb)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
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
                      {project.name}
                    </span>
                    {project.createdAt && (
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--color-text-tertiary, #9ca3af)',
                          marginTop: 2,
                        }}
                      >
                        {new Date(project.createdAt).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <StatusChip status={project.status} />
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      textAlign: 'right',
                      fontSize: 14,
                      color: 'var(--color-text-secondary, #6b7280)',
                    }}
                  >
                    {project.contributorCount}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <button
                      onClick={() => navigate(`/projects/${project.id}`)}
                      style={{
                        padding: '4px 12px',
                        borderRadius: 6,
                        border: '1px solid var(--color-border, #e5e7eb)',
                        background: 'transparent',
                        color: 'var(--color-primary, #6366f1)',
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: 'pointer',
                        transition: 'background 0.1s',
                      }}
                    >
                      Open
                    </button>
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

export default ProjectsPage;
