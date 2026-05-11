import { useState } from 'react';
import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehnslalom/ui-components';
import { useFetch } from '../hooks/useFetch';

interface ScoreEntry {
  personId: string;
  name: string;
  department: string;
  influence: number;
  collaboration: number;
  expertise: number;
  velocity: number;
  quality: number;
  composite: number;
  trend: number[];
}

const DEPT_COLORS: Record<string, string> = {
  'Platform Engineering': '#2563eb',
  'Product': '#16a34a',
  'Data Platform': '#9333ea',
  'Design Systems': '#ea580c',
};

function ScoresPage() {
  const { data } = useFetch<{ entries: ScoreEntry[]; total: number }>('/api/scores/leaderboard');
  const [selectedIdx, setSelectedIdx] = useState(0);

  if (!data) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading scores...</div>;

  const selected = data.entries[selectedIdx];
  const radarData = selected ? [
    { metric: 'Influence', value: Math.round(selected.influence * 100) },
    { metric: 'Collaboration', value: Math.round(selected.collaboration * 100) },
    { metric: 'Expertise', value: Math.round(selected.expertise * 100) },
    { metric: 'Velocity', value: Math.round(selected.velocity * 100) },
    { metric: 'Quality', value: Math.round(selected.quality * 100) },
  ] : [];

  const trendData = selected?.trend.map((v, i) => ({ day: `D${i + 1}`, score: v })) ?? [];

  return (
    <PageSection title="Scoring Dashboard">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <StatCard label="Total People Scored" value={String(data.total)} />
        <StatCard label="Avg Composite" value={String(Math.round(data.entries.reduce((s, e) => s + e.composite, 0) / data.entries.length))} />
        <StatCard label="Top Score" value={String(data.entries[0]?.composite ?? 0)} />
        <StatCard label="Departments" value="4" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            {selected?.name} — Score Breakdown
          </h2>
          <ResponsiveContainer width="100%" height={240}>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="metric" fontSize={12} />
              <Radar dataKey="value" stroke="#2563eb" fill="#2563eb" fillOpacity={0.2} />
            </RadarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>7-Day Trend</div>
            <ResponsiveContainer width="100%" height={60}>
              <AreaChart data={trendData}>
                <Area type="monotone" dataKey="score" stroke="#6366f1" fill="#6366f1" fillOpacity={0.1} />
                <XAxis hide />
                <YAxis hide domain={['dataMin - 5', 'dataMax + 5']} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Leaderboard</h2>
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>#</TableTh>
                <TableTh>Name</TableTh>
                <TableTh>Department</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Composite</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.entries.map((s, i) => (
                <TableRow
                  key={s.personId}
                  onClick={() => setSelectedIdx(i)}
                  style={{ cursor: 'pointer', background: i === selectedIdx ? 'var(--color-surface-hover)' : undefined }}
                >
                  <TableTd>{i + 1}</TableTd>
                  <TableTd style={{ fontWeight: i === selectedIdx ? 600 : 400 }}>{s.name}</TableTd>
                  <TableTd>
                    <span style={{ color: DEPT_COLORS[s.department] ?? '#64748b', fontSize: 12 }}>
                      {s.department}
                    </span>
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontWeight: 600 }}>{s.composite}</TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </PageSection>
  );
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
