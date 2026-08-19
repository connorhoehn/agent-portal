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
import { Drawer } from '@connorhoehnslalom/ui-components/shared';
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
      className="bg-surface rounded-[10px] py-2.5 px-3.5 w-[215px] cursor-pointer select-none shadow-[0_2px_8px_rgba(15,23,42,0.07)]"
      style={{ border: `2px solid ${statusColor}` }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      {/* Header row */}
      <div className="flex items-center gap-1.5 mb-[5px]">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor }} />
        <span className="font-bold text-[13px] flex-1 text-text-primary">
          {meta.display}
        </span>
        <span
          className="text-[9px] font-bold rounded uppercase tracking-wide px-[5px] py-px"
          style={{ color: clusterColor, background: `${clusterColor}18`, border: `1px solid ${clusterColor}40` }}
        >
          {meta.cluster === 'orgiq' ? 'OrgIQ' : 'Newsroom'}
        </span>
      </div>

      {/* Description */}
      <div className="text-[10px] text-text-tertiary mb-[9px] leading-[1.35]">
        {meta.description}
      </div>

      {/* Metric chips */}
      <div className="flex gap-1">
        <MetricChip label="calls"  value={fmtCount(summary?.invocationCount ?? 0)} />
        <MetricChip label="err"    value={String(summary?.errorCount ?? 0)} accent={(summary?.errorCount ?? 0) > 0 ? 'warn' : undefined} />
        <MetricChip label="p95"    value={fmtMs(summary?.p95Ms ?? null)} />
      </div>
    </div>
  );
}

function MetricChip({ label, value, accent }: { label: string; value: string; accent?: 'warn' | 'danger' }) {
  const accentClass = accent === 'danger' ? 'text-danger' : accent === 'warn' ? 'text-warning' : 'text-text-primary';
  return (
    <div className="flex-1 bg-surface-inset border border-border rounded py-[3px] px-1 text-center">
      <div className="text-[9px] text-text-tertiary leading-tight">{label}</div>
      <div className={`text-[11px] font-semibold leading-[1.3] ${accentClass}`}>{value}</div>
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
    <div className="w-full h-full flex flex-col">
      {/* ── Summary bar ── */}
      <div className="flex items-center justify-between py-2.5 px-4 border-b border-border bg-surface gap-4 shrink-0">
        <div className="flex items-center gap-5">
          <SummaryKV label="Agents" value={`${onlineCount} / ${Object.keys(AGENTS).length} online`} />
          <SummaryKV label={`Calls (${windowHours < 24 ? windowHours + 'h' : windowHours === 24 ? '24h' : '7d'})`} value={fmtCount(totalCalls)} />
          <SummaryKV label="Errors" value={fmtCount(totalErrors)} accent={totalErrors > 0 ? 'warn' : undefined} />
          <SummaryKV label="Err rate" value={errRate} accent={totalErrors > 0 ? 'warn' : undefined} />
          {topology?.generatedAt && (
            <span className="text-[10.5px] text-text-tertiary">
              Refreshed {new Date(topology.generatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-text-secondary">Window</span>
          {WINDOWS.map(w => {
            const active = w.hours === windowHours;
            return (
              <button
                key={w.hours}
                onClick={() => setWindowHours(w.hours)}
                className={
                  active
                    ? 'py-[3px] px-2.5 text-[11px] rounded border bg-primary text-white border-primary cursor-pointer font-[inherit]'
                    : 'py-[3px] px-2.5 text-[11px] rounded border border-border bg-transparent text-text-secondary cursor-pointer font-[inherit]'
                }
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div className="flex-1 min-h-0 relative">
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

        {selectedMeta && (
          <Drawer
            open={selectedId != null}
            onClose={() => setSelectedId(null)}
            title={selectedMeta.display}
            width={520}
          >
            <AgentDrawerBody
              agentId={selectedId ?? ''}
              meta={selectedMeta}
              summary={selectedSummary}
            />
          </Drawer>
        )}
      </div>
    </div>
  );
}

// ── Summary bar helpers ───────────────────────────────────────────────────────

function SummaryKV({ label, value, accent }: { label: string; value: string; accent?: 'warn' }) {
  const valColor = accent ? 'text-warning' : 'text-text-primary';
  return (
    <div>
      <div className="text-[9.5px] text-text-tertiary uppercase tracking-wider">{label}</div>
      <div className={`text-[13px] font-semibold ${valColor}`}>{value}</div>
    </div>
  );
}

// ── Drawer body ───────────────────────────────────────────────────────────────

function AgentDrawerBody({
  agentId,
  meta,
  summary,
}: {
  agentId: string;
  meta: AgentMeta;
  summary: AgentSummary | null;
}) {
  const statusColor = STATUS_COLORS[summary?.status ?? 'offline'] ?? '#94a3b8';
  const clusterColor = CLUSTER_COLORS[meta.cluster];

  return (
    <div className="py-3 px-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: statusColor }} />
        <span
          className="text-[9px] font-bold rounded uppercase px-[5px] py-px"
          style={{ color: clusterColor, background: `${clusterColor}18`, border: `1px solid ${clusterColor}40` }}
        >
          {meta.cluster === 'orgiq' ? 'OrgIQ' : 'Newsroom'}
        </span>
      </div>

      <div className="text-[11.5px] text-text-secondary leading-[1.45]">
        {meta.description}
      </div>

      <div className="flex flex-col gap-[3px]">
        <DrawerKv label="Status" value={summary?.status ?? 'unknown'} />
        {summary?.protocol && <DrawerKv label="Protocol" value={summary.protocol.toUpperCase()} />}
        {summary?.model && <DrawerKv label="Model" value={summary.model} />}
        <DrawerKv label="Agent ID" value={agentId} mono />
      </div>

      <div>
        <SectionLabel>Metrics</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <BigMetric label="Calls"   value={fmtCount(summary?.invocationCount ?? 0)} />
          <BigMetric label="Errors"  value={String(summary?.errorCount ?? 0)} />
          <BigMetric label="p50"     value={fmtMs(summary?.p50Ms ?? null)} />
          <BigMetric label="p95"     value={fmtMs(summary?.p95Ms ?? null)} />
        </div>
      </div>

      {summary?.tools && summary.tools.length > 0 && (
        <div>
          <SectionLabel>Tools</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {summary.tools.map(t => (
              <span
                key={t}
                className="text-[10px] py-0.5 px-[7px] bg-surface-inset border border-border rounded-full text-text-secondary font-mono"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border pt-2.5 flex flex-col gap-1.5">
        {/* The drawer is a summary; this is where the depth lives — prompt
            version in force, recent call timings, and the runtime's log.
            "View invocation history" used to point at /iq/invoke, which is the
            chat page: it answered a different question than the one being
            asked, from a panel about one specific agent. */}
        <Link
          to={`/iq/agents/${encodeURIComponent(agentId)}`}
          className="text-xs text-primary no-underline font-medium"
        >
          Open agent details →
        </Link>
        <Link
          to={`/iq/invoke?agentId=${encodeURIComponent(agentId)}`}
          className="text-xs text-primary no-underline font-medium"
        >
          Invoke this agent →
        </Link>
      </div>
    </div>
  );
}

function DrawerKv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 text-xs py-0.5">
      <span className="text-text-tertiary shrink-0">{label}</span>
      <span
        className={`text-text-primary font-medium text-right break-all max-w-[180px] ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function BigMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-inset border border-border rounded-md py-2 px-2.5">
      <div className="text-[9.5px] text-text-tertiary uppercase tracking-wider">{label}</div>
      <div className="text-[15px] font-bold text-text-primary mt-0.5">{value}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider mb-2">
      {children}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="py-[9px] px-3 bg-surface border border-border rounded-md flex flex-col gap-1 shadow-[0_2px_8px_rgba(15,23,42,0.05)]">
      <div className="font-bold text-[10px] text-text-primary mb-[5px]">Edges</div>
      {[
        { color: '#10b981', label: '< 2% error' },
        { color: '#d97706', label: '2 – 10% error' },
        { color: '#dc2626', label: '> 10% error' },
        { color: '#cbd5e1', label: 'no traffic yet' },
      ].map(({ color, label }) => (
        <div key={label} className="flex items-center gap-1.5 text-[10.5px]">
          <span
            className="inline-block w-4 h-[2.5px] rounded shrink-0"
            style={{ background: color }}
          />
          <span className="text-text-secondary">{label}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5 text-[10.5px] mt-[3px]">
        <span className="inline-block w-4 h-0 border-t-2 border-dashed border-text-tertiary shrink-0" />
        <span className="text-text-secondary">cross-cluster</span>
      </div>
    </div>
  );
}

export default AgentFlowPage;
