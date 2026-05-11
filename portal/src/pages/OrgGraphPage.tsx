import { useMemo, useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';
import { OrgGraph } from '../components/org-graph';
import type { GraphPerson } from '../components/org-graph';
import { useFetch } from '../hooks/useFetch';

interface Edge {
  source: string;
  target: string;
  type: string;
  strength: number;
}

interface GraphData {
  nodes: GraphPerson[];
  edges: Edge[];
  departments: Array<{ id: string; name: string; color: string }>;
}

// Filter edges so the canvas stays readable. With a dense seed (70% intra-team
// collaboration) the raw graph at 100+ people has thousands of edges and looks
// like a hairball. Keep only the top-K strongest per person, gated by a minimum
// strength threshold. User can tune both via the controls in the toolbar.
function filterEdges(edges: Edge[], opts: { topK: number; minStrength: number }): Edge[] {
  const filtered = edges.filter(e => e.strength >= opts.minStrength);
  // Sort by strength descending; keep top-K per person on either side.
  const sorted = [...filtered].sort((a, b) => b.strength - a.strength);
  const perNodeCount = new Map<string, number>();
  const kept: Edge[] = [];
  for (const e of sorted) {
    const sCount = perNodeCount.get(e.source) ?? 0;
    const tCount = perNodeCount.get(e.target) ?? 0;
    if (sCount >= opts.topK && tCount >= opts.topK) continue;
    kept.push(e);
    perNodeCount.set(e.source, sCount + 1);
    perNodeCount.set(e.target, tCount + 1);
  }
  return kept;
}

function OrgGraphPage() {
  const { data } = useFetch<GraphData>('/api/graph/entities');
  const [selectedPerson, setSelectedPerson] = useState<GraphPerson | null>(null);
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);

  const filteredEdges = useMemo(
    () => (data ? filterEdges(data.edges, { topK, minStrength }) : []),
    [data, topK, minStrength],
  );

  if (!data) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading graph...</div>;
  }

  if (data.nodes.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Org graph is empty</h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
          Aurora has the schema applied but no rows yet. The graph populates when documents
          are ingested and the graph-builder agent extracts entities + relationships.
        </p>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.7 }}>
          To populate it:
          <ul style={{ marginTop: 6, paddingLeft: 20 }}>
            <li>Upload docs to the <code>orgiq-documents</code> S3 bucket, then invoke the ingestion agent</li>
            <li>Or seed Aurora directly via <code>schema/seed.sql</code> for a quick demo dataset</li>
            <li>Or set <code>MOCK_AURORA=true</code> in <code>middleware/.env.aws</code> to fall back to mock data</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <span><b>{data.nodes.length}</b> people · <b>{filteredEdges.length}</b> / {data.edges.length} edges shown</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Top-K per person:
          <input
            type="range" min={1} max={10} value={topK}
            onChange={e => setTopK(parseInt(e.target.value, 10))}
            style={{ width: 80 }}
          />
          <span style={{ width: 16, textAlign: 'right' }}>{topK}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Min strength:
          <input
            type="range" min={0} max={100} value={Math.round(minStrength * 100)}
            onChange={e => setMinStrength(parseInt(e.target.value, 10) / 100)}
            style={{ width: 80 }}
          />
          <span style={{ width: 28, textAlign: 'right' }}>{minStrength.toFixed(2)}</span>
        </span>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1 }}>
        <OrgGraph
          people={data.nodes}
          relationships={filteredEdges as any}
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
    </div>
  );
}

export default OrgGraphPage;
