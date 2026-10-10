// Distillation → Activity (spec §1): is new work being turned into useful
// knowledge?
//
//   top     "Compaction activity" · Runs | Tier graph · replica status ·
//           Compact L0→L1 / L1→L2 (ManageBots) · the health status line
//           (Banner, from the server's verdicts — never inferred) · the
//           tier-flow StatStrip with Compact / Compact / Publish connectors
//   runs    ListRailLayout (docs/layout-cascade.md): the runs are a flush
//           list rail beside the module's section rail ("RUNS 12", filter
//           popover: transformation, status, repository); the content column
//           after it opens with the trail and the title, then the health line,
//           the tier-flow strip and the run inspector
//   graph   SectionContent: the tier graph (TypedNodeCanvas + its
//           CanvasZoomControls) and the run inspector in CanvasPaneLayout
//
// `?view=runs|graph` and `?run=` are both kept when switching views; the
// live `distill:levels` / `distill:jobs` channels patch the snapshots.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router';
import type { DistillationOutletContext } from './DistillationModule';
import {
  CanvasPaneLayout, TypedNodeCanvas, WorkListFilters, type TypedCanvasNode,
  ListRailLayout,
} from '@connorhoehnslalom/ui-components';
import {
  Banner, Button, EmptyState, FilterPopover, GroupedList, Inline, LoadingState, SegmentedControl, Stack,
  StatCard, StatStrip, StatusPill, T, type StatStripItem,
} from '@connorhoehnslalom/ui-components/shared';
import { SECTION_CANVAS_FRAME, SectionContent, SectionHeader } from '../../components/shell/SectionContent';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import {
  RUN_GROUPS, edgeDetail, filterRuns, replicationLine, runRows,
} from './activityModel';
import { activityHref, parseActivity, type ActivityState } from './distillationRoutes';
import { RunInspector } from './RunInspector';
import { tierGraph, type GraphNode, type TierNodeData } from './sourcesModel';
import { tierFlowModel } from './tierFlowModel';
import type {
  ArtifactsResponse, CompactableLevel, CompactionRun, ReplicationResponse, TierLevelsResponse,
} from './types';

interface JobsSnapshot { jobs: CompactionRun[] }

type TierCanvasNode = TypedCanvasNode<string, GraphNode<TierNodeData>['data']>;

const STATUS_FILTERS = [
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

function TierNode({ node, selected }: { node: TierCanvasNode; selected: boolean }) {
  const d = node.data;
  return (
    // The count is a stat, so it is the library StatCard's value (branding:
    // pages must not size their own numbers/titles); the ring marks selection.
    <Stack gap="xs" className={selected ? 'h-full rounded-lg ring-2 ring-primary' : 'h-full'}>
      <StatCard
        label={`${d.level ?? 'Publish'} · ${d.title}`}
        value={d.value == null ? '—' : d.value}
        hint={(
          <Stack gap="xs">
            {d.status && <StatusPill tone={d.status.tone === 'danger' ? 'error' : d.status.tone === 'warning' ? 'warning' : d.status.tone === 'info' ? 'info' : 'neutral'} label={d.status.label} size="sm" />}
            <T className="text-[12px] text-primary">{node.kind === 'library' ? 'Open Agent library →' : `Browse ${d.title.toLowerCase()} →`}</T>
          </Stack>
        )}
      />
    </Stack>
  );
}

export default function ActivityTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = parseActivity(location.search);
  const stateRef = useRef(state);
  stateRef.current = state;
  const go = useCallback((patch: Partial<ActivityState>, opts: { push?: boolean } = {}) => {
    navigate(activityHref({ ...stateRef.current, ...patch }), { replace: !opts.push });
  }, [navigate]);

  const { can, ready } = useCapabilities();
  const canCompact = ready && can('ManageBots');

  const levels = useDistillationChannel<TierLevelsResponse>('distill:levels');
  // Offline (no socket) a queued or running job is polled fast so its row
  // moves; with the live channel frames do that and the poll is off.
  const [fast, setFast] = useState(false);
  const jobsFeed = useDistillationChannel<JobsSnapshot>('distill:jobs', { pollMs: fast ? 2_000 : 15_000 });
  const jobs = useMemo(() => jobsFeed.data?.jobs ?? [], [jobsFeed.data]);
  const anyRunning = jobs.some((j) => j.status === 'running' || j.status === 'queued');
  useEffect(() => { setFast(anyRunning); }, [anyRunning]);
  // When the last active job settles, the tiers it wrote have moved: re-read
  // them here and in the module header (its Activity dot) instead of waiting
  // out a 15s poll with a stale "behind".
  const moduleCtx = useOutletContext<DistillationOutletContext | undefined>();
  const wasRunning = useRef(false);
  const refreshLevels = levels.refresh;
  useEffect(() => {
    if (wasRunning.current && !anyRunning) {
      refreshLevels();
      moduleCtx?.refreshLevels();
    }
    wasRunning.current = anyRunning;
  }, [anyRunning, refreshLevels, moduleCtx]);
  const replication = useFetch<ReplicationResponse>('/api/distillation/replication', 30_000);
  // The Library node's count: guides actually linked to a Library asset.
  const artifacts = useFetch<ArtifactsResponse>('/api/distillation/artifacts', 60_000);
  const linked = artifacts.data ? artifacts.data.artifacts.filter((a) => a.library_item_id).length : null;

  const flow = useMemo(
    () => tierFlowModel(levels.data?.levels ?? [], linked, { legacyHealth: levels.data?.health }),
    [levels.data, linked],
  );
  const nowMs = Date.now();
  const visibleJobs = useMemo(() => filterRuns(jobs, state), [jobs, state.level, state.status, state.repo]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => runRows(visibleJobs, nowMs), [visibleJobs]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = jobs.find((j) => j.id === state.run) ?? null;
  const rep = replicationLine(replication.data);

  const [busy, setBusy] = useState<CompactableLevel | null>(null);
  const compact = useCallback(async (level: CompactableLevel) => {
    if (busy) return;
    setBusy(level);
    const tid = toastPending(`Compacting ${level === 'L1' ? 'run notes → patterns' : 'patterns → guides'}`);
    try {
      const res = await fetch('/api/distillation/compact', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, ...(stateRef.current.repo ? { repo: stateRef.current.repo } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as CompactionRun & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      jobsFeed.setData((prev) => ({ jobs: [body, ...(prev?.jobs ?? []).filter((j) => j.id !== body.id)] }));
      toastSuccess(tid, body.status === 'succeeded' ? 'Compaction complete' : 'Compaction queued', 'Follow it in the run inspector.');
      go({ run: body.id });
      jobsFeed.refresh();
    } catch (err) {
      toastError(tid, 'Compaction failed to start', err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }, [busy, jobsFeed, go]);

  const stripItems: StatStripItem[] = flow.items.map((i) => ({
    label: i.level ? `${i.level} ${i.label}` : i.label,
    value: i.value == null ? '—' : i.value,
    status: i.status ? { label: i.status.label, tone: i.status.tone } : null,
    title: i.reason ?? i.ariaLabel,
    onSelect: () => navigate(i.href),
  }));

  // ── Tier graph ─────────────────────────────────────────────────────────
  const graph = useMemo(() => tierGraph(flow, jobs), [flow, jobs]);
  const canvasNodes = useMemo<TierCanvasNode[]>(
    () => graph.nodes.map((n) => ({ id: n.id, kind: n.kind, rank: n.rank, data: n.data, label: n.data.title })),
    [graph],
  );
  const canvasEdges = useMemo(() => {
    const now = Date.now();
    return graph.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      tone: e.tone,
      // Only a job the server confirms is running moves (tierGraph).
      animated: e.animated === true,
      marker: e.marker ? { label: `${e.label ?? 'Job'}: ${e.marker.label}`, tone: e.marker.tone } : null,
      detail: e.id === 'L0->L1' ? edgeDetail(jobs, 'L1', now) : e.id === 'L1->L2' ? edgeDetail(jobs, 'L2', now) : undefined,
    }));
  }, [graph, jobs]);
  const selectedEdge = selected ? (selected.level === 'L2' ? 'L1->L2' : 'L0->L1') : null;

  const selectEdge = (edgeId: string) => {
    const edge = graph.edges.find((e) => e.id === edgeId);
    if (edge?.marker) { go({ run: edge.marker.id }); return; }
    // No live job on the edge: the line opens its most recent run.
    const level = edgeId === 'L0->L1' ? 'L1' : edgeId === 'L1->L2' ? 'L2' : null;
    const latest = level ? runRows(jobs.filter((j) => j.level === level), nowMs)[0] : undefined;
    if (latest) go({ run: latest.id });
  };

  // Under the page title: the tier-health line and the tier flow strip.
  const summary = (
    <Stack gap="sm" className="shrink-0">
      {flow.attention && (
        <Banner
          variant={flow.attention.tone === 'danger' ? 'error' : 'warning'}
          title={flow.attention.title}
          layout="inline"
          action={(
            <Button size="sm" variant="secondary" onClick={() => go({ view: 'runs', level: flow.attention!.level === 'L0' ? null : flow.attention!.level as 'L1' | 'L2' })}>
              View runs →
            </Button>
          )}
          data-testid="activity-status-line"
        >
          {flow.attention.detail}
        </Banner>
      )}
      {levels.error ? (
        <UnavailableNotice error={levels.error} what="tier health" source="Tier counts are read from Aurora" onRetry={levels.refresh} />
      ) : (
        <StatStrip items={stripItems} connectors={flow.connectors.map((c) => ({ label: c.label, tone: c.tone }))} aria-label="Tier flow" data-testid="tier-flow" />
      )}
    </Stack>
  );

  const runFacets = [
    {
      id: 'level', label: 'Transformation',
      options: [{ value: 'L1', label: 'Run notes → Patterns' }, { value: 'L2', label: 'Patterns → Guides' }],
      selected: state.level ? [state.level] : [],
      onChange: (sel: string[]) => { const v = sel[sel.length - 1]; go({ level: v === 'L1' || v === 'L2' ? v : null }); },
    },
    {
      id: 'status', label: 'Status',
      options: STATUS_FILTERS,
      selected: state.status ? [state.status] : [],
      onChange: (sel: string[]) => go({ status: sel[sel.length - 1] ?? null }),
    },
    ...(moduleCtx ? [moduleCtx.scope.repoFacet] : []),
  ];
  const runsHeader = (
    <Inline gap="xs" align="center" justify="between" wrap={false}>
      <T className="text-[12px] text-text-tertiary">{rows.length} of {jobs.length} runs{state.level || state.status || state.repo ? ' match the filters' : ''}</T>
      <FilterPopover
        trigger="icon"
        size="sm"
        label="Filter runs"
        activeCount={[state.level, state.status, state.repo].filter(Boolean).length}
        onClear={() => { go({ level: null, status: null }); if (state.repo) moduleCtx?.scope.repoFacet.onChange([]); }}
        panelLabel="Filter runs"
      >
        <WorkListFilters facets={runFacets} data-testid="activity-filters" />
      </FilterPopover>
    </Inline>
  );
  const runsList = jobsFeed.error ? (
    <Stack className="px-5 py-3">
      <UnavailableNotice error={jobsFeed.error} what="compaction history" source="Compaction jobs are read from Aurora" onRetry={jobsFeed.refresh} />
    </Stack>
  ) : jobsFeed.isLoading && !jobsFeed.data ? (
    <LoadingState label="Loading runs…" />
  ) : rows.length === 0 ? (
    <Stack className="px-5 py-3">
      <EmptyState
        align="start"
        size="sm"
        title={jobs.length > 0 ? 'No runs match' : 'No compaction runs yet'}
        description={jobs.length > 0
          ? 'Clear the filters to see every run.'
          : 'A run merges run notes into patterns, or patterns into guides. The scheduler starts them; ManageBots can start one by hand.'}
      />
    </Stack>
  ) : (
    <GroupedList
      size="md"
      currentStyle="bar"
      groupHeading="label"
      groupCountAlign="end"
      groups={RUN_GROUPS.map((g) => ({ id: g.id, title: g.title, count: rows.filter((r) => r.groupId === g.id).length }))}
      hideEmptyGroups
      rows={rows.map((r) => ({
        id: r.id,
        groupId: r.groupId,
        title: r.title,
        meta: <T size="xs" tone="tertiary" title={r.meta}>{r.meta}</T>,
        subline: r.subline,
        ariaLabel: [r.title, r.meta, r.subline].filter(Boolean).join(', '),
        pill: <StatusPill tone={r.status.tone} label={r.status.label} {...(r.status.meta ? { meta: r.status.meta } : {})} size="sm" />,
      }))}
      currentId={state.run}
      onOpenRow={(row) => go({ run: row.id })}
      data-testid="activity-runs"
    />
  );

  const graphView = (
    <TypedNodeCanvas<TierCanvasNode>
      aria-label="Tier graph: run notes, patterns, guides and the Library"
      className="h-full min-h-[360px]"
      nodes={canvasNodes}
      edges={canvasEdges}
      selectedId={selectedEdge}
      nodeWidth={200}
      nodeHeight={140}
      columnGap={150}
      caption="Run notes → patterns → reusable guides. Open a tier to browse it; select an edge to inspect its run."
      renderNode={(node, { selected: sel }) => <TierNode node={node} selected={sel} />}
      renderListItem={(node) => (
        <T className="text-[13px] text-text-primary">
          {node.data.level ? `${node.data.level} ` : ''}{node.data.title}: {node.data.value ?? 'unknown'}{node.data.status ? ` · ${node.data.status.label}` : ''}
        </T>
      )}
      onSelectNode={(id) => {
        const href = graph.nodes.find((n) => n.id === id)?.data.href;
        if (href) navigate(href);
      }}
      onSelectEdge={selectEdge}
      data-testid="tier-graph"
    />
  );

  // The title band is the same on both views: the view switch and the
  // compaction actions. No repository button: on Runs the repository is the
  // list rail's filter; the tier graph shows every repository's tiers.
  const header = {
    breadcrumbs: moduleCtx?.scope.breadcrumbs ?? [{ label: 'Build' }, { label: 'Distillation' }, { label: 'Activity' }],
    title: 'Compaction activity',
    badge: (
      <SegmentedControl
        size="sm"
        aria-label="Activity view"
        value={state.view}
        onChange={(v) => go({ view: v === 'graph' ? 'graph' : 'runs' })}
        options={[{ value: 'runs', label: 'Runs' }, { value: 'graph', label: 'Tier graph' }]}
      />
    ),
    actions: (
      <Inline gap="sm" align="center" wrap>
        {rep && <StatusPill tone={rep.tone} label={rep.text} size="sm" data-testid="replication-status" />}
        {canCompact && (
          <>
            <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => { void compact('L1'); }}>
              {busy === 'L1' ? 'Compacting…' : 'Compact L0 → L1'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => { void compact('L2'); }}>
              {busy === 'L2' ? 'Compacting…' : 'Compact L1 → L2'}
            </Button>
          </>
        )}
      </Inline>
    ),
  };

  if (state.view === 'runs') {
    // The runs are a flush list rail beside the section rail; the content
    // column after it opens with the trail and the title (docs/layout-cascade.md).
    return (
      <ListRailLayout
        header={<SectionHeader {...header} />}
        list={{
          title: 'Runs',
          ...(jobsFeed.data ? { count: rows.length } : {}),
          header: runsHeader,
          body: runsList,
          label: 'compaction runs',
        }}
        data-testid="distillation-activity"
      >
        <Stack gap="md" className="px-6 pb-6">
          {summary}
          {selected ? (
            <RunInspector job={selected} onClose={() => go({ run: null })} onOpen={(href) => navigate(href)} />
          ) : (
            <EmptyState size="sm" title="Pick a run" description="Choose a run from the list to see its inputs, outputs and log." />
          )}
        </Stack>
      </ListRailLayout>
    );
  }

  return (
    <SectionContent {...header} body="fill" data-testid="distillation-activity">
      {summary}
      <CanvasPaneLayout
        className={SECTION_CANVAS_FRAME}
        paneLabel="run details"
        expandKey={state.run}
        pane={selected ? (
          <RunInspector job={selected} onClose={() => go({ run: null })} onOpen={(href) => navigate(href)} />
        ) : null}
      >
        {graphView}
      </CanvasPaneLayout>
    </SectionContent>
  );
}
