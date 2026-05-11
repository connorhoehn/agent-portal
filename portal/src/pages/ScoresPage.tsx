import { useMemo, useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

interface ScoreEntry {
  personId: string;
  name: string;
  department: string;
  influence: number;
  expertise: number;
  composite: number;
}

interface PersonDetail {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  connections: Array<{
    source: string;
    target: string;
    type: string;
    strength: number;
    otherPerson: { id: string; name: string; title: string } | null;
  }>;
}

const DEPT_COLORS: Record<string, string> = {
  'Platform Engineering': '#2563eb',
  'Product': '#16a34a',
  'Data Platform': '#9333ea',
  'Design Systems': '#ea580c',
  'ML / AI': '#dc2626',
  'Security': '#0891b2',
};

function ScoresPage() {
  const { data } = useFetch<{ entries: ScoreEntry[]; total: number }>('/api/scores/leaderboard?limit=100');
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: detail } = useFetch<PersonDetail>(
    selectedId ? `/api/graph/people/${encodeURIComponent(selectedId)}` : '',
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    return deptFilter ? data.entries.filter(e => e.department === deptFilter) : data.entries;
  }, [data, deptFilter]);

  const departments = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.entries.map(e => e.department))).sort();
  }, [data]);

  if (!data) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading scores...</div>;
  if (data.entries.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No scored people yet</h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          Run <code>python schema/seed.py</code> to populate Aurora, or invoke the scoring agent to compute scores.
        </p>
      </div>
    );
  }

  const top = filtered[0]?.composite ?? 0;
  const avg = filtered.length > 0
    ? Math.round(filtered.reduce((s, e) => s + e.composite, 0) / filtered.length)
    : 0;

  return (
    <PageSection title="Scoring Dashboard">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
        <StatCard label="People Scored" value={String(filtered.length)} />
        <StatCard label="Avg Composite" value={String(avg)} />
        <StatCard label="Top Score" value={String(top)} />
        <StatCard label="Departments" value={String(departments.length)} />
      </div>

      {/* Department filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12 }}>
        <span style={{ color: 'var(--color-text-tertiary)' }}>Filter:</span>
        <button
          onClick={() => setDeptFilter('')}
          style={chipBtn(deptFilter === '', '#64748b')}
        >
          All
        </button>
        {departments.map(d => (
          <button
            key={d}
            onClick={() => setDeptFilter(d)}
            style={chipBtn(deptFilter === d, DEPT_COLORS[d] ?? '#64748b')}
          >
            {d}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: detail ? '1fr 360px' : '1fr', gap: 24 }}>
        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            Leaderboard{' '}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
              composite = 0.55 × influence (PageRank) + 0.45 × expertise (skill-weighted in-degree)
            </span>
          </h2>
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>#</TableTh>
                <TableTh>Name</TableTh>
                <TableTh>Department</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Influence</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Expertise</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Composite</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((s, i) => {
                const selected = s.personId === selectedId;
                return (
                  <TableRow
                    key={s.personId}
                    onClick={() => setSelectedId(selected ? null : s.personId)}
                    style={{ cursor: 'pointer', background: selected ? 'var(--color-surface-hover)' : undefined }}
                  >
                    <TableTd style={{ color: 'var(--color-text-tertiary)' }}>{i + 1}</TableTd>
                    <TableTd style={{ fontWeight: selected ? 600 : 500 }}>{s.name}</TableTd>
                    <TableTd>
                      <span style={{ color: DEPT_COLORS[s.department] ?? '#64748b', fontSize: 12 }}>
                        {s.department}
                      </span>
                    </TableTd>
                    <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {Math.round(s.influence * 100)}
                    </TableTd>
                    <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {Math.round(s.expertise)}
                    </TableTd>
                    <TableTd style={{ textAlign: 'right', fontWeight: 600 }}>{s.composite}</TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>

        {detail && (
          <Card padding="md">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>{detail.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{detail.title}</div>
                <div style={{ fontSize: 11, color: DEPT_COLORS[detail.department] ?? 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {detail.department}
                </div>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer', color: 'var(--color-text-secondary)' }}
              >
                Close
              </button>
            </div>

            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 6 }}>
              Skills
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {detail.skills.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>none recorded</span>
              ) : (
                detail.skills.map(s => (
                  <span key={s} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--color-surface-hover)', borderRadius: 4 }}>{s}</span>
                ))
              )}
            </div>

            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 6 }}>
              Top Connections ({detail.connections.length} total)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
              {detail.connections
                .slice()
                .sort((a, b) => b.strength - a.strength)
                .slice(0, 12)
                .map((c, i) => (
                  <div
                    key={`${c.source}-${c.target}-${i}`}
                    onClick={() => c.otherPerson && setSelectedId(c.otherPerson.id)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 8px', borderRadius: 3, cursor: c.otherPerson ? 'pointer' : 'default' }}
                  >
                    <span>{c.otherPerson?.name ?? c.target}</span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                      {c.type.replace(/_/g, ' ')} · {Math.round(c.strength * 100)}%
                    </span>
                  </div>
                ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)', fontSize: 13 }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>Influence (PageRank)</span>
              <span style={{ fontWeight: 600 }}>{Math.round(detail.influenceScore * 100)}</span>
            </div>
          </Card>
        )}
      </div>
    </PageSection>
  );
}

function chipBtn(active: boolean, color: string): React.CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    border: `1px solid ${active ? color : 'var(--color-border)'}`,
    background: active ? `${color}15` : 'var(--color-surface)',
    color: active ? color : 'var(--color-text-secondary)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  };
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </Card>
  );
}

export default ScoresPage;
