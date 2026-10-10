// Architecture view — static A2A topology with live metrics overlaid.
// Uses fixed positions for the 9 known agents instead of a layout algorithm
// (which collapses all nodes to layer 0 when observability trace data is sparse).
// Live metrics from /api/topology/a2a are merged in once data arrives; the
// static topology always renders so the graph is meaningful from first load.

import { useEffect, useMemo, useState } from 'react';
import { relativeTime } from '../lib/relativeTime';
import { MarkerType, type Node, type Edge } from '@xyflow/react';
import { Link, useSearchParams } from 'react-router';
import {
  Chip, DataTable, Drawer, EmptyState, Inline, InlineAlert, Input, SectionLabel,
  SegmentedControl, Stack, StatStrip, StatusDot, VisuallyHidden, type DataTableColumn, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { UnavailableNotice } from '../components/UnavailableNotice';
import { KeyValue } from '../components/KeyValue';
import { AgentFlowFrame, NODE_HEIGHT, NODE_WIDTH, STATUS_COLORS, fmtCount, fmtMs } from './AgentFlowFrame';
import { canonicalKey, fleetRows, filterFleet, offDiagramCount, onlineLabel, STATUS_TONE, type FleetRow } from './agentFleetRows';

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

// canonicalKey (id-shape normalizer) now lives in agentFleetRows.ts, exported,
// so InvokePage's `?agentId=` deep-link resolver can share it instead of
// guessing at a third spelling of the same agent.

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

  // ?view=diagram|list. The diagram is the page's identity and stays the
  // default; the list is the half that can show an agent the diagram has no
  // coordinates for. Both live in the URL so a link carries which one you
  // meant, like every other lens on this app.
  const view = searchParams.get('view') === 'list' ? 'list' : 'diagram';
  const setView = (next: string) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'diagram') p.delete('view'); else p.set('view', next);
      return p;
    }, { replace: true });
  };
  const [fleetQuery, setFleetQuery] = useState('');

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
        // DOM size (see AgentNodeComp's fixed w-[215px] card).
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

  // Summary bar totals.
  //
  // The fleet is whatever /api/agents returned (plus anything the topology saw
  // that it did not), NOT the static diagram catalog. `Object.keys(AGENTS)`
  // used to be the denominator here, so a fleet of nine runtimes reported
  // "6/6 online" and the three the diagram cannot place were invisible on the
  // one page about the fleet. See agentFleetRows.ts.
  const displayNames = useMemo(
    () => new Map(Object.entries(AGENTS).map(([id, m]) => [id, m.display])),
    [],
  );
  const rows = useMemo(() => fleetRows(summaries, displayNames), [summaries, displayNames]);
  const visibleRows = useMemo(() => filterFleet(rows, fleetQuery), [rows, fleetQuery]);
  const offDiagram = offDiagramCount(rows);
  const online = onlineLabel(rows, Boolean(fleetFailure));
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
      {/* This page is a full-bleed canvas — the summary bar IS its frame, so
          there is no PageSection title block like every other surface has.
          That left it as the only route (with Computer Lab) whose document
          outline had no `h1` at all: the breadcrumb is a nav landmark, not a
          heading, so a screen reader arriving here was told the page's name
          by nothing. A visually-hidden heading restores the outline without
          adding chrome the diagram does not want. */}
      <VisuallyHidden as="h1">Architecture</VisuallyHidden>
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
          {/* The library's tiles, frameless because the bar is the frame —
              this page used to draw its own label-over-value pairs. */}
          <StatStrip
            frameless
            aria-label="Fleet summary"
            items={[
              { label: 'Online', value: online ?? '—', ...(online === null ? { hint: 'unknown' } : {}) },
              { label: `Calls (${windowHours < 24 ? windowHours + 'h' : windowHours === 24 ? '24h' : '7d'})`, value: topologyError ? '—' : fmtCount(totalCalls) },
              { label: 'Errors', value: topologyError ? '—' : fmtCount(totalErrors), tone: !topologyError && totalErrors > 0 ? 'danger' : 'default' },
              { label: 'Err rate', value: topologyError ? '—' : errRate, tone: !topologyError && totalErrors > 0 ? 'danger' : 'default' },
            ]}
          />
          {topology?.generatedAt && (
            <T className="text-[10.5px] text-text-tertiary">
              Refreshed {relativeTime(topology.generatedAt)}
            </T>
          )}
        </Inline>
        <Inline align="center" gap="md">
          <Inline align="center" gap="xs">
            <T className="text-[11px] text-text-secondary">View</T>
            <SegmentedControl
              size="sm"
              aria-label="Fleet view"
              value={view}
              onChange={setView}
              options={[
                { label: 'Diagram', value: 'diagram' },
                { label: 'List', value: 'list' },
              ]}
            />
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
      </Inline>

      {/* The diagram is drawn from fixed coordinates, so it can only show the
          agents it has coordinates for. Rather than let that omission pass
          silently — which is how three runtimes went missing — say what is
          not on it and offer the view that shows everything. */}
      {view === 'diagram' && offDiagram > 0 && (
        <InlineAlert tone="info" className="shrink-0 rounded-none border-b py-2 text-[12px]">
          {offDiagram === 1 ? '1 agent is' : `${offDiagram} agents are`} not on this
          diagram — it is positioned by hand and has no place for
          {offDiagram === 1 ? ' it' : ' them'}. Switch to List to see the whole fleet.
        </InlineAlert>
      )}

      {/* ── Canvas ── */}
      <Stack gap="none" className="relative min-h-0 flex-1">
        {view === 'list' ? (
          <FleetList rows={visibleRows} total={rows.length} query={fleetQuery} onQuery={setFleetQuery} />
        ) : (
        <AgentFlowFrame nodes={rfNodes} edges={rfEdges} onPaneClick={() => setSelectedId(null)} />
        )}

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


// ── List view ─────────────────────────────────────────────────────────────────

/**
 * The whole fleet as a table — every runtime the control plane returned,
 * including the ones the hand-positioned diagram has no coordinates for. Rows
 * link to the agent's own page rather than opening the diagram's drawer,
 * because that drawer is keyed on the static catalog and has nothing to say
 * about an agent outside it.
 */
function FleetList({
  rows,
  total,
  query,
  onQuery,
}: {
  rows: FleetRow[];
  total: number;
  query: string;
  onQuery: (q: string) => void;
}) {
  const columns: DataTableColumn<FleetRow>[] = [
    {
      key: 'name',
      header: 'Agent',
      sortable: true,
      render: (r) => (
        // The chip sits on the id's line, not the name's. Beside the name it
        // wrapped for the longer agents ("Assessment Drafter") and landed
        // between the name and its own id, which read as a third field.
        <Stack gap="none">
          <Link
            to={`/iq/agents/${encodeURIComponent(r.id)}`}
            className="text-[13px] font-semibold text-text-primary no-underline hover:text-primary hover:underline"
          >
            {r.name}
          </Link>
          <Inline gap="xs" align="center" wrap>
            <T className="font-mono text-[10.5px] text-text-tertiary">{r.id}</T>
            {!r.onDiagram && (
              <Chip size="xs" tone="neutral" title="This agent has no position on the architecture diagram">
                not on diagram
              </Chip>
            )}
          </Inline>
        </Stack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => <Chip size="xs" dot="static" tone={STATUS_TONE[r.status]}>{r.status}</Chip>,
    },
    {
      key: 'model',
      header: 'Model',
      render: (r) => (
        <T className="font-mono text-[11px] text-text-secondary">{r.model || '—'}</T>
      ),
    },
    {
      key: 'protocol',
      header: 'Protocol',
      render: (r) => (
        <T className="text-[11px] text-text-secondary">{r.protocol ? r.protocol.toUpperCase() : '—'}</T>
      ),
    },
    {
      key: 'invocationCount',
      header: 'Calls',
      align: 'right',
      sortable: true,
      render: (r) => <T className="tabular-nums text-[12px]">{fmtCount(r.invocationCount)}</T>,
    },
    {
      key: 'errorCount',
      header: 'Errors',
      align: 'right',
      sortable: true,
      render: (r) => (
        <T className={`tabular-nums text-[12px] ${r.errorCount > 0 ? 'text-danger' : 'text-text-tertiary'}`}>
          {fmtCount(r.errorCount)}
        </T>
      ),
    },
    {
      key: 'p50Ms',
      header: 'p50',
      align: 'right',
      render: (r) => <T className="tabular-nums text-[12px] text-text-secondary">{fmtMs(r.p50Ms)}</T>,
    },
    {
      key: 'p95Ms',
      header: 'p95',
      align: 'right',
      render: (r) => <T className="tabular-nums text-[12px] text-text-secondary">{fmtMs(r.p95Ms)}</T>,
    },
    {
      key: 'tools',
      header: 'Tools',
      render: (r) => (
        r.tools.length === 0
          ? <T className="text-[11px] text-text-tertiary">—</T>
          : (
            <Inline wrap gap="xs">
              {r.tools.slice(0, 3).map((t) => (
                <Chip key={t} size="xs" tone="neutral" mono>{t}</Chip>
              ))}
              {r.tools.length > 3 && (
                <T className="text-[10.5px] text-text-tertiary">+{r.tools.length - 3}</T>
              )}
            </Inline>
          )
      ),
    },
  ];

  return (
    <Stack gap="sm" className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <Inline align="center" justify="between" gap="sm">
        <Input
          size="sm"
          type="search"
          aria-label="Filter agents"
          placeholder="Filter by name, id, model or tool"
          value={query}
          onChange={(e) => onQuery(e.currentTarget.value)}
          className="max-w-[320px]"
        />
        <T className="text-[11px] text-text-tertiary">
          {rows.length === total ? `${total} agents` : `${rows.length} of ${total} agents`}
        </T>
      </Inline>
      {rows.length === 0 ? (
        <EmptyState
          title={total === 0 ? 'No agents deployed' : 'No agent matches that filter'}
          description={
            total === 0
              ? 'The control plane returned an empty fleet. Deploy the runtimes, then reload.'
              : 'Clear the filter to see the whole fleet.'
          }
        />
      ) : (
        <DataTable<FleetRow>
          data={rows}
          keyField={(r) => r.key}
          striped
          columns={columns}
          emptyMessage="No agents."
        />
      )}
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
        <Chip size="xs" uppercase tone="accent">Work</Chip>
      </Inline>

      <T className="block text-[11.5px] leading-[1.45] text-text-secondary">
        {meta.description}
      </T>

      <Stack gap="xs">
        <KeyValue layout="row" label="Status" value={summary?.status ?? 'unknown'} />
        {summary?.protocol && <KeyValue layout="row" label="Protocol" value={summary.protocol.toUpperCase()} />}
        {summary?.model && <KeyValue layout="row" label="Model" value={summary.model} />}
        <KeyValue layout="row" label="Agent ID" value={agentId} mono />
      </Stack>

      <Stack gap="sm">
        <SectionLabel as="div">Metrics</SectionLabel>
        <StatStrip
          aria-label="Agent metrics"
          items={[
            { label: 'Calls', value: fmtCount(summary?.invocationCount ?? 0) },
            { label: 'Errors', value: String(summary?.errorCount ?? 0), tone: (summary?.errorCount ?? 0) > 0 ? 'danger' : 'default' },
            { label: 'p50', value: fmtMs(summary?.p50Ms ?? null) },
            { label: 'p95', value: fmtMs(summary?.p95Ms ?? null) },
          ]}
        />
      </Stack>

      {summary?.tools && summary.tools.length > 0 && (
        <Stack gap="sm">
          <SectionLabel as="div">Tools</SectionLabel>
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

export default AgentFlowPage;
