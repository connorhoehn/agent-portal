// Architecture view — static A2A topology with live metrics overlaid.
// Uses fixed positions for the 9 known agents instead of a layout algorithm
// (which collapses all nodes to layer 0 when observability trace data is sparse).
// Live metrics from /api/topology/a2a are merged in once data arrives; the
// static topology always renders so the graph is meaningful from first load.

import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Panel,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Link, useSearchParams } from 'react-router';
import { useFetch } from '../hooks/useFetch';

// ── Types ─────────────────────────────────────────────────────────────────────

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
  target: string;
  callCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
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
}

// ── Static topology catalog ───────────────────────────────────────────────────

type Cluster = 'orgiq' | 'newsroom';

interface AgentMeta {
  display: string;
  description: string;
  x: number;
  y: number;
  cluster: Cluster;
}

const AGENTS: Record<string, AgentMeta> = {
  'orgiq-supervisor':      { display: 'Supervisor',      description: 'Routes requests; attaches guardrail per role',  x: 320, y: 40,  cluster: 'orgiq' },
  'orgiq-search':          { display: 'Search',          description: 'KB + people-graph retrieval (RAG)',             x: 60,  y: 240, cluster: 'orgiq' },
  'orgiq-scoring':         { display: 'Scoring',         description: 'Expertise + PageRank scoring',                  x: 320, y: 240, cluster: 'orgiq' },
  'orgiq-advisor':         { display: 'Advisor',         description: 'Recommends experts and decisions',              x: 580, y: 240, cluster: 'orgiq' },
  'orgiq-graph-builder':   { display: 'Graph Builder',   description: 'Merges entities + edges into Aurora',           x: 170, y: 450, cluster: 'orgiq' },
  'orgiq-ingestion':       { display: 'Ingestion',       description: 'Parses, chunks, and embeds documents',          x: 460, y: 450, cluster: 'orgiq' },
  'orgiq-news-researcher': { display: 'News Researcher', description: 'Gathers signals, pitches stories',              x: 960, y: 120, cluster: 'newsroom' },
  'orgiq-news-brief':      { display: 'News Brief',      description: 'Drafts long-form briefs from pitches',          x: 820, y: 340, cluster: 'newsroom' },
  'orgiq-news-headline':   { display: 'News Headline',   description: 'Writes headlines from briefs',                  x: 1100, y: 340, cluster: 'newsroom' },
};

interface StaticEdgeDef { id: string; source: string; target: string }

const STATIC_EDGES: StaticEdgeDef[] = [
  { id: 'sup-search',    source: 'orgiq-supervisor',       target: 'orgiq-search' },
  { id: 'sup-scoring',   source: 'orgiq-supervisor',       target: 'orgiq-scoring' },
  { id: 'sup-advisor',   source: 'orgiq-supervisor',       target: 'orgiq-advisor' },
  { id: 'sup-news',      source: 'orgiq-supervisor',       target: 'orgiq-news-researcher' },
  { id: 'search-graph',  source: 'orgiq-search',           target: 'orgiq-graph-builder' },
  { id: 'scoring-graph', source: 'orgiq-scoring',          target: 'orgiq-graph-builder' },
  { id: 'adv-scoring',   source: 'orgiq-advisor',          target: 'orgiq-scoring' },
  { id: 'news-brief',    source: 'orgiq-news-researcher',  target: 'orgiq-news-brief' },
  { id: 'news-headline', source: 'orgiq-news-researcher',  target: 'orgiq-news-headline' },
];

// ── Constants / helpers ───────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  healthy: '#10b981',
  degraded: '#f59e0b',
  offline: '#ef4444',
  deploying: '#6366f1',
};

const CLUSTER_COLORS: Record<Cluster, string> = {
  orgiq: '#6366f1',
  newsroom: '#0ea5e9',
};

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
];

function canonicalKey(id: string): string {
  return id.replace(/-[A-Za-z0-9]{10}$/, '').replace(/_/g, '-');
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function edgeStroke(errorCount: number, callCount: number): string {
  if (callCount === 0) return '#cbd5e1';
  const r = errorCount / callCount;
  if (r >= 0.1) return '#dc2626';
  if (r >= 0.02) return '#d97706';
  return '#10b981';
}

// ── Agent summary (merged from /api/agents + /api/topology/a2a) ───────────────

interface AgentSummary {
  id: string;
  status?: string;
  protocol?: string;
  model?: string;
  tools?: string[];
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

function buildSummaries(
  agents: AgentDef[] | undefined,
  topology: TopologyResponse | undefined,
): Map<string, AgentSummary> {
  const m = new Map<string, AgentSummary>();

  for (const a of agents ?? []) {
    const key = canonicalKey(a.id);
    m.set(key, { id: a.id, status: a.status, protocol: a.protocol, model: a.model, tools: a.tools, invocationCount: 0, errorCount: 0, p50Ms: null, p95Ms: null });
  }
  for (const n of topology?.nodes ?? []) {
    const key = canonicalKey(n.agentId);
    const ex = m.get(key);
    if (ex) {
      ex.invocationCount = n.invocationCount;
      ex.errorCount = n.errorCount;
      ex.p50Ms = n.p50Ms;
      ex.p95Ms = n.p95Ms;
    } else {
      m.set(key, { id: n.agentId, invocationCount: n.invocationCount, errorCount: n.errorCount, p50Ms: n.p50Ms, p95Ms: n.p95Ms });
    }
  }
  return m;
}

// ── Custom AgentNode ──────────────────────────────────────────────────────────

type AgentNodeData = {
  meta: AgentMeta;
  summary: AgentSummary | null;
  onSelect: (id: string) => void;
};

function AgentNodeComp({ id, data }: { id: string; data: unknown }) {
  const { meta, summary, onSelect } = data as AgentNodeData;
  const status = summary?.status ?? 'offline';
  const statusColor = STATUS_COLORS[status] ?? '#94a3b8';
  const clusterColor = CLUSTER_COLORS[meta.cluster];

  return (
    <div
      onClick={() => onSelect(id)}
      style={{
        background: 'var(--color-surface, #fff)',
        border: `2px solid ${statusColor}`,
        borderRadius: 10,
        padding: '10px 14px',
        width: 215,
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(15,23,42,0.07)',
        userSelect: 'none',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1, color: 'var(--color-text-primary, #0f172a)' }}>
          {meta.display}
        </span>
        <span style={{
          fontSize: 9, fontWeight: 700,
          color: clusterColor,
          background: `${clusterColor}18`,
          border: `1px solid ${clusterColor}40`,
          borderRadius: 4, padding: '1px 5px',
          textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>
          {meta.cluster === 'orgiq' ? 'OrgIQ' : 'Newsroom'}
        </span>
      </div>

      {/* Description */}
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)', marginBottom: 9, lineHeight: 1.35 }}>
        {meta.description}
      </div>

      {/* Metric chips */}
      <div style={{ display: 'flex', gap: 4 }}>
        <MetricChip label="calls"  value={fmtCount(summary?.invocationCount ?? 0)} />
        <MetricChip label="err"    value={String(summary?.errorCount ?? 0)} accent={(summary?.errorCount ?? 0) > 0 ? 'warn' : undefined} />
        <MetricChip label="p95"    value={fmtMs(summary?.p95Ms ?? null)} />
      </div>
    </div>
  );
}

function MetricChip({ label, value, accent }: { label: string; value: string; accent?: 'warn' | 'danger' }) {
  const color = accent === 'danger' ? '#dc2626' : accent === 'warn' ? '#d97706' : 'var(--color-text-primary, #0f172a)';
  return (
    <div style={{ flex: 1, background: 'var(--color-bg, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 4, padding: '3px 4px', textAlign: 'center' }}>
      <div style={{ fontSize: 9, color: 'var(--color-text-tertiary, #94a3b8)', lineHeight: 1.2 }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color, lineHeight: 1.3 }}>{value}</div>
    </div>
  );
}

const NODE_TYPES = { agentNode: AgentNodeComp };

// ── Page ──────────────────────────────────────────────────────────────────────

function AgentFlowPage() {
  const [windowHours, setWindowHours] = useState(24);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  // ?cluster=orgiq | newsroom | all (default = all)
  const clusterFilter = (searchParams.get('cluster') ?? 'all') as 'all' | 'orgiq' | 'newsroom';

  const { data: topology } = useFetch<TopologyResponse>(
    `/api/topology/a2a?windowHours=${windowHours}`, 30_000,
  );
  const { data: agents } = useFetch<AgentDef[]>('/api/agents', 30_000);

  useEffect(() => setSelectedId(null), [windowHours]);

  const summaries = useMemo(
    () => buildSummaries(agents ?? undefined, topology ?? undefined),
    [agents, topology],
  );

  // Live edge metrics keyed "source→target"
  const liveEdges = useMemo(() => {
    const m = new Map<string, TopologyEdge>();
    for (const e of topology?.edges ?? []) {
      m.set(`${canonicalKey(e.source)}→${canonicalKey(e.target)}`, e);
    }
    return m;
  }, [topology]);

  const maxCalls = useMemo(
    () => (topology?.edges ?? []).reduce((mx, e) => Math.max(mx, e.callCount), 0),
    [topology],
  );

  // Visible agent IDs after cluster filter
  const visibleAgentIds = useMemo(
    () => new Set(
      Object.entries(AGENTS)
        .filter(([, m]) => clusterFilter === 'all' || m.cluster === clusterFilter)
        .map(([id]) => id),
    ),
    [clusterFilter],
  );

  const rfNodes = useMemo<Node[]>(() => {
    const handleSelect = (id: string) => setSelectedId(id);
    return Object.entries(AGENTS)
      .filter(([id]) => visibleAgentIds.has(id))
      .map(([id, meta]) => ({
        id,
        type: 'agentNode',
        position: { x: meta.x, y: meta.y },
        data: { meta, summary: summaries.get(id) ?? null, onSelect: handleSelect } as unknown as Record<string, unknown>,
      }));
  }, [summaries, visibleAgentIds]);

  const rfEdges = useMemo<Edge[]>(() => {
    return STATIC_EDGES.filter(
      (se) => visibleAgentIds.has(se.source) && visibleAgentIds.has(se.target),
    ).map((se) => {
      const live = liveEdges.get(`${se.source}→${se.target}`);
      const calls = live?.callCount ?? 0;
      const errors = live?.errorCount ?? 0;
      const stroke = edgeStroke(errors, calls);
      const isCross = AGENTS[se.source]?.cluster !== AGENTS[se.target]?.cluster;
      const isHot = maxCalls > 0 && calls >= maxCalls * 0.5;
      return {
        id: se.id,
        source: se.source,
        target: se.target,
        animated: isHot,
        label: calls > 0 ? fmtCount(calls) : undefined,
        labelStyle: { fontSize: 10, fill: stroke, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--color-surface, #fff)', fillOpacity: 0.85 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: {
          stroke,
          strokeWidth: calls > 0 ? Math.max(1.5, Math.min(4.5, 1 + calls / 20)) : 1.5,
          strokeDasharray: isCross ? '6 3' : undefined,
        },
      };
    });
  }, [liveEdges, maxCalls, visibleAgentIds]);

  // Summary bar totals
  const onlineCount = useMemo(
    () => Array.from(summaries.values()).filter(s => s.status === 'healthy' || s.status === 'deploying').length,
    [summaries],
  );
  const totalCalls  = (topology?.nodes ?? []).reduce((s, n) => s + n.invocationCount, 0);
  const totalErrors = (topology?.nodes ?? []).reduce((s, n) => s + n.errorCount, 0);
  const errRate = totalCalls > 0 ? `${((totalErrors / totalCalls) * 100).toFixed(1)}%` : '—';

  const selectedSummary = selectedId ? summaries.get(selectedId) ?? null : null;
  const selectedMeta    = selectedId ? AGENTS[selectedId] ?? null : null;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* ── Summary bar ── */}
      <div style={summaryBarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <SummaryKV label="Agents" value={`${onlineCount} / ${Object.keys(AGENTS).length} online`} />
          <SummaryKV label={`Calls (${windowHours < 24 ? windowHours + 'h' : windowHours === 24 ? '24h' : '7d'})`} value={fmtCount(totalCalls)} />
          <SummaryKV label="Errors" value={fmtCount(totalErrors)} accent={totalErrors > 0 ? 'warn' : undefined} />
          <SummaryKV label="Err rate" value={errRate} accent={totalErrors > 0 ? 'warn' : undefined} />
          {topology?.generatedAt && (
            <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary, #94a3b8)' }}>
              Refreshed {new Date(topology.generatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary, #64748b)' }}>Window</span>
          {WINDOWS.map(w => (
            <button key={w.hours} onClick={() => setWindowHours(w.hours)}
              style={w.hours === windowHours ? windowBtnActive : windowBtnBase}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            onPaneClick={() => setSelectedId(null)}
          >
            <Background color="var(--color-border, #e2e8f0)" />
            <Controls />
            <Panel position="bottom-left">
              <Legend />
            </Panel>
          </ReactFlow>
        </ReactFlowProvider>

        {selectedId && selectedMeta && (
          <AgentDrawer
            agentId={selectedId}
            meta={selectedMeta}
            summary={selectedSummary}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Summary bar helpers ───────────────────────────────────────────────────────

function SummaryKV({ label, value, accent }: { label: string; value: string; accent?: 'warn' }) {
  const valColor = accent ? '#d97706' : 'var(--color-text-primary, #0f172a)';
  return (
    <div>
      <div style={{ fontSize: 9.5, color: 'var(--color-text-tertiary, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: valColor }}>{value}</div>
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

function AgentDrawer({
  agentId,
  meta,
  summary,
  onClose,
}: {
  agentId: string;
  meta: AgentMeta;
  summary: AgentSummary | null;
  onClose: () => void;
}) {
  const statusColor = STATUS_COLORS[summary?.status ?? 'offline'] ?? '#94a3b8';
  const clusterColor = CLUSTER_COLORS[meta.cluster];

  return (
    <div style={drawerStyle}>
      <div style={drawerHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor }} />
          <span style={{ fontWeight: 700, fontSize: 14 }}>{meta.display}</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: clusterColor, background: `${clusterColor}18`, border: `1px solid ${clusterColor}40`, borderRadius: 4, padding: '1px 5px', textTransform: 'uppercase' }}>
            {meta.cluster === 'orgiq' ? 'OrgIQ' : 'Newsroom'}
          </span>
        </div>
        <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
      </div>

      <div style={drawerBodyStyle}>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary, #64748b)', lineHeight: 1.45 }}>
          {meta.description}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <DrawerKv label="Status" value={summary?.status ?? 'unknown'} />
          {summary?.protocol && <DrawerKv label="Protocol" value={summary.protocol.toUpperCase()} />}
          {summary?.model && <DrawerKv label="Model" value={summary.model} />}
          <DrawerKv label="Agent ID" value={agentId} mono />
        </div>

        <div>
          <SectionLabel>Metrics</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <BigMetric label="Calls"   value={fmtCount(summary?.invocationCount ?? 0)} />
            <BigMetric label="Errors"  value={String(summary?.errorCount ?? 0)} />
            <BigMetric label="p50"     value={fmtMs(summary?.p50Ms ?? null)} />
            <BigMetric label="p95"     value={fmtMs(summary?.p95Ms ?? null)} />
          </div>
        </div>

        {summary?.tools && summary.tools.length > 0 && (
          <div>
            <SectionLabel>Tools</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {summary.tools.map(t => (
                <span key={t} style={toolPillStyle}>{t}</span>
              ))}
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--color-border, #e2e8f0)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Link to={`/iq/invoke?agentId=${encodeURIComponent(agentId)}`} style={drawerLinkStyle}>
            Invoke this agent →
          </Link>
          <Link to="/iq/invoke?focus=sessions" style={drawerLinkStyle}>
            View invocation history →
          </Link>
        </div>
      </div>
    </div>
  );
}

function DrawerKv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: 'var(--color-text-tertiary, #94a3b8)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--color-text-primary, #0f172a)', fontWeight: 500, fontFamily: mono ? 'monospace' : 'inherit', textAlign: 'right', wordBreak: 'break-all', maxWidth: 180 }}>{value}</span>
    </div>
  );
}

function BigMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--color-bg, #f8fafc)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontSize: 9.5, color: 'var(--color-text-tertiary, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary, #0f172a)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-tertiary, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div style={legendStyle}>
      <div style={{ fontWeight: 700, fontSize: 10, color: 'var(--color-text-primary, #0f172a)', marginBottom: 5 }}>Edges</div>
      {[
        { color: '#10b981', label: '< 2% error' },
        { color: '#d97706', label: '2 – 10% error' },
        { color: '#dc2626', label: '> 10% error' },
        { color: '#cbd5e1', label: 'no traffic yet' },
      ].map(({ color, label }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5 }}>
          <span style={{ width: 16, height: 2.5, background: color, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ color: 'var(--color-text-secondary, #475569)' }}>{label}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, marginTop: 3 }}>
        <span style={{ width: 16, height: 0, borderTop: '2px dashed #94a3b8', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ color: 'var(--color-text-secondary, #475569)' }}>cross-cluster</span>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const summaryBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 16px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)',
  gap: 16,
  flexShrink: 0,
};

const windowBtnBase: React.CSSProperties = {
  padding: '3px 10px',
  fontSize: 11,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const windowBtnActive: React.CSSProperties = {
  ...windowBtnBase,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  borderColor: 'var(--color-primary, #6366f1)',
};

const drawerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  bottom: 12,
  width: 300,
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  boxShadow: '0 4px 20px rgba(15,23,42,0.10)',
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
  flexShrink: 0,
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
  gap: 12,
  overflowY: 'auto',
  flex: 1,
};

const toolPillStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '2px 7px',
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 999,
  color: 'var(--color-text-secondary, #475569)',
  fontFamily: 'monospace',
};

const drawerLinkStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
  fontWeight: 500,
};

const legendStyle: React.CSSProperties = {
  padding: '9px 12px',
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  boxShadow: '0 2px 8px rgba(15,23,42,0.05)',
};

export default AgentFlowPage;
