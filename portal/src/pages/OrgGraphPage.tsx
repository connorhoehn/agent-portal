import { useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components';
import { OrgGraph } from '../components/org-graph';
import type { GraphPerson } from '../components/org-graph';
import { useFetch } from '../hooks/useFetch';

interface GraphData {
  nodes: GraphPerson[];
  edges: Array<{ source: string; target: string; type: string; strength: number }>;
  departments: Array<{ id: string; name: string; color: string }>;
}

function OrgGraphPage() {
  const { data } = useFetch<GraphData>('/api/graph/entities');
  const [selectedPerson, setSelectedPerson] = useState<GraphPerson | null>(null);

  if (!data) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading graph...</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1 }}>
        <OrgGraph
          people={data.nodes}
          relationships={data.edges as any}
          departments={data.departments}
          onPersonSelect={setSelectedPerson}
        />
      </div>
      {selectedPerson && (
        <div style={{ width: 300, borderLeft: '1px solid var(--color-border)', padding: 16, overflow: 'auto' }}>
          <Card padding="md">
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{selectedPerson.name}</h2>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{selectedPerson.title}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>{selectedPerson.department}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Skills</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
              {selectedPerson.skills.map(s => (
                <span key={s} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--color-surface-hover)', borderRadius: 4 }}>{s}</span>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>Influence Score</span>
              <span style={{ fontWeight: 600 }}>{Math.round(selectedPerson.influenceScore * 100)}</span>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default OrgGraphPage;
