// TODO(N3): wire post-merge —
//   1. middleware/src/index.ts: import + mount newsroomArticlesRouter at /api/newsroom (ungated).
//   2. portal/src/App.tsx: under <Route path="newsroom">, add child routes:
//      <Route path="articles" element={<Page element={<ArticlesPage />} />} />
//      <Route path="articles/:id" element={<Page element={<ArticleDetailPage />} />} />
//      <Route path="entities/:id" element={<Page element={<EntityDetailPage />} />} />
//   3. Also wire N4's beats route and N6/N8's briefs/pitches when those land.

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArticleSummary {
  id: string;
  headline: string | null;
  section: string | null;
  status: string | null;
  publishedAt: string | null;
  byline: { id: string; name: string } | null;
  wordCount: number | null;
  entityCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Status color map ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  published: { bg: '#dcfce7', text: '#166534' },
  draft:     { bg: '#fef9c3', text: '#854d0e' },
  archived:  { bg: '#f3f4f6', text: '#6b7280' },
  review:    { bg: '#dbeafe', text: '#1e40af' },
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
        fontSize: 11,
        fontWeight: 600,
        background: colors.bg,
        color: colors.text,
        textTransform: 'capitalize',
        letterSpacing: '0.01em',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 14px',
        borderRadius: 9999,
        border: `1px solid ${active ? 'var(--color-primary, #6366f1)' : 'var(--color-border, #e5e7eb)'}`,
        background: active ? 'var(--color-primary, #6366f1)' : 'var(--color-surface, #fff)',
        color: active ? '#fff' : 'var(--color-text-secondary, #6b7280)',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {label}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const SECTION_OPTIONS = ['All', 'Tech', 'Business', 'Science', 'Politics', 'Culture'];
const STATUS_OPTIONS = ['All', 'published', 'draft', 'review', 'archived'];

function ArticlesPage() {
  const [sectionFilter, setSectionFilter] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<string>('All');

  const params = new URLSearchParams({ limit: '100' });
  if (sectionFilter !== 'All') params.set('beat', sectionFilter);

  const { data, isLoading, error } = useFetch<ArticleSummary[]>(
    `/api/newsroom/articles?${params.toString()}`,
    30_000,
  );

  const articles = (data ?? []).filter(
    (a) => statusFilter === 'All' || a.status === statusFilter,
  );

  return (
    <div style={{ padding: '24px 32px' }}>
    <PageSection title="Articles">
      {/* Filter row */}
      <div style={filterRowStyle}>
        <div style={filterGroupStyle}>
          <span style={filterLabelStyle}>Section</span>
          {SECTION_OPTIONS.map((s) => (
            <FilterChip
              key={s}
              label={s}
              active={sectionFilter === s}
              onClick={() => setSectionFilter(s)}
            />
          ))}
        </div>
        <div style={filterGroupStyle}>
          <span style={filterLabelStyle}>Status</span>
          {STATUS_OPTIONS.map((s) => (
            <FilterChip
              key={s}
              label={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            />
          ))}
        </div>
      </div>

      {/* Content */}
      {isLoading && (
        <div style={emptyStyle}>Loading articles...</div>
      )}

      {!isLoading && error && (
        <Card padding="md">
          <div style={{ color: 'var(--color-error, #dc2626)', fontSize: 13 }}>
            Failed to load articles. Backend endpoint may not be mounted yet.
          </div>
        </Card>
      )}

      {!isLoading && !error && articles.length === 0 && (
        <Card padding="md">
          <div style={emptyStyle}>
            No articles found. Ingest pipeline or schema may not be set up yet.
          </div>
        </Card>
      )}

      {!isLoading && !error && articles.length > 0 && (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRowStyle}>
                {['Headline', 'Section', 'Status', 'Byline', 'Published', 'Words', 'Entities'].map(
                  (col) => (
                    <th
                      key={col}
                      style={{
                        ...thStyle,
                        textAlign:
                          col === 'Words' || col === 'Entities' ? 'right' : 'left',
                      }}
                    >
                      {col}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {articles.map((a, idx) => (
                <tr
                  key={a.id}
                  style={{
                    borderBottom:
                      idx < articles.length - 1
                        ? '1px solid var(--color-border, #e5e7eb)'
                        : 'none',
                  }}
                >
                  <td style={tdStyle}>
                    <Link
                      to={`/newsroom/articles/${encodeURIComponent(a.id)}`}
                      style={headlineLinkStyle}
                    >
                      {a.headline ?? '(untitled)'}
                    </Link>
                  </td>
                  <td style={{ ...tdStyle, ...metaCellStyle }}>{a.section ?? '—'}</td>
                  <td style={{ ...tdStyle, ...metaCellStyle }}>
                    <StatusChip status={a.status} />
                  </td>
                  <td style={{ ...tdStyle, ...metaCellStyle }}>
                    {a.byline ? (
                      <span style={{ fontSize: 13, color: 'var(--color-text-secondary, #6b7280)' }}>
                        {a.byline.name}
                      </span>
                    ) : (
                      <span style={{ fontSize: 13, color: 'var(--color-text-tertiary, #9ca3af)' }}>
                        —
                      </span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, ...metaCellStyle }}>{formatDate(a.publishedAt)}</td>
                  <td style={{ ...tdStyle, ...metaCellStyle, textAlign: 'right' }}>
                    {a.wordCount != null ? a.wordCount.toLocaleString() : '—'}
                  </td>
                  <td style={{ ...tdStyle, ...metaCellStyle, textAlign: 'right' }}>
                    {a.entityCount > 0 ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: 24,
                          height: 20,
                          borderRadius: 10,
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '0 6px',
                          background: 'var(--color-accent-subtle, #eff6ff)',
                          color: 'var(--color-accent, #2563eb)',
                        }}
                      >
                        {a.entityCount}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)' }}>
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
    </div>
  );
}

export default ArticlesPage;

// ─── Styles ───────────────────────────────────────────────────────────────────

const filterRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginBottom: 20,
};

const filterGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const filterLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  minWidth: 52,
};

const tableWrapStyle: CSSProperties = {
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: 10,
  overflow: 'hidden',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const theadRowStyle: CSSProperties = {
  background: 'var(--color-surface-raised, #f9fafb)',
  borderBottom: '1px solid var(--color-border, #e5e7eb)',
};

const thStyle: CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

const tdStyle: CSSProperties = {
  padding: '12px 16px',
  verticalAlign: 'middle',
};

const metaCellStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #6b7280)',
  whiteSpace: 'nowrap',
};

const headlineLinkStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--color-text, #111827)',
  textDecoration: 'none',
};

const emptyStyle: CSSProperties = {
  padding: 24,
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontSize: 13,
  fontStyle: 'italic',
};
