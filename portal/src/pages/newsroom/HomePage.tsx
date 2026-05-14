// TODO(N2): wire post-merge —
//   1. portal/src/App.tsx: lazy import NewsroomLayout + HomePage. Add
//      <Route path="newsroom" element={<Page element={<NewsroomLayout />} />}>
//        <Route index element={<Navigate to="home" replace />} />
//        <Route path="home" element={<Page element={<HomePage />} />} />
//        // articles, beats, briefs, pitches sub-routes added by N3/N4/N6/N8 agents
//      </Route>
//   2. portal/src/components/shell/Layout.tsx: NAV_ITEMS insert
//      { path: '/newsroom', label: 'Newsroom' } before Observability.
//   3. portal/src/components/shell/CommandPalette.tsx: add { label: 'Newsroom', hint: 'Articles, beats, briefs', path: '/newsroom' } to PAGES.

import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { Card, PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ── API response types ────────────────────────────────────────────────────────
// These endpoints are created by N3/N4/N6/N8 agents. Until they land, all
// fetches will 404 and the page will gracefully show empty-state hints.

interface TodayResponse {
  total: number;
  sections: Array<{ name: string; count: number }>;
}

interface BeatsTopResponse {
  beats: Array<{ name: string; count: number }>;
}

interface ClustersResponse {
  total: number;
  active: Array<{ id: string; headline: string; size: number }>;
}

interface PitchesResponse {
  total: number;
  open: Array<{ id: string; headline: string; createdAt: string }>;
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function StatNumber({ value }: { value: number | null }) {
  if (value === null) {
    return <span style={emptyStatStyle}>—</span>;
  }
  return <span style={statStyle}>{value}</span>;
}

function ViewAllLink({ to }: { to: string }) {
  return (
    <Link to={to} style={viewAllStyle}>
      View all →
    </Link>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div style={emptyHintStyle}>{text}</div>
  );
}

// ── Card 1: Today ─────────────────────────────────────────────────────────────

function TodayCard() {
  const { data, error } = useFetch<TodayResponse>('/api/newsroom/articles/today', 60_000);

  const isEmpty = error !== null || data === null;
  const sections = data?.sections ?? [];

  return (
    <Card padding="md" style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={cardTitleStyle}>Today</span>
        <ViewAllLink to="articles" />
      </div>
      <StatNumber value={isEmpty ? null : data.total} />
      <div style={cardDetailStyle}>articles published today</div>
      {isEmpty ? (
        <EmptyHint text="No articles loaded yet — extend the ingest pipeline" />
      ) : sections.length > 0 ? (
        <ul style={listStyle}>
          {sections.slice(0, 4).map((s) => (
            <li key={s.name} style={listItemStyle}>
              <span style={listLabelStyle}>{s.name}</span>
              <span style={listCountStyle}>{s.count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="No section breakdown available" />
      )}
    </Card>
  );
}

// ── Card 2: Active beats ──────────────────────────────────────────────────────

function BeatsCard() {
  const { data, error } = useFetch<BeatsTopResponse>('/api/newsroom/beats/top', 60_000);

  const isEmpty = error !== null || data === null;
  const beats = data?.beats ?? [];

  return (
    <Card padding="md" style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={cardTitleStyle}>Active beats</span>
        <ViewAllLink to="beats" />
      </div>
      <StatNumber value={isEmpty ? null : beats.length} />
      <div style={cardDetailStyle}>top beats this week</div>
      {isEmpty ? (
        <EmptyHint text="No beat data yet — beat coverage added by N4" />
      ) : beats.length > 0 ? (
        <ul style={listStyle}>
          {beats.slice(0, 5).map((b) => (
            <li key={b.name} style={listItemStyle}>
              <span style={listLabelStyle}>{b.name}</span>
              <span style={listCountStyle}>{b.count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="No active beats this week" />
      )}
    </Card>
  );
}

// ── Card 3: Story clusters ────────────────────────────────────────────────────

function ClustersCard() {
  const { data, error } = useFetch<ClustersResponse>(
    '/api/newsroom/clusters?status=active',
    60_000,
  );

  const isEmpty = error !== null || data === null;
  const clusters = data?.active ?? [];

  return (
    <Card padding="md" style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={cardTitleStyle}>Story clusters</span>
        <ViewAllLink to="articles" />
      </div>
      <StatNumber value={isEmpty ? null : data.total} />
      <div style={cardDetailStyle}>active clusters</div>
      {isEmpty ? (
        <EmptyHint text="No cluster data yet — clusters built by N3" />
      ) : clusters.length > 0 ? (
        <ul style={listStyle}>
          {clusters.slice(0, 3).map((c) => (
            <li key={c.id} style={listItemStyle}>
              <span style={listLabelStyle}>{c.headline}</span>
              <span style={listCountStyle}>{c.size}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="No active clusters right now" />
      )}
    </Card>
  );
}

// ── Card 4: Open pitches ──────────────────────────────────────────────────────

function PitchesCard() {
  const { data, error } = useFetch<PitchesResponse>(
    '/api/newsroom/pitches?status=open',
    60_000,
  );

  const isEmpty = error !== null || data === null;
  const pitches = data?.open ?? [];

  return (
    <Card padding="md" style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={cardTitleStyle}>Open pitches</span>
        <ViewAllLink to="pitches" />
      </div>
      <StatNumber value={isEmpty ? null : data.total} />
      <div style={cardDetailStyle}>open pitches</div>
      {isEmpty ? (
        <EmptyHint text="No pitches yet — story backlog added by N8" />
      ) : pitches.length > 0 ? (
        <ul style={listStyle}>
          {pitches.slice(0, 3).map((p) => (
            <li key={p.id} style={listItemStyle}>
              <span style={listLabelStyle}>{p.headline}</span>
              <span style={listCountStyle}>
                {new Date(p.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="No open pitches right now" />
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function HomePage() {
  return (
    <PageSection title="Newsroom">
      <div style={gridStyle}>
        <TodayCard />
        <BeatsCard />
        <ClustersCard />
        <PitchesCard />
      </div>
    </PageSection>
  );
}

export default HomePage;

// ── Styles ────────────────────────────────────────────────────────────────────

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 16,
};

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 4,
};

const cardTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const statStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: 'var(--color-text-primary)',
  lineHeight: 1.1,
};

const emptyStatStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  lineHeight: 1.1,
};

const cardDetailStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  marginBottom: 8,
};

const emptyHintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
  marginTop: 8,
};

const viewAllStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-primary)',
  textDecoration: 'none',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const listItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const listLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
};

const listCountStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  flexShrink: 0,
};
