import { ReactFlow, ReactFlowProvider, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { mockPeople, mockTeams } from '../mock/org-data';

const TEAM_POSITIONS: Record<string, { x: number; y: number }> = {
  'Platform Engineering': { x: 100, y: 100 },
  'Product': { x: 500, y: 100 },
  'Data Platform': { x: 100, y: 400 },
  'Design Systems': { x: 500, y: 400 },
};

const TEAM_COLORS: Record<string, string> = {
  'Platform Engineering': '#2563eb',
  'Product': '#16a34a',
  'Data Platform': '#9333ea',
  'Design Systems': '#ea580c',
};

const nodes: Node[] = mockPeople.map((person, i) => {
  const teamPos = TEAM_POSITIONS[person.department] ?? { x: 300, y: 300 };
  const offset = { x: (i % 3) * 140, y: Math.floor((i % 5) / 3) * 80 };
  const size = 20 + person.influenceScore * 40;

  return {
    id: person.id,
    position: { x: teamPos.x + offset.x, y: teamPos.y + offset.y },
    data: { label: person.name },
    style: {
      background: 'white',
      border: `2px solid ${TEAM_COLORS[person.department] ?? '#64748b'}`,
      borderRadius: '50%',
      width: size,
      height: size,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10,
      padding: 4,
    },
  };
});

const edges: Edge[] = [
  { id: 'c-1-2', source: 'p-001', target: 'p-002', style: { stroke: '#cbd5e1' } },
  { id: 'c-1-4', source: 'p-001', target: 'p-004', style: { stroke: '#cbd5e1' } },
  { id: 'c-1-11', source: 'p-001', target: 'p-011', style: { stroke: '#e2e8f0' } },
  { id: 'c-5-10', source: 'p-005', target: 'p-010', style: { stroke: '#e2e8f0' } },
  { id: 'c-5-15', source: 'p-005', target: 'p-015', style: { stroke: '#e2e8f0' } },
  { id: 'c-6-7', source: 'p-006', target: 'p-007', style: { stroke: '#cbd5e1' } },
  { id: 'c-11-12', source: 'p-011', target: 'p-012', style: { stroke: '#cbd5e1' } },
  { id: 'c-11-13', source: 'p-011', target: 'p-013', style: { stroke: '#cbd5e1' } },
  { id: 'c-16-17', source: 'p-016', target: 'p-017', style: { stroke: '#cbd5e1' } },
  { id: 'c-16-18', source: 'p-016', target: 'p-018', style: { stroke: '#cbd5e1' } },
  { id: 'c-17-3', source: 'p-017', target: 'p-003', style: { stroke: '#e2e8f0' } },
];

function OrgGraphPage() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export default OrgGraphPage;
