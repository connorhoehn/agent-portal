import { Card, PageSection, EmptyState } from '@connorhoehn/ui-components';

function ObservabilityPage() {
  return (
    <PageSection title="Observability">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <StatCard label="Total Traces" value="0" />
        <StatCard label="Avg Latency" value="—" />
        <StatCard label="Token Usage (24h)" value="0" />
        <StatCard label="Errors (24h)" value="0" />
      </div>

      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recent Traces</h2>
        <EmptyState
          title="No traces yet"
          body="Deploy agents and invoke them to see OpenTelemetry traces here."
        />
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

export default ObservabilityPage;
