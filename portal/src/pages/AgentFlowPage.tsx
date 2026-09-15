// Architecture view — static A2A topology with live metrics overlaid.
// Uses fixed positions for the 9 known agents instead of a layout algorithm
// (which collapses all nodes to layer 0 when observability trace data is sparse).
// Live metrics from /api/topology/a2a are merged in once data arrives; the
// static topology always renders so the graph is meaningful from first load.

import { useEffect, useMemo, useState } from 'react';
import { MarkerType, type Node, type Edge } from '@xyflow/react';
import { Link, useSearchParams } from 'react-router';
import { Card, Chip, Drawer, Inline, InlineAlert, SegmentedControl, Stack, StatusDot } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { UnavailableNotice } from '../components/UnavailableNotice';
import { AgentFlowFrame, NODE_HEIGHT, NODE_WIDTH, STATUS_COLORS, fmtCount, fmtMs } from './AgentFlowFrame';
import { T } from './Text';

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

type Cluster = 'orgiq';

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
};

interface StaticEdgeDef { id: string; source: string; target: string }

const STATIC_EDGES: StaticEdgeDef[] = [
  { id: 'sup-search',    source: 'orgiq-supervisor',       target: 'orgiq-search' },
  { id: 'sup-scoring',   source: 'orgiq-supervisor',       target: 'orgiq-scoring' },
  { id: 'sup-advisor',   source: 'orgiq-supervisor',       target: 'orgiq-advisor' },
  { id: 'search-graph',  source: 'orgiq-search',           target: 'orgiq-graph-builder' },
  { id: 'scoring-graph', source: 'orgiq-scoring',          target: 'orgiq-graph-builder' },
  { id: 'adv-scoring',   source: 'orgiq-advisor',          target: 'orgiq-scoring' },
];

// ── Constants / helpers ───────────────────────────────────────────────────────

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
];

// Both id shapes reach this page: the AgentCore runtime id that observability
// records (orgiq_supervisor-UO5Xv95jsx, orgiq_graph_builder-…) and the plain
// agent name the static catalog is keyed by (orgiq-supervisor). Both must
// collapse to the same key or the metrics land under a key nothing looks up.
//
// The anchor is the runtime id's actual shape, not a bare 10-character class:
// an AgentCore runtime *name* may not contain a hyphen — the fleet spells its
// names with underscores — so the only hyphen in a runtime id is the one that
// introduces the generated 10-character suffix. A plain agent name is the
// mirror image: hyphens, never underscores.
//
// The old `-[A-Za-z0-9]{10}$` matched on length alone, and "supervisor" is
// exactly 10 alphanumerics, so it ate the last segment of the plain name too:
// orgiq-supervisor → "orgiq". That key matched no node and no edge, so the
// Supervisor node read calls 0 / err 0 / p95 —, and all of its edges rendered
// grey "no traffic yet", while the header counted the raw totals and said
// otherwise.
const RUNTIME_ID = /^([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)-[A-Za-z0-9]{10}$/;

function canonicalKey(id: string): string {
  const base = RUNTIME_ID.exec(id)?.[1] ?? id;
  return base.replace(/_/g, '-');
}

function edgeStroke(errorCount: number, callCount: number): string {
  if (callCount === 0) return 'var(--color-text-tertiary)';
  const r = errorCount / callCount;
  if (r >= 0.1) return 'var(--color-danger)';
  if (r >= 0.02) return 'var(--color-warning)';
  return 'var(--color-success)';
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

// ── Page ──────────────────────────────────────────────────────────────────────

function AgentFlowPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // ?cluster=orgiq | all (default = all) — a single-cluster fleet today, kept
  // as a filter param in case a second cluster returns.
  const clusterFilter = (searchParams.get('cluster') ?? 'all') as 'all' | 'orgiq';

  // ?window=1h|24h|7d — the URL is the source of truth, so the Architecture
  // sub-nav's window links and the in-page buttons drive the same thing and a
  // window choice survives copy-pasting the URL.
  const windowLabel = searchParams.get('window') ?? '24h';
  const windowHours = WINDOWS.find((w) => w.label === windowLabel)?.hours ?? 24;
  const setWindowLabel = (label: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('window', label);
      return next;
    }, { replace: true });
  };

  const { data: topology, error: topologyError } = useFetch<TopologyResponse>(
    `/api/topology/a2a?windowHours=${windowHours}`, 30_000,
  );
  // `/api/agents` answers `{ agents, degraded?, error? }`. It used to be a bare
  // array, which had nowhere to put a marker — so a failed ListAgentRuntimes
  // arrived here as an empty fleet and this page drew "0 / 9 online" over a
  // static architecture, which is a statement about the deployment rather than
  // an admission that we could not ask. That exact confusion has an incident
  // in CLAUDE.md.
  const {
    data: agentsResp, error: agentsError, degraded: agentsDegraded, refresh: refreshAgents,
  } = useFetch<{ agents: AgentDef[] }>('/api/agents', 30_000);
  const agents = agentsResp?.agents;
  const fleetFailure = agentsError ?? agentsDegraded;

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
        // A fixed-position (non-autolayout) graph never gets past xyflow's
        // pre-measurement `visibility: hidden` state on its own if the
        // ResizeObserver that's supposed to flip it never settles — every
        // node, and everything focusable inside it, stayed permanently
        // hidden and untabbable (DEFECTS.md #6). `initialWidth`/
        // `initialHeight` seed `hasDimensions` immediately; once the real
        // observer does fire, xyflow drops back to measuring the actual
        // DOM size (see AgentNodeComp's fixed w-[215px] card). Same
        // approach as distillation/CompactionFlowFrame.tsx.
        initialWidth: NODE_WIDTH,
        initialHeight: NODE_HEIGHT,
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
        labelBgStyle: { fill: 'var(--color-surface)', fillOpacity: 0.85 },
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
  // Summed over the canonicalized summaries, not the raw node array: the same
  // agent can arrive under both id shapes (and the provider can repeat a row),
  // so the raw sum double-counts and the header disagrees with the chips below
  // it. Summing the map means the header is exactly the total of what renders.
  const totalCalls  = Array.from(summaries.values()).reduce((s, n) => s + n.invocationCount, 0);
  const totalErrors = Array.from(summaries.values()).reduce((s, n) => s + n.errorCount, 0);
  const errRate = totalCalls > 0 ? `${((totalErrors / totalCalls) * 100).toFixed(1)}%` : '—';

  const selectedSummary = selectedId ? summaries.get(selectedId) ?? null : null;
  const selectedMeta    = selectedId ? AGENTS[selectedId] ?? null : null;

  return (
    <Stack gap="none" className="h-full w-full">
      {fleetFailure && (
        // The page is full-bleed with no content column, so the shared notice
        // is squared off into the same strip the topology alert uses. Same
        // component, same three things said: what failed, the server's own
        // error, and a retry.
        <UnavailableNotice
          error={fleetFailure}
          what="the agent fleet"
          source="Runtimes are listed from the AgentCore control plane"
          onRetry={refreshAgents}
          className="shrink-0 rounded-none border-x-0 border-t-0"
        />
      )}
      {topologyError && (
        <InlineAlert tone="error" className="shrink-0 rounded-none border-b py-2 text-[12px]">
          Live metrics unavailable — {topologyError}. Showing the static architecture; the call/error overlay needs the observability permission (org-leader or HR Admin).
        </InlineAlert>
      )}
      {/* ── Summary bar ── */}
      <Inline align="center" justify="between" gap="md" className="shrink-0 border-b border-border bg-surface px-4 py-2.5">
        <Inline align="center" gap="lg">
          <SummaryKV
            label="Agents"
            value={fleetFailure ? '— online' : `${onlineCount} / ${Object.keys(AGENTS).length} online`}
          />
          <SummaryKV label={`Calls (${windowHours < 24 ? windowHours + 'h' : windowHours === 24 ? '24h' : '7d'})`} value={topologyError ? '—' : fmtCount(totalCalls)} />
          <SummaryKV label="Errors" value={topologyError ? '—' : fmtCount(totalErrors)} accent={!topologyError && totalErrors > 0 ? 'warn' : undefined} />
          <SummaryKV label="Err rate" value={topologyError ? '—' : errRate} accent={!topologyError && totalErrors > 0 ? 'warn' : undefined} />
          {topology?.generatedAt && (
            <T className="text-[10.5px] text-text-tertiary">
              Refreshed {new Date(topology.generatedAt).toLocaleTimeString()}
            </T>
          )}
        </Inline>
        <Inline align="center" gap="xs">
          <T className="text-[11px] text-text-secondary">Window</T>
          {/* One setting with three values, not three buttons — and the only
              place it lives now that the Architecture rail is gone. */}
          <SegmentedControl
            size="sm"
            aria-label="Traffic window"
            value={windowLabel}
            onChange={setWindowLabel}
            options={WINDOWS.map((w) => ({ label: w.label, value: w.label }))}
          />
        </Inline>
      </Inline>

      {/* ── Canvas ── */}
      <Stack gap="none" className="relative min-h-0 flex-1">
        <AgentFlowFrame nodes={rfNodes} edges={rfEdges} onPaneClick={() => setSelectedId(null)} />

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
      </Stack>
    </Stack>
  );
}

// ── Summary bar helpers ───────────────────────────────────────────────────────

function SummaryKV({ label, value, accent }: { label: string; value: string; accent?: 'warn' }) {
  const valColor = accent ? 'text-warning' : 'text-text-primary';
  return (
    <Stack gap="none">
      <T className="text-[9.5px] uppercase tracking-wider text-text-tertiary">{label}</T>
      <T className={`text-[13px] font-semibold ${valColor}`}>{value}</T>
    </Stack>
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
  const statusColor = STATUS_COLORS[summary?.status ?? 'offline'] ?? 'var(--color-text-tertiary)';

  return (
    <Stack gap="md" className="px-3.5 py-3">
      <Inline align="center" gap="sm">
        <StatusDot color={statusColor} size="sm" />
        {/* Every agent today is in the one `orgiq` cluster (CLUSTER_COLORS in
            AgentFlowFrame.tsx has a single entry) — a fixed semantic tone
            reads the same as that cluster's indigo swatch without a computed
            `style` object per render. */}
        <Chip size="xs" uppercase tone="accent">Org</Chip>
      </Inline>

      <T className="block text-[11.5px] leading-[1.45] text-text-secondary">
        {meta.description}
      </T>

      <Stack gap="xs">
        <DrawerKv label="Status" value={summary?.status ?? 'unknown'} />
        {summary?.protocol && <DrawerKv label="Protocol" value={summary.protocol.toUpperCase()} />}
        {summary?.model && <DrawerKv label="Model" value={summary.model} />}
        <DrawerKv label="Agent ID" value={agentId} mono />
      </Stack>

      <Stack gap="sm">
        <SectionLabel>Metrics</SectionLabel>
        <Stack gap="sm">
          <Inline gap="sm">
            <BigMetric label="Calls"  value={fmtCount(summary?.invocationCount ?? 0)} />
            <BigMetric label="Errors" value={String(summary?.errorCount ?? 0)} />
          </Inline>
          <Inline gap="sm">
            <BigMetric label="p50" value={fmtMs(summary?.p50Ms ?? null)} />
            <BigMetric label="p95" value={fmtMs(summary?.p95Ms ?? null)} />
          </Inline>
        </Stack>
      </Stack>

      {summary?.tools && summary.tools.length > 0 && (
        <Stack gap="sm">
          <SectionLabel>Tools</SectionLabel>
          <Inline wrap gap="xs">
            {summary.tools.map(t => (
              <Chip key={t} tone="neutral" size="xs" mono>{t}</Chip>
            ))}
          </Inline>
        </Stack>
      )}

      <Stack gap="sm" className="border-t border-border pt-2.5">
        {/* The drawer is a summary; this is where the depth lives — prompt
            version in force, recent call timings, and the runtime's log.
            "View invocation history" used to point at /iq/invoke, which is the
            chat page: it answered a different question than the one being
            asked, from a panel about one specific agent. */}
        <Link
          to={`/iq/agents/${encodeURIComponent(agentId)}`}
          className="text-xs font-medium text-primary no-underline"
        >
          Open agent details →
        </Link>
        <Link
          to={`/iq/invoke?agentId=${encodeURIComponent(agentId)}`}
          className="text-xs font-medium text-primary no-underline"
        >
          Invoke this agent →
        </Link>
      </Stack>
    </Stack>
  );
}

function DrawerKv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Inline justify="between" gap="sm" className="py-0.5 text-xs">
      <T className="shrink-0 text-text-tertiary">{label}</T>
      <T className={`max-w-[180px] break-all text-right font-medium text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</T>
    </Inline>
  );
}

function BigMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="none" className="flex-1 rounded-md border border-border bg-surface-inset px-2.5 py-2">
      <T className="block text-[9.5px] uppercase tracking-wider text-text-tertiary">{label}</T>
      <T className="mt-0.5 block text-[15px] font-bold text-text-primary">{value}</T>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <T className="block text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
      {children}
    </T>
  );
}

export default AgentFlowPage;
