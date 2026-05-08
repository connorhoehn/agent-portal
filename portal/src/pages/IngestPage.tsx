import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehn/ui-components';

function IngestPage() {
  const sources = [
    { name: 'Confluence', status: 'configured', lastSync: 'Never', docs: 0 },
    { name: 'Jira', status: 'configured', lastSync: 'Never', docs: 0 },
    { name: 'Meeting Transcripts (S3)', status: 'configured', lastSync: 'Never', docs: 0 },
    { name: 'Slack', status: 'pending', lastSync: 'Never', docs: 0 },
  ];

  return (
    <PageSection title="Ingest Monitor">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <StatCard label="Sources" value="4" />
        <StatCard label="Active Syncs" value="0" />
        <StatCard label="Documents Ingested" value="0" />
        <StatCard label="DLQ Items" value="0" />
      </div>

      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Data Sources</h2>
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Source</TableTh>
              <TableTh>Status</TableTh>
              <TableTh>Last Sync</TableTh>
              <TableTh style={{ textAlign: 'right' }}>Documents</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {sources.map(s => (
              <TableRow key={s.name}>
                <TableTd>{s.name}</TableTd>
                <TableTd>
                  <Chip tone={s.status === 'configured' ? 'success' : 'warning'} size="xs">
                    {s.status}
                  </Chip>
                </TableTd>
                <TableTd>{s.lastSync}</TableTd>
                <TableTd style={{ textAlign: 'right' }}>{s.docs}</TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
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

export default IngestPage;
