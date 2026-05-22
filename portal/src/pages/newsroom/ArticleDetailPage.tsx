// TODO(N3): wire post-merge —
//   1. portal/src/App.tsx: under <Route path="newsroom">, add:
//      <Route path="articles/:id" element={<Page element={<ArticleDetailPage />} />} />

import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useReactions } from '@connorhoehn/realtime-modules/client';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArticleDetail {
  id: string;
  headline: string | null;
  subheadline: string | null;
  section: string | null;
  status: string | null;
  publishedAt: string | null;
  byline: { id: string; name: string } | null;
  wordCount: number | null;
  entityCount: number;
  body: string | null;
  entities: Array<{
    id: string;
    name: string;
    entityType: string;
    salience: number;
    role: string | null;
  }>;
  sources: Array<{
    id: string;
    entityName: string | null;
    sourceType: string;
    attribution: string | null;
    quoteSnippet: string | null;
  }>;
  cluster: { id: string; title: string } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Status chip ──────────────────────────────────────────────────────────────

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
    <span style={{ display: 'inline-block', padding: '3px 12px', borderRadius: 9999, fontSize: 12, fontWeight: 600, background: colors.bg, color: colors.text, textTransform: 'capitalize' }}>
      {label}
    </span>
  );
}

// ─── Entity chip (links to entity detail) ────────────────────────────────────

function EntityChip({
  entity,
}: {
  entity: ArticleDetail['entities'][number];
}) {
  const salienceOpacity = 0.4 + entity.salience * 0.6;
  return (
    <Link
      to={`/newsroom/entities/${encodeURIComponent(entity.id)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        borderRadius: 9999,
        border: '1px solid var(--color-border, #e5e7eb)',
        background: 'var(--color-surface, #fff)',
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--color-text, #111827)',
        textDecoration: 'none',
        opacity: salienceOpacity,
        transition: 'opacity 0.15s',
      }}
    >
      <span style={{ color: 'var(--color-text-tertiary, #9ca3af)', fontSize: 10 }}>
        {entity.entityType}
      </span>
      {entity.name}
    </Link>
  );
}

// ─── Sidebar section wrapper ──────────────────────────────────────────────────

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-surface, #fff)',
        border: '1px solid var(--color-border, #e5e7eb)',
        borderRadius: 10,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--color-text-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

// ─── Article reactions (Phase 2.3) ───────────────────────────────────────────
//
// useReactions('newsroom-articles', { targetId: articleId }) filters the shared
// channel stream to reactions for this specific article only (v0.7.6+).
// react(emoji) inherits the hook-level targetId automatically.

const REACTION_EMOJIS = ['👍', '❤️', '🎉', '🔥', '💡'] as const;

function ArticleReactions({ articleId }: { articleId: string }) {
  const { reactions, react } = useReactions('newsroom-articles', { targetId: articleId });

  return (
    <div style={reactionsRowStyle}>
      {REACTION_EMOJIS.map((emoji) => {
        const count = reactions.filter((r) => r.emoji === emoji).length;
        return (
          <button
            key={emoji}
            onClick={() => react(emoji)}
            style={{
              ...reactionBtnStyle,
              background: count > 0 ? 'var(--color-accent-muted, #eff6ff)' : 'var(--color-surface, #fff)',
              borderColor: count > 0 ? 'var(--color-accent, #3b82f6)' : 'var(--color-border, #e5e7eb)',
            }}
            title={`React with ${emoji}`}
          >
            {emoji}
            {count > 0 && (
              <span style={reactionCountStyle}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ArticleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useFetch<ArticleDetail>(
    id ? `/api/newsroom/articles/${encodeURIComponent(id)}` : '',
  );

  const backLink = (
    <Link to="/newsroom/articles" style={backLinkStyle}>
      &larr; Back to Articles
    </Link>
  );

  if (isLoading) {
    return <div style={loadingStyle}>Loading article...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        {backLink}
        <div style={{ color: 'var(--color-error, #dc2626)', fontSize: 13 }}>
          Failed to load article. Backend endpoint may not be mounted yet.
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 24 }}>
        {backLink}
        <div style={{ color: 'var(--color-text-tertiary, #9ca3af)', fontSize: 13 }}>
          Article not found.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px' }}>
    <PageSection title={data.headline ?? 'Article'}>
      {backLink}

      {/* Article header */}
      <div style={headerCardStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <StatusChip status={data.status} />
          {data.section && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)', alignSelf: 'center' }}>
              {data.section}
            </span>
          )}
          {data.cluster && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)', alignSelf: 'center' }}>
              Cluster: {data.cluster.title}
            </span>
          )}
        </div>

        <h1 style={headlineStyle}>{data.headline ?? '(untitled)'}</h1>

        {data.subheadline && (
          <p style={subheadlineStyle}>{data.subheadline}</p>
        )}

        <div style={bylineRowStyle}>
          {data.byline && (
            <span style={bylineStyle}>By {data.byline.name}</span>
          )}
          <span style={publishedStyle}>{formatDate(data.publishedAt)}</span>
          {data.wordCount != null && (
            <span style={wordCountStyle}>{data.wordCount.toLocaleString()} words</span>
          )}
        </div>

        {/* Reactions — wired to newsroom-articles channel, filtered by articleId */}
        <ArticleReactions articleId={data.id} />
      </div>

      {/* Two-column layout: body + sidebars */}
      <div style={twoColStyle}>
        {/* Main: body */}
        <div style={bodyColStyle}>
          {data.body ? (
            <div style={bodyTextStyle}>{data.body}</div>
          ) : (
            <div style={emptyBodyStyle}>
              Article body not available. Full content ingestion not yet configured.
            </div>
          )}
        </div>

        {/* Sidebars */}
        <div style={sidebarColStyle}>
          {/* Entities sidebar */}
          <SidebarSection title={`Entities (${data.entities.length})`}>
            {data.entities.length === 0 ? (
              <div style={emptySidebarStyle}>No entities extracted yet.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {data.entities.map((e) => (
                  <EntityChip key={e.id} entity={e} />
                ))}
              </div>
            )}
          </SidebarSection>

          {/* Sources sidebar */}
          <SidebarSection title={`Sources (${data.sources.length})`}>
            {data.sources.length === 0 ? (
              <div style={emptySidebarStyle}>No sources recorded.</div>
            ) : (
              <ul style={sourceListStyle}>
                {data.sources.map((s) => (
                  <li key={s.id} style={sourceItemStyle}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={sourceTypeStyle}>{s.sourceType}</span>
                      {s.entityName && (
                        <span style={sourceNameStyle}>{s.entityName}</span>
                      )}
                    </div>
                    {s.attribution && (
                      <div style={attributionStyle}>{s.attribution}</div>
                    )}
                    {s.quoteSnippet && (
                      <blockquote style={quoteStyle}>"{s.quoteSnippet}"</blockquote>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SidebarSection>
        </div>
      </div>
    </PageSection>
    </div>
  );
}

export default ArticleDetailPage;

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
  marginBottom: 24,
};

const headlineStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  lineHeight: 1.3,
  margin: 0,
  marginBottom: 8,
  color: 'var(--color-text, #111827)',
};

const subheadlineStyle: CSSProperties = {
  fontSize: 16,
  color: 'var(--color-text-secondary, #6b7280)',
  lineHeight: 1.5,
  margin: 0,
  marginBottom: 12,
};

const bylineRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  flexWrap: 'wrap',
  marginTop: 8,
};

const bylineStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--color-text, #111827)',
};

const publishedStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #6b7280)',
};

const wordCountStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary, #9ca3af)',
};

const twoColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 320px',
  gap: 24,
  alignItems: 'start',
};

const bodyColStyle: CSSProperties = {
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: 10,
  padding: '24px 28px',
  minHeight: 200,
};

const bodyTextStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: 'var(--color-text, #111827)',
  whiteSpace: 'pre-wrap',
};

const emptyBodyStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontStyle: 'italic',
};

const sidebarColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const emptySidebarStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontStyle: 'italic',
};

const sourceListStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const sourceItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const sourceTypeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--color-text-tertiary, #9ca3af)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const sourceNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--color-text, #111827)',
};

const attributionStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary, #6b7280)',
};

const quoteStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary, #6b7280)',
  fontStyle: 'italic',
  borderLeft: '3px solid var(--color-border, #e5e7eb)',
  paddingLeft: 10,
  margin: '4px 0 0',
};

// ─── Reaction styles ─────────────────────────────────────────────────────────

const reactionsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 14,
  flexWrap: 'wrap',
};

const reactionBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 10px',
  borderRadius: 9999,
  border: '1px solid var(--color-border, #e5e7eb)',
  background: 'var(--color-surface, #fff)',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  transition: 'background 0.12s, border-color 0.12s',
};

const reactionCountStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-accent, #3b82f6)',
  lineHeight: 1,
};
