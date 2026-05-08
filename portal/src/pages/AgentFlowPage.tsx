import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const agentNodes: Node[] = [
  { id: 'supervisor', position: { x: 400, y: 50 }, data: { label: 'Supervisor (AG-UI)' }, style: { background: '#eff6ff', border: '2px solid #2563eb', borderRadius: 8, padding: 12, fontWeight: 600 } },
  { id: 'search', position: { x: 150, y: 200 }, data: { label: 'Search Agent' }, style: { background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: 8, padding: 12 } },
  { id: 'scoring', position: { x: 400, y: 200 }, data: { label: 'Scoring Agent' }, style: { background: '#faf5ff', border: '2px solid #9333ea', borderRadius: 8, padding: 12 } },
  { id: 'advisor', position: { x: 650, y: 200 }, data: { label: 'Advisor Agent' }, style: { background: '#fffbeb', border: '2px solid #d97706', borderRadius: 8, padding: 12 } },
  { id: 'ingestion', position: { x: 200, y: 380 }, data: { label: 'Ingestion Agent' }, style: { background: '#f8fafc', border: '2px solid #64748b', borderRadius: 8, padding: 12 } },
  { id: 'graph-builder', position: { x: 550, y: 380 }, data: { label: 'Graph Builder Agent' }, style: { background: '#f8fafc', border: '2px solid #64748b', borderRadius: 8, padding: 12 } },
  { id: 'kb', position: { x: 200, y: 520 }, data: { label: 'Knowledge Base' }, style: { background: '#fef2f2', border: '1px dashed #dc2626', borderRadius: 8, padding: 8, fontSize: 12 } },
  { id: 'neptune', position: { x: 550, y: 520 }, data: { label: 'Neptune Graph' }, style: { background: '#fef2f2', border: '1px dashed #dc2626', borderRadius: 8, padding: 8, fontSize: 12 } },
  { id: 'guardrail', position: { x: 400, y: 130 }, data: { label: 'Guardrails' }, style: { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: 4, fontSize: 11 } },
];

const agentEdges: Edge[] = [
  { id: 'e-sup-search', source: 'supervisor', target: 'search', label: 'A2A', style: { stroke: '#2563eb' } },
  { id: 'e-sup-scoring', source: 'supervisor', target: 'scoring', label: 'A2A', style: { stroke: '#9333ea' } },
  { id: 'e-sup-advisor', source: 'supervisor', target: 'advisor', label: 'A2A', style: { stroke: '#d97706' } },
  { id: 'e-ingest-gb', source: 'ingestion', target: 'graph-builder', animated: true, style: { stroke: '#64748b' } },
  { id: 'e-ingest-kb', source: 'ingestion', target: 'kb', style: { stroke: '#64748b' } },
  { id: 'e-gb-neptune', source: 'graph-builder', target: 'neptune', style: { stroke: '#64748b' } },
  { id: 'e-search-kb', source: 'search', target: 'kb', style: { stroke: '#16a34a', strokeDasharray: '4 2' } },
  { id: 'e-search-neptune', source: 'search', target: 'neptune', style: { stroke: '#16a34a', strokeDasharray: '4 2' } },
  { id: 'e-scoring-neptune', source: 'scoring', target: 'neptune', style: { stroke: '#9333ea', strokeDasharray: '4 2' } },
];

function AgentFlowPage() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={agentNodes}
          edges={agentEdges}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export default AgentFlowPage;
