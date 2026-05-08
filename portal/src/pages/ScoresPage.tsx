import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer } from 'recharts';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehn/ui-components';
import { mockScores } from '../mock/org-data';

function ScoresPage() {
  const selected = mockScores[0];
  const radarData = [
    { metric: 'Influence', value: selected.influence },
    { metric: 'Collaboration', value: selected.collaboration },
    { metric: 'Expertise', value: selected.expertise },
    { metric: 'Velocity', value: selected.velocity },
    { metric: 'Quality', value: selected.quality },
  ];

  return (
    <PageSection title="Scoring Dashboard">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{selected.name} — Score Breakdown</h2>
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="metric" fontSize={12} />
              <Radar dataKey="value" stroke="#2563eb" fill="#2563eb" fillOpacity={0.2} />
            </RadarChart>
          </ResponsiveContainer>
        </Card>

        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Leaderboard</h2>
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>#</TableTh>
                <TableTh>Name</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Influence</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Composite</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {mockScores.map((s, i) => (
                <TableRow key={s.personId}>
                  <TableTd>{i + 1}</TableTd>
                  <TableTd>{s.name}</TableTd>
                  <TableTd style={{ textAlign: 'right' }}>{(s.influence * 100).toFixed(0)}</TableTd>
                  <TableTd style={{ textAlign: 'right', fontWeight: 600 }}>
                    {((s.influence + s.collaboration + s.expertise + s.velocity + s.quality) / 5 * 100).toFixed(0)}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </PageSection>
  );
}

export default ScoresPage;
