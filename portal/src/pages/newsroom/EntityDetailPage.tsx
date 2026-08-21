// One entity in depth — where it appears and what it co-occurs with.

import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EntityDetail {
  id: string;
  name: string;
  entityType: string;
  aliases: string[];
  appearances: Array<{
    articleId: string;
    headline: string | null;
    publishedAt: string | null;
    salience: number;
  }>;
  coMentions: Array<{
    entityId: string;
    entityName: string;
    entityType: string;
    sharedArticleCount: number;
  }>;
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

// ─── Entity type chip ─────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  person:       { bg: '#ede9fe', text: 'var(--color-optimize-hover)' },
  organization: { bg: '#dbeafe', text: '#1e40af' },
  location:     { bg: '#dcfce7', text: '#166534' },
  product:      { bg: '#fef9c3', text: '#854d0e' },
  event:        { bg: '#fce7f3', text: '#9d174d' },
};

function TypeChip({ entityType }: { entityType: string }) {
  const label = entityType ?? 'unknown';
  const colors = TYPE_COLORS[label.toLowerCase()] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 14px',
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

// ─── Salience bar ─────────────────────────────────────────────────────────────

function SalienceBar({ value }: { value: number }) {
  const pct = Math.min(Math.max(value, 0), 1) * 100;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <div
        style={{
          width: 48,
          height: 5,
          borderRadius: 3,
          background: 'var(--color-border, #e5e7eb)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--color-primary, #6366f1)',
            borderRadius: 3,
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary, #9ca3af)' }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function EntityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useFetch<EntityDetail>(
    id ? `/api/newsroom/entities/${encodeURIComponent(id)}` : '',
  );

  const backLink = (
    <Link to="/newsroom/articles" style={backLinkStyle}>
      &larr; Back to Articles
    </Link>
  );

  if (isLoading) {
    return <div style={loadingStyle}>Loading entity...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        {backLink}
        <div style={{ color: 'var(--color-error, #dc2626)', fontSize: 13 }}>
          Failed to load entity. Backend endpoint may not be mounted yet.
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 24 }}>
        {backLink}
        <div style={{ color: 'var(--color-text-tertiary, #9ca3af)', fontSize: 13 }}>
          Entity not found.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px' }}>
    <PageSection title={data.name}>
      {backLink}

      {/* Entity header */}
      <div style={headerCardStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={nameStyle}>{data.name}</h1>
            <TypeChip entityType={data.entityType} />
            {data.aliases.length > 0 && (
              <div style={aliasesStyle}>
                Also known as: {data.aliases.join(', ')}
              </div>
            )}
          </div>
          <div style={statsBoxStyle}>
            <div style={statItemStyle}>
              <span style={statValueStyle}>{data.appearances.length}</span>
              <span style={statLabelStyle}>appearances</span>
            </div>
            <div style={statItemStyle}>
              <span style={statValueStyle}>{data.coMentions.length}</span>
              <span style={statLabelStyle}>co-mentions</span>
            </div>
          </div>
        </div>
      </div>

      {/* Two-column layout: appearances + co-mentions */}
      <div style={twoColStyle}>
        {/* Appearances table */}
        <div>
          <h2 style={sectionHeadStyle}>Appearances</h2>
          {data.appearances.length === 0 ? (
            <div style={emptyStyle}>No appearances recorded yet.</div>
          ) : (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr style={theadRowStyle}>
                    {['Article', 'Published', 'Salience'].map((col) => (
                      <th
                        key={col}
                        style={{
                          ...thStyle,
                          textAlign: col === 'Salience' ? 'right' : 'left',
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.appearances.map((app, idx) => (
                    <tr
                      key={app.articleId}
                      style={{
                        borderBottom:
                          idx < data.appearances.length - 1
                            ? '1px solid var(--color-border, #e5e7eb)'
                            : 'none',
                      }}
                    >
                      <td style={tdStyle}>
                        <Link
                          to={`/newsroom/articles/${encodeURIComponent(app.articleId)}`}
                          style={articleLinkStyle}
                        >
                          {app.headline ?? '(untitled)'}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, ...metaCellStyle, whiteSpace: 'nowrap' }}>
                        {formatDate(app.publishedAt)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <SalienceBar value={app.salience} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Co-mentions list */}
        <div>
          <h2 style={sectionHeadStyle}>Co-mentioned Entities</h2>
          {data.coMentions.length === 0 ? (
            <div style={emptyStyle}>No co-mentions found.</div>
          ) : (
            <div style={coMentionWrapStyle}>
              {data.coMentions.map((cm) => (
                <Link
                  key={cm.entityId}
                  to={`/newsroom/entities/${encodeURIComponent(cm.entityId)}`}
                  style={coMentionItemStyle}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={coMentionNameStyle}>{cm.entityName}</div>
                    <div style={coMentionTypeStyle}>{cm.entityType}</div>
                  </div>
                  <span style={coMentionCountStyle}>{cm.sharedArticleCount}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </PageSection>
    </div>
  );
}

export default EntityDetailPage;

// ─── Styles ───────────────────────────────────────────────────────────────────

const backLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 13,
  color: 'var(--color-text-secondary, #6b7280)',
  textDecoration: 'none',
  marginBottom: 20,
};

const loadingStyle: CSSProperties = {
  padding: 24,
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontSize: 13,
};

const headerCardStyle: CSSProperties = {
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: 10,
  padding: '24px 28px',
  marginBottom: 28,
};

const nameStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  margin: 0,
  marginBottom: 10,
  color: 'var(--color-text, #111827)',
};

const aliasesStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontStyle: 'italic',
};

const statsBoxStyle: CSSProperties = {
  display: 'flex',
  gap: 24,
  flexShrink: 0,
};

const statItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
};

const statValueStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  color: 'var(--color-text, #111827)',
  lineHeight: 1.1,
};

const statLabelStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #9ca3af)',
};

const twoColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 280px',
  gap: 28,
  alignItems: 'start',
};

const sectionHeadStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: 0,
  marginBottom: 12,
};

const emptyStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontStyle: 'italic',
  padding: '16px 0',
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
};

const articleLinkStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--color-text, #111827)',
  textDecoration: 'none',
};

const coMentionWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: 10,
  overflow: 'hidden',
};

const coMentionItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 16px',
  textDecoration: 'none',
  borderBottom: '1px solid var(--color-border, #e5e7eb)',
  transition: 'background 0.1s',
};

const coMentionNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--color-text, #111827)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const coMentionTypeStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #9ca3af)',
  textTransform: 'capitalize',
};

const coMentionCountStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  flexShrink: 0,
};
