// A2A topology view. Replaces the previous hand-positioned diagram with one
// derived from observability.invocation_traces (parent → child agent calls).
//
// Layout: layered DAG. Sources (no incoming edges) go on top, then BFS layers
// downward. Within a layer, nodes are spread evenly. For 6 agents this beats
// pulling in dagre/elk as a dep.
//
// Edges are weighted by call count (stroke width) and colored by error rate.
// Clicking an edge or node opens a right-side drawer with metrics + deep-links
// into the existing invocation search.

import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Position,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Link } from 'react-router';
import { useFetch } from '../hooks/useFetch';

// ── Types from /api/topology/a2a + /api/agents ───────────────────────────────

interface TopologyNode {
  agentId: string;
  agentName: string;
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number;
}

interface TopologyEdge {
  source: string;
  sourceName: string;
  target: string;
  targetName: string;
  callCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number;
}

interface TopologyResponse {
  windowHours: number;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string;
}

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

// ── Window selector ──────────────────────────────────────────────────────────

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '1h',  hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d',  hours: 24 * 7 },
];

const STATUS_COLORS: Record<AgentDef['status'], string> = {
  healthy: '#10b981',
  degraded: '#f59e0b',
  offline: '#ef4444',
  deploying: '#6366f1',
};

// AgentCore runtime IDs look like 'orgiq_supervisor-0D95cZBsPU'. Trace rows
// often use the canonical hyphenated form ('orgiq-supervisor'). Normalize so a
// node from /api/agents and an edge endpoint from /api/topology line up.
function canonicalKey(id: string): string {
  return id
    .replace(/-[A-Za-z0-9]{10}$/, '')
    .replace(/_/g, '-');
}

// ── Layered DAG layout (no external dep) ─────────────────────────────────────

const NODE_W = 200;
const NODE_H = 88;
const LAYER_Y_GAP = 150;
const NODE_X_GAP = 60;

interface LaidOut {
  positions: Map<string, { x: number; y: number }>;
}

function layoutLayered(nodeIds: string[], edges: TopologyEdge[]): LaidOut {
  // Build adjacency on canonical ids.
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const e of edges) {
    const s = canonicalKey(e.source);
    const t = canonicalKey(e.target);
    if (!incoming.has(s) || !incoming.has(t)) continue;
    if (s === t) continue; // ignore self-loops for layering
    outgoing.get(s)!.add(t);
    incoming.get(t)!.add(s);
  }

  // Kahn-ish layer assignment. Nodes with no incoming edges → layer 0. Each
  // child's layer = max(parent layers) + 1. Cycles fall through to layer 0
  // (we don't expect cycles in A2A but stay safe).
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if (incoming.get(id)!.size === 0) {
      layer.set(id, 0);
      queue.push(id);
    }
  }
  // Topological-ish BFS: visit a node once all its parents have known layers.
  const inDegRemaining = new Map<string, number>();
  for (const id of nodeIds) inDegRemaining.set(id, incoming.get(id)!.size);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const myLayer = layer.get(id) ?? 0;
    for (const child of outgoing.get(id)!) {
      const childLayer = Math.max(layer.get(child) ?? 0, myLayer + 1);
      layer.set(child, childLayer);
      const r = (inDegRemaining.get(child) ?? 0) - 1;
      inDegRemaining.set(child, r);
      if (r <= 0) queue.push(child);
    }
  }
  // Any node still missing (part of a cycle) → drop to layer 0.
  for (const id of nodeIds) {
    if (!layer.has(id)) layer.set(id, 0);
  }

  // Bucket nodes by layer, sort within layer for stable layout.
  const layers: string[][] = [];
  for (const id of nodeIds) {
    const li = layer.get(id) ?? 0;
    if (!layers[li]) layers[li] = [];
    layers[li].push(id);
  }
  for (const row of layers) row?.sort();

  // Center each layer horizontally around x=0.
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((row, li) => {
    if (!row) return;
    const totalW = row.length * NODE_W + (row.length - 1) * NODE_X_GAP;
    const startX = -totalW / 2;
    row.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * (NODE_W + NODE_X_GAP),
        y: li * LAYER_Y_GAP,
      });
    });
  });
  return { positions };
}

// ── Edge styling ─────────────────────────────────────────────────────────────

function edgeStrokeWidth(callCount: number, maxCallCount: number): number {
  if (maxCallCount <= 0) return 1;
  // 1px → 6px, log-scaled so a hot edge doesn't dominate visually.
  const t = Math.log(1 + callCount) / Math.log(1 + maxCallCount);
  return 1 + Math.max(0, Math.min(1, t)) * 5;
}

function edgeColor(errorCount: number, callCount: number): string {
  if (callCount === 0) return '#cbd5e1';
  const rate = errorCount / callCount;
  if (rate >= 0.1)  return '#dc2626'; // red
  if (rate >= 0.02) return '#d97706'; // amber
  return '#16a34a'; // green
}

// ── Node label ───────────────────────────────────────────────────────────────

interface AgentSummary {
  id: string;
  name: string;
  status?: AgentDef['status'];
  protocol?: string;
  model?: string;
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function NodeLabel({ agent }: { agent: AgentSummary }) {
  const statusColor = agent.status ? STATUS_COLORS[agent.status] : '#94a3b8';
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor, flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{agent.name}</span>
      </div>
      {(agent.protocol || agent.model) && (
        <div style={{ fontSize: 10, color: '#64748b' }}>
          {agent.protocol?.toUpperCase()}{agent.protocol && agent.model ? ' · ' : ''}{agent.model}
        </div>
      )}
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
        {agent.invocationCount} inv · {agent.errorCount} err · p50 {fmtMs(agent.p50Ms)}
      </div>
    </div>
  );
}

// ── Drawer (edge / node detail) ──────────────────────────────────────────────

type Selection =
  | { kind: 'edge'; edge: TopologyEdge }
  | { kind: 'node'; agent: AgentSummary }
  | null;

function Drawer({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  if (!selection) return null;

  return (
    <div style={drawerStyle}>
      <div style={drawerHeaderStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {selection.kind === 'edge' ? 'A2A edge' : 'Agent'}
        </div>
        <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
      </div>
      {selection.kind === 'edge' ? <EdgeDetail edge={selection.edge} /> : <NodeDetail agent={selection.agent} />}
    </div>
  );
}

function EdgeDetail({ edge }: { edge: TopologyEdge }) {
  const rate = edge.callCount > 0 ? edge.errorCount / edge.callCount : 0;
  return (
    <div style={drawerBodyStyle}>
      <div style={drawerKvBlockStyle}>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>From</span><span style={drawerKValueStyle}>{edge.sourceName || edge.source}</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>To</span><span style={drawerKValueStyle}>{edge.targetName || edge.target}</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Calls</span><span style={drawerKValueStyle}>{edge.callCount}</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Errors</span><span style={drawerKValueStyle}>{edge.errorCount} ({(rate * 100).toFixed(1)}%)</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>p50 / p95</span><span style={drawerKValueStyle}>{fmtMs(edge.p50Ms)} / {fmtMs(edge.p95Ms)}</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Cost</span><span style={drawerKValueStyle}>${edge.totalCostUsd.toFixed(4)}</span></div>
      </div>
      <div style={drawerActionsStyle}>
        <Link
          to={`/admin/observability/invocations/search?agentId=${encodeURIComponent(edge.target)}`}
          style={drawerLinkStyle}
        >
          View {edge.targetName || edge.target} invocations →
        </Link>
      </div>
    </div>
  );
}

function NodeDetail({ agent }: { agent: AgentSummary }) {
  return (
    <div style={drawerBodyStyle}>
      <div style={drawerKvBlockStyle}>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Agent</span><span style={drawerKValueStyle}>{agent.name}</span></div>
        {agent.protocol && (
          <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Protocol</span><span style={drawerKValueStyle}>{agent.protocol.toUpperCase()}</span></div>
        )}
        {agent.model && (
          <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Model</span><span style={drawerKValueStyle}>{agent.model}</span></div>
        )}
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Invocations</span><span style={drawerKValueStyle}>{agent.invocationCount}</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>Errors</span><span style={drawerKValueStyle}>{agent.errorCount}</span></div>
        <div style={drawerKvRowStyle}><span style={drawerKLabelStyle}>p50 / p95</span><span style={drawerKValueStyle}>{fmtMs(agent.p50Ms)} / {fmtMs(agent.p95Ms)}</span></div>
      </div>
      <div style={drawerActionsStyle}>
        <Link
          to={`/admin/observability/invocations/search?agentId=${encodeURIComponent(agent.id)}`}
          style={drawerLinkStyle}
        >
          View invocations →
        </Link>
        <Link to="/admin/observability/agents" style={drawerLinkStyle}>
          Per-agent metrics →
        </Link>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function AgentFlowPage() {
  const [windowHours, setWindowHours] = useState<number>(24);
  const [selection, setSelection] = useState<Selection>(null);

  const { data: topology } = useFetch<TopologyResponse>(
    `/api/topology/a2a?windowHours=${windowHours}`,
    30_000,
  );
  const { data: agents } = useFetch<AgentDef[]>('/api/agents', 30_000);

  // Reset selection when window changes — a selected edge for 24h may not
  // exist in 1h.
  useEffect(() => setSelection(null), [windowHours]);

  // Merge: union of agents from registry and agents that show up in topology.
  // Registry contributes status/protocol/model. Topology contributes counts.
  const agentSummaries = useMemo<AgentSummary[]>(() => {
    const byKey = new Map<string, AgentSummary>();

    if (agents) {
      for (const a of agents) {
        const key = canonicalKey(a.id);
        byKey.set(key, {
          id: a.id,
          name: a.name,
          status: a.status,
          protocol: a.protocol,
          model: a.model,
          invocationCount: 0,
          errorCount: 0,
          p50Ms: null,
          p95Ms: null,
        });
      }
    }
    if (topology) {
      for (const n of topology.nodes) {
        const key = canonicalKey(n.agentId);
        const existing = byKey.get(key);
        if (existing) {
          existing.invocationCount = n.invocationCount;
          existing.errorCount = n.errorCount;
          existing.p50Ms = n.p50Ms;
          existing.p95Ms = n.p95Ms;
        } else {
          byKey.set(key, {
            id: n.agentId,
            name: n.agentName,
            invocationCount: n.invocationCount,
            errorCount: n.errorCount,
            p50Ms: n.p50Ms,
            p95Ms: n.p95Ms,
          });
        }
      }
    }
    return Array.from(byKey.values());
  }, [agents, topology]);

  const layout = useMemo(() => {
    const ids = agentSummaries.map((a) => canonicalKey(a.id));
    return layoutLayered(ids, topology?.edges ?? []);
  }, [agentSummaries, topology]);

  const reactFlowNodes = useMemo<Node[]>(() => {
    return agentSummaries.map((a) => {
      const key = canonicalKey(a.id);
      const pos = layout.positions.get(key) ?? { x: 0, y: 0 };
      const isDead = a.status === 'offline' || (!a.invocationCount && a.status !== 'healthy');
      return {
        id: key,
        position: pos,
        data: { label: <NodeLabel agent={a} /> },
        type: 'default',
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        style: {
          background: isDead ? '#f8fafc' : 'var(--color-surface, #ffffff)',
          border: `2px solid ${a.status ? STATUS_COLORS[a.status] : '#cbd5e1'}`,
          borderRadius: 10,
          padding: '10px 12px',
          width: NODE_W,
          opacity: isDead ? 0.65 : 1,
          cursor: 'pointer',
        },
      };
    });
  }, [agentSummaries, layout]);

  const reactFlowEdges = useMemo<Edge[]>(() => {
    const list = topology?.edges ?? [];
    const maxCount = list.reduce((m, e) => Math.max(m, e.callCount), 0);
    return list.map((e, i) => {
      const stroke = edgeColor(e.errorCount, e.callCount);
      const width = edgeStrokeWidth(e.callCount, maxCount);
      const isHot = maxCount > 0 && e.callCount >= maxCount * 0.5;
      return {
        id: `e${i}`,
        source: canonicalKey(e.source),
        target: canonicalKey(e.target),
        animated: isHot,
        label: `${e.callCount}`,
        labelStyle: { fontSize: 10, fill: stroke, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--color-surface, #fff)' },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: { stroke, strokeWidth: width },
      };
    });
  }, [topology]);

  const onEdgeClick = (_e: React.MouseEvent, edge: Edge) => {
    const match = topology?.edges.find((te, i) => `e${i}` === edge.id);
    if (match) setSelection({ kind: 'edge', edge: match });
  };
  const onNodeClick = (_e: React.MouseEvent, node: Node) => {
    const match = agentSummaries.find((a) => canonicalKey(a.id) === node.id);
    if (match) setSelection({ kind: 'node', agent: match });
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <Toolbar
        windowHours={windowHours}
        onChange={setWindowHours}
        nodeCount={agentSummaries.length}
        edgeCount={topology?.edges.length ?? 0}
        generatedAt={topology?.generatedAt ?? null}
      />
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={reactFlowNodes}
            edges={reactFlowEdges}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            onEdgeClick={onEdgeClick}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelection(null)}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </ReactFlowProvider>
        <Drawer selection={selection} onClose={() => setSelection(null)} />
        <Legend />
      </div>
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

function Toolbar({
  windowHours,
  onChange,
  nodeCount,
  edgeCount,
  generatedAt,
}: {
  windowHours: number;
  onChange: (h: number) => void;
  nodeCount: number;
  edgeCount: number;
  generatedAt: string | null;
}) {
  return (
    <div style={toolbarStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary, #64748b)' }}>Window</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => onChange(w.hours)}
              style={w.hours === windowHours ? windowBtnActiveStyle : windowBtnStyle}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)' }}>
        {nodeCount} agents · {edgeCount} A2A edges
        {generatedAt && ` · refreshed ${new Date(generatedAt).toLocaleTimeString()}`}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div style={legendStyle}>
      <div style={legendTitleStyle}>Legend</div>
      <div style={legendRowStyle}>
        <span style={{ ...legendSwatchStyle, background: '#16a34a' }} />
        <span>healthy edge (&lt; 2% error)</span>
      </div>
      <div style={legendRowStyle}>
        <span style={{ ...legendSwatchStyle, background: '#d97706' }} />
        <span>elevated (2–10%)</span>
      </div>
      <div style={legendRowStyle}>
        <span style={{ ...legendSwatchStyle, background: '#dc2626' }} />
        <span>unhealthy (&gt; 10%)</span>
      </div>
      <div style={{ ...legendRowStyle, marginTop: 4 }}>
        <span style={{ ...legendSwatchStyle, background: '#94a3b8' }} />
        <span>thicker = more calls; animated = hot</span>
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)',
  gap: 16,
};
const windowBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const windowBtnActiveStyle: React.CSSProperties = {
  ...windowBtnStyle,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  borderColor: 'var(--color-primary, #6366f1)',
};
const drawerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  bottom: 12,
  width: 320,
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  boxShadow: '0 4px 20px rgba(15, 23, 42, 0.08)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 10,
};
const drawerHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-text-tertiary, #94a3b8)',
  cursor: 'pointer',
  fontSize: 14,
  padding: 4,
};
const drawerBodyStyle: React.CSSProperties = {
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  overflowY: 'auto',
};
const drawerKvBlockStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const drawerKvRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 12,
};
const drawerKLabelStyle: React.CSSProperties = {
  color: 'var(--color-text-tertiary, #94a3b8)',
};
const drawerKValueStyle: React.CSSProperties = {
  color: 'var(--color-text-primary, #0f172a)',
  fontWeight: 500,
  textAlign: 'right',
};
const drawerActionsStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  borderTop: '1px solid var(--color-border, #e2e8f0)',
  paddingTop: 12,
};
const drawerLinkStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
  fontWeight: 500,
};
const legendStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  padding: '8px 10px',
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
  fontSize: 10.5,
  color: 'var(--color-text-secondary, #475569)',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  zIndex: 5,
};
const legendTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 10.5,
  color: 'var(--color-text-primary, #0f172a)',
  marginBottom: 2,
};
const legendRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const legendSwatchStyle: React.CSSProperties = {
  width: 14,
  height: 3,
  borderRadius: 2,
};

export default AgentFlowPage;
