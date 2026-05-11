import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Position, type Node, type Edge, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFetch } from '../hooks/useFetch';

interface AgentDef {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'deploying';
  protocol: string;
  model: string;
  tools: string[];
  invocationsLast24h: number;
  errorsLast24h: number;
}

const STATUS_COLORS = {
  healthy: '#10b981',
  degraded: '#f59e0b',
  offline: '#ef4444',
  deploying: '#6366f1',
};

const AGENT_POSITIONS: Record<string, { x: number; y: number }> = {
  'orgiq-supervisor': { x: 400, y: 50 },
  'orgiq-search': { x: 150, y: 220 },
  'orgiq-scoring': { x: 400, y: 220 },
  'orgiq-advisor': { x: 650, y: 220 },
  'orgiq-ingestion': { x: 200, y: 420 },
  'orgiq-graph-builder': { x: 550, y: 420 },
};

const AGENT_COLORS: Record<string, string> = {
  'orgiq-supervisor': '#2563eb',
  'orgiq-search': '#16a34a',
  'orgiq-scoring': '#9333ea',
  'orgiq-advisor': '#d97706',
  'orgiq-ingestion': '#64748b',
  'orgiq-graph-builder': '#64748b',
};

// Real AgentCore runtime IDs look like 'orgiq_supervisor-0D95cZBsPU' — the
// 10-char base62 suffix is AWS-generated. Strip it, then swap underscores for
// hyphens so it matches the layout-table keys (and the mock data, which is
// already in canonical hyphenated form).
function canonicalKey(id: string): string {
  return id
    .replace(/-[A-Za-z0-9]{10}$/, '')
    .replace(/_/g, '-');
}

function buildNodes(agents: AgentDef[]): Node[] {
  return agents.map(agent => {
    const key = canonicalKey(agent.id);
    const pos = AGENT_POSITIONS[key] ?? { x: 300, y: 300 };
    const color = AGENT_COLORS[key] ?? '#64748b';

    return {
      id: key,
      position: pos,
      data: { label: '' },
      style: {
        background: `${color}10`,
        border: `2px solid ${color}`,
        borderRadius: 10,
        padding: '12px 16px',
        width: 180,
      },
      type: 'default',
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  }).map((node) => {
    const agent = agents.find(a => canonicalKey(a.id) === node.id)!;
    const statusColor = STATUS_COLORS[agent.status];
    return {
      ...node,
      data: {
        label: (
          <div style={{ textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{agent.name}</span>
            </div>
            <div style={{ fontSize: 10, color: '#64748b' }}>
              {agent.protocol.toUpperCase()} · {agent.model}
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
              {agent.invocationsLast24h} invocations · {agent.errorsLast24h} errors
            </div>
          </div>
        ),
      },
    };
  });
}

const EDGES: Edge[] = [
  { id: 'e1', source: 'orgiq-supervisor', target: 'orgiq-search', label: 'A2A', animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#2563eb' } },
  { id: 'e2', source: 'orgiq-supervisor', target: 'orgiq-scoring', label: 'A2A', animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#9333ea' } },
  { id: 'e3', source: 'orgiq-supervisor', target: 'orgiq-advisor', label: 'A2A', animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#d97706' } },
  { id: 'e4', source: 'orgiq-ingestion', target: 'orgiq-graph-builder', animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#64748b' } },
  { id: 'e5', source: 'orgiq-advisor', target: 'orgiq-search', style: { stroke: '#16a34a', strokeDasharray: '4 2' } },
  { id: 'e6', source: 'orgiq-advisor', target: 'orgiq-scoring', style: { stroke: '#9333ea', strokeDasharray: '4 2' } },
];

function AgentFlowPage() {
  const { data } = useFetch<AgentDef[]>('/api/agents', 30000);
  const nodes = data ? buildNodes(data) : [];

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={EDGES}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
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
