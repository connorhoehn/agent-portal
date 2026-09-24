// Mission control for an initiative: one owner, SMEs directing agents.
//
// Four panes, all from the library: the ScopeHeader across the top, then on
// the Work tab the work list (WorkListView), the open item (WorkItemDetail on
// EditorShell) and the run draft (RunDraftPanel) side by side. This file owns
// state, data and which child is mounted — nothing else. The tone lookups and
// tree arithmetic are in ./project-detail/projectFormat and the list model in
// ./project-detail/workListModel, neither of which has React in it.

import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ContextColumn,
  ExplorerLayout,
  ScopeHeader,
  ViewportFillRegion,
  WorkListView,
  type ContextColumnState,
  type ScopeHeaderPeopleGroup,
} from '@connorhoehnslalom/ui-components';
import {
  BranchIcon,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageSection,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useUrlState } from '../lib/useUrlState';
import { useCapabilities } from '../lib/capabilities';
import { useSession } from '../lib/auth';
import { githubRepoUrl } from '../lib/repoLink';
import { EstimateDrawer, type EstimateProvenance } from '../components/marketplace/EstimateDrawer';
import { OwnerEditor } from '../components/marketplace/GovernanceEditor';
import { useInitiativeAgentActivity } from '../components/marketplace/InitiativeAgentRail';
import type { BotRun } from './bots/BotsPage';
import { ContributorModal } from './project-detail/ContributorModal';
import { ContributorsTable } from './project-detail/ContributorsTable';
import { DecisionQueue } from './project-detail/DecisionQueue';
import { InitiativeRail } from './project-detail/InitiativeRail';
import { NewItemForm, type NewItemDraft } from './project-detail/NewItemForm';
import { RunDraft, type RunChoice } from './project-detail/RunDraft';
import { WorkItemDetail, type DetailTab, type WorkItemPatch } from './project-detail/WorkItemDetail';
import { useWorkItemThread } from './project-detail/useWorkItemThread';
import { useShellBreadcrumbItems } from '../components/shell/Breadcrumbs';
import {
  NO_FILTERS,
  WORK_GROUPS,
  WORK_SORT_OPTIONS,
  activeFilterCount,
  ownerOptions,
  pickCurrent,
  toWorkListItem,
  workRows,
  type WorkFilterState,
  type WorkSort,
} from './project-detail/workListModel';
import {
  hasActiveGrantOnInitiative,
  runsByWorkItem,
  sumForestPoints,
} from './project-detail/projectFormat';
import {
  dropFromTree,
  insertChild,
  isPendingId,
  mapTree,
  surfaceWriteError,
} from './project-detail/writeJson';
import { HttpError, sendJson } from '../lib/writeJson';
import { toastError } from '../lib/toastStore';
import type {
  Codebase,
  MyScopedSprintsResponse,
  ProjectDecision,
  ProjectDetail,
  WorkItem,
  WorkItemStatus,
  WorkItemTree,
} from './project-detail/types';

// Re-exported from its original home so anything importing the grant predicate
// off this module keeps working; the implementation now lives in projectFormat.
export { hasActiveGrantOnInitiative };

/** Client-side navigation back to the list — a `window.location` assignment on
 *  an error card would drop the SPA and reload the whole bundle. */
function BackToProjects() {
  return (
    <Link to="/iq/projects" className="no-underline">
      <Button variant="secondary" size="sm">← Back to Initiatives</Button>
    </Link>
  );
}

/** A local placeholder for an item the server has not acknowledged yet. */
function draftItem(id: string, projectId: string, projectName: string, parentId: string | null, draft: NewItemDraft): WorkItemTree {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    projectName,
    parentId,
    type: draft.type,
    title: draft.title,
    description: null,
    status: 'open',
    priority: draft.priority,
    assigneeId: null,
    assigneeName: null,
    assigneeDept: null,
    labels: [],
    storyPoints: draft.storyPoints,
    prUrl: null,
    prStatus: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    childCount: 0,
    childDoneCount: 0,
    children: [],
  };
}

const RUN_COLUMN_KEY = 'orgiq.initiative.run-column';

function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [localItems, setLocalItems] = useState<WorkItemTree[] | null>(null);
  const { can: canDo, ready: capsReady } = useCapabilities();
  const canDispatch = capsReady && canDo('DispatchAgentRun');

  // Pre-dispatch grant cue (audit finding M2 follow-up). Grant-scoped dispatch
  // hard-403s an sme with no active sprint grant on this initiative, but only
  // at Authorize time — this page only gates the Estimate/Authorize affordance
  // on the role-wide DispatchAgentRun capability, so an sme could walk into a
  // guaranteed 403 with no warning. No new endpoint: reuse the same
  // `scope=mine` sprints SprintsPage already fetches for its own "Your
  // envelope" badge (isGrantee + orgProjectId). Only fetched for sme — every
  // other role gets no cue, and member has no dispatch affordance here at all.
  const { session } = useSession();
  const isSme = session?.role === 'sme';
  const { data: mySprints } = useFetch<MyScopedSprintsResponse>(
    isSme && id ? '/api/sprints?scope=mine' : null,
  );
  // Absent data (still loading, fetch failed, or not an sme) means "say
  // nothing" rather than guess — a wrong cue is worse than none.
  const showGrantCue = canDispatch && isSme && mySprints != null
    && !hasActiveGrantOnInitiative(mySprints.sprints, id ?? '');

  // Governance edits are optimistic: overrides sit on top of the fetched
  // project until the next reload; the editors revert them on PATCH failure.
  const [ownerOverride, setOwnerOverride] = useState<{ ownerId: string | null; ownerName: string | null } | null>(null);
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string | null>>({});
  // Page-level so both the identity line (owner/SME chips) and the Contributors
  // table open the same in-place person card instead of navigating into the
  // graph and dropping the breadcrumb.
  const [openPerson, setOpenPerson] = useState<{ id: string; role: string | null } | null>(null);
  const handleRoleOverride = useCallback((personId: string, role: string | null) => {
    setRoleOverrides((prev) => ({ ...prev, [personId]: role }));
  }, []);
  const handleOpenPerson = useCallback((personId: string, role: string | null) => {
    setOpenPerson({ id: personId, role });
  }, []);

  // ?tab= — work | decisions | agents | contributors, defaulting to work so an
  // unscoped or stale link still lands somewhere real.
  const [tab, setTab] = useUrlState<string>(
    'tab',
    (raw) => (raw === 'decisions' || raw === 'agents' || raw === 'contributors' ? raw : 'work'),
    (v) => (v === 'work' ? null : v),
  );
  // ?item= — the work item open in the detail column. A stale id falls back
  // to the first item up next (pickCurrent), so the link never lands empty.
  const [wantedItem, setWantedItem] = useUrlState<string | null>('item', (raw) => raw, (v) => v);

  const [sort, setSort] = useState<WorkSort>('priority');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<WorkFilterState>(NO_FILTERS);
  // ?view= — the open item's tab (brief | comments | history).
  const [detailTab, setDetailTab] = useUrlState<DetailTab>(
    'view',
    (raw) => (raw === 'comments' || raw === 'history' ? raw : 'brief'),
    (v) => (v === 'brief' ? null : v),
  );
  const crumbs = useShellBreadcrumbItems();
  // The run-draft column: the reader's to fold, remembered per browser. First
  // visit opens it only where three panes fit (≥1440px); below that the item
  // keeps the width and the column waits as a strip.
  const [runColumn, setRunColumnRaw] = useState<ContextColumnState>(() => {
    try {
      const saved = localStorage.getItem(RUN_COLUMN_KEY);
      if (saved === 'open' || saved === 'wide' || saved === 'collapsed') return saved;
    } catch { /* no storage — fall through to the width default */ }
    return typeof window !== 'undefined' && window.innerWidth >= 1440 ? 'open' : 'collapsed';
  });
  const setRunColumn = useCallback((next: ContextColumnState) => {
    setRunColumnRaw(next);
    try { localStorage.setItem(RUN_COLUMN_KEY, next); } catch { /* session-only */ }
  }, []);
  // Status toggles in flight, so the row's checkbox reads busy until the
  // server answers rather than flickering back and forth.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // The composer's prepared instruction, per item — switching items must not
  // carry one item's instruction into another's run.
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  // What "New work item" creates: a story under an epic, or a new epic.
  const [creating, setCreating] = useState<{ parentId: string | null; parentTitle: string | null } | null>(null);

  const { data: project, isLoading: projLoading, error: projError } =
    useFetch<ProjectDetail>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : '');

  // `error`/`degraded` were discarded here, which is where the Work tab's
  // worst state came from: with the work_items read failing, the tab rendered
  // "No work yet — create an epic…" plus a New epic button on a live,
  // in-progress initiative. Nothing on the page said a read had failed, so the
  // invitation to start creating work was the only thing on offer.
  const { data: rawTree, isLoading: workLoading, error: workError, degraded: workDegraded } =
    useFetch<WorkItemTree[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/work` : '');
  const workFailure = workError ?? workDegraded;

  const { data: decisions } =
    useFetch<ProjectDecision[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/decisions` : '');

  // The codebases that deliver this initiative — the Build side of the join.
  //
  // GATED CLIENT-SIDE, because "the fetch 403s and the strip doesn't render" is
  // not free: it put four red 403s in the console on every load for any role
  // without the capability, which buries real errors and reads as a broken page.
  //
  // The server gate is readForRolesElseAction(['org-leader','hr-admin'],
  // 'DispatchAgentRun'). We cannot see the role short-circuit from here, but we
  // do not need to — both of those roles HOLD DispatchAgentRun in the seed
  // matrix, so the capability is a faithful proxy for the whole gate and cannot
  // hide the strip from someone the server would have served.
  //
  // (An earlier comment here said these were ManageDevbox-gated. They are not,
  // and acting on that would have gated the wrong capability.)
  const mayReadAgentWork = capsReady && canDo('DispatchAgentRun');
  const { data: codebasesData } = useFetch<{ projects: Codebase[] }>(
    mayReadAgentWork ? '/api/agent-projects' : null,
    60_000,
  );
  const codebases = (codebasesData?.projects ?? []).filter((p) => p.orgProjectId === id);

  // Bot-less marketplace runs for this initiative — polled while the page is
  // open so "agent working" chips appear/disappear live.
  const { data: marketData } = useFetch<{ runs: BotRun[] }>(
    id && mayReadAgentWork ? `/api/bots/marketplace-runs?orgProjectId=${encodeURIComponent(id)}` : null,
    10_000,
  );
  const marketplaceRuns = marketData?.runs ?? [];

  // Bots targeting this initiative + their runs merged with the marketplace
  // runs — feeds the rail's Agents/Outcomes cards.
  const agentActivity = useInitiativeAgentActivity(id, codebases, marketplaceRuns);

  // Agent spend, server-computed. The header used to sum agentActivity.runs
  // client-side, but both of that hook's inputs (/api/bots, /api/agent-projects)
  // are ManageDevbox-gated while /iq/projects has no role gate — so an SME or
  // member reaching this page got 403s, summed nothing, and read "$0.00 agent
  // spend" for an initiative that GET /api/graph/projects reports as $4.10 one
  // click away. That number — and the repo link — now ride the single-project
  // read (`project` above) instead of a second fetch of the WHOLE initiatives
  // list just to pick out this one row.
  const serverSpendUsd = project?.agentSpendUsd ?? null;
  // Mission-2 codebase link — the initiative's repo, from the same read.
  const repoUrl = githubRepoUrl(project?.repoFullName);

  const marketRuns = runsByWorkItem(marketplaceRuns);
  const workTree = localItems ?? rawTree ?? [];
  // The list is sorted and searched; the open item is chosen from the whole
  // backlog, so typing a search never swaps the item you are reading.
  const allRows = useMemo(() => workRows(workTree, sort, ''), [workTree, sort]);
  const visibleRows = useMemo(() => workRows(workTree, sort, query, filters), [workTree, sort, query, filters]);
  const current = pickCurrent(allRows, wantedItem);
  const thread = useWorkItemThread(current?.id ?? null);

  // Every edit to a work item — the list's tick, the meta bar, the outcome —
  // is optimistic, then confirmed. A failure puts the fields back the way
  // they were and says why, rather than leaving a value the server refused.
  const patchItem = useCallback((itemId: string, fields: WorkItemPatch): Promise<boolean> => {
    const base = localItems ?? rawTree ?? [];
    let before: WorkItemPatch = {};
    mapTree(base, (n) => {
      if (n.id === itemId) {
        before = Object.fromEntries(Object.keys(fields).map((k) => [k, n[k as keyof WorkItemTree]])) as WorkItemPatch;
      }
      return n;
    });
    const apply = (patch: WorkItemPatch) => (nodes: WorkItemTree[]) =>
      mapTree(nodes, (n) => (n.id === itemId ? { ...n, ...patch } : n));
    const revert = () => setLocalItems((prev) => apply(before)(prev ?? rawTree ?? []));

    setLocalItems(apply(fields)(base));

    // An item this page created but the server never acknowledged has a
    // client-side id; PATCHing it can only 404, and the edit would silently
    // stay until the next reload dropped it.
    if (isPendingId(itemId)) {
      revert();
      toastError(null, 'Not saved', 'This item has not been created on the server yet — reload and try again.');
      return Promise.resolve(false);
    }

    // assigneeName is display-only: the server resolves it from assigneeId.
    const { assigneeName: _name, ...wire } = fields;
    setPendingIds((prev) => new Set(prev).add(itemId));
    // Resolves true once the server has it, so a caller can follow up.
    return (async () => {
      try {
        await sendJson(`/api/graph/work-items/${encodeURIComponent(itemId)}`, 'PATCH', wire);
        return true;
      } catch (err) {
        revert();
        surfaceWriteError(err, 'Updating this item');
        return false;
      } finally {
        setPendingIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
      }
    })();
  }, [localItems, rawTree]);

  /** Create a work item optimistically, then reconcile it with the row the
   *  server actually created — without that the item keeps its `wi-new-…` id
   *  forever, so the first tick on it PATCHes an id no row has and the change
   *  vanishes on reload. */
  const createItem = useCallback((parentId: string | null, draft: NewItemDraft) => {
    const local = draftItem(
      `wi-new-${parentId ? '' : 'epic-'}${Date.now()}`,
      id ?? '', project?.name ?? '', parentId, draft,
    );
    setLocalItems((prev) => {
      const base = prev ?? rawTree ?? [];
      return parentId ? insertChild(base, parentId, local) : [...base, local];
    });

    void (async () => {
      try {
        const created = await sendJson<Partial<WorkItem> & { id?: string }>(
          '/api/graph/work-items', 'POST',
          { projectId: id, parentId, type: draft.type, title: draft.title, priority: draft.priority, storyPoints: draft.storyPoints },
        );
        if (!created.id) throw new HttpError(502, 'the server did not return the created item');
        setLocalItems((prev) => mapTree(prev ?? rawTree ?? [], (n) =>
          n.id === local.id ? { ...n, ...created, children: n.children } : n));
      } catch (err) {
        setLocalItems((prev) => dropFromTree(prev ?? rawTree ?? [], local.id));
        surfaceWriteError(err, `Adding this ${draft.type}`);
      }
    })();
  }, [id, project, rawTree]);

  // Marketplace: the item being authorized with the run draft's choices, and
  // the optimistic flip on 202.
  const [authorizing, setAuthorizing] = useState<{ item: WorkItemTree; choice: RunChoice } | null>(null);

  const handleDispatched = useCallback((workItemId: string, _run: BotRun) => {
    setLocalItems((prev) => mapTree(prev ?? rawTree ?? [], (n) =>
      (n.id === workItemId ? { ...n, status: 'in_progress' as WorkItemStatus } : n)));
  }, [rawTree]);

  // An estimate was authorized, not spent. The row must stay `open` — merging
  // status here would hide the very play action the save exists to reveal.
  const handleEstimateSaved = useCallback((workItemId: string, saved: EstimateProvenance) => {
    setLocalItems((prev) => mapTree(prev ?? rawTree ?? [], (n) => (n.id === workItemId
      ? {
          ...n,
          estimatedBy: saved.estimatedBy ?? null,
          // Enumerating these by hand already dropped this one field once: the
          // row rendered the raw subject `u-rachel` while a reload showed
          // "Rachel Kowalski", because `...n` silently kept the stale null.
          // Every provenance field the response carries must be listed here.
          estimatedByName: saved.estimatedByName ?? null,
          estimatedAt: saved.estimatedAt ?? null,
          estimateModel: saved.estimateModel ?? null,
          estimateForecast: saved.estimateForecast ?? null,
          estimatedCostUsd: saved.estimatedCostUsd ?? n.estimatedCostUsd,
          // Straight from the response, not `?? n.…`: a NEW estimate clears any
          // prior review server-side, and preserving the old value here would
          // show a sign-off that no longer exists in the database.
          estimateReviewedBy: saved.estimateReviewedBy ?? null,
          estimateReviewedByName: saved.estimateReviewedByName ?? null,
          estimateReviewedAt: saved.estimateReviewedAt ?? null,
        }
      : n)));
  }, [rawTree]);

  if (projLoading) {
    return <PageSection title="Initiative"><LoadingState label="Loading initiative…" /></PageSection>;
  }
  // A 404 is an answer (no such initiative), not an outage; only a real
  // failure should read as one.
  if (projError && /\b404\b|not found/i.test(projError)) {
    return (
      <PageSection title="Initiative">
        <ErrorState title="Initiative not found" body={`No initiative has the id "${id}".`} action={<BackToProjects />} />
      </PageSection>
    );
  }
  if (projError) {
    return (
      <PageSection title="Initiative">
        <ErrorState title="Failed to load this initiative" body={projError} action={<BackToProjects />} />
      </PageSection>
    );
  }
  if (!project) {
    return (
      <PageSection title="Initiative">
        <ErrorState title="Initiative not found" action={<BackToProjects />} />
      </PageSection>
    );
  }

  const escalatedCount = (decisions ?? []).filter((d) => d.status === 'escalated').length;
  // Governance, with optimistic overrides applied on top of the fetch.
  const contributors = project.contributors.map((c) =>
    c.personId in roleOverrides ? { ...c, role: roleOverrides[c.personId] ?? null } : c,
  );
  const ownerId = ownerOverride ? ownerOverride.ownerId : project.ownerId ?? null;
  const ownerName = ownerOverride ? ownerOverride.ownerName : project.ownerName ?? null;
  // Cross-initiative SMEs — the people directing agents here.
  const smes = contributors.filter((c) => (c.role ?? '').toLowerCase() === 'sme');
  const points = sumForestPoints(workTree);
  const people: ScopeHeaderPeopleGroup[] = [
    { label: 'Owner', people: ownerId && ownerName ? [{ id: ownerId, name: ownerName }] : [] },
    { label: 'SMEs', people: smes.map((c) => ({ id: c.personId, name: c.name })) },
  ];
  const repoHref = repoUrl ?? project.githubUrl ?? null;
  const statusLabel = project.status
    ? project.status.charAt(0).toUpperCase() + project.status.slice(1).replace(/_/g, ' ')
    : null;
  const firstEpic = workTree.find((n) => n.type === 'epic') ?? null;
  const currentRun = current ? marketRuns[current.id] : undefined;
  const itemDecisions = current ? (decisions ?? []).filter((d) => d.workItemId === current.id) : [];

  const header = (
    <ScopeHeader
      breadcrumbs={crumbs}
      title={project.name}
      status={statusLabel ? { label: statusLabel, tone: project.status === 'archived' ? 'neutral' : 'info' } : null}
      progress={{ done: points.done, total: points.total }}
      spentUsd={serverSpendUsd}
      stats={[
        project.sponsorName ? `Sponsored by ${project.sponsorName}` : null,
        escalatedCount > 0 ? `${escalatedCount} escalated` : null,
      ]}
      people={people}
      link={repoHref ? { label: project.repoFullName ?? 'Repository', href: repoHref } : null}
      menu={[{
        // Creating work is dispatch-gated server-side (POST /work-items), so
        // a role without it is not offered the menu entries.
        items: [
          ...(canDispatch && current ? [{ label: `New story in ${current.epicTitle}`, onSelect: () => setCreating({ parentId: current.epicId, parentTitle: current.epicTitle }) }] : []),
          ...(canDispatch ? [{ label: 'New epic', onSelect: () => setCreating({ parentId: null, parentTitle: null }) }] : []),
          { label: 'Contributors', onSelect: () => setTab('contributors') },
        ],
      }]}
      tabs={[
        { id: 'work', label: 'Work' },
        { id: 'decisions', label: 'Decisions', count: decisions?.length },
        // A count only when the roster was readable — "0" for a role that
        // cannot read bots would claim there are none.
        { id: 'agents', label: 'Agents', count: mayReadAgentWork && !agentActivity.botsError ? agentActivity.bots?.length : undefined },
        { id: 'contributors', label: 'Contributors', count: contributors.length },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      data-testid="initiative-header"
    />
  );

  return (
    <ViewportFillRegion bottomGap={0} data-testid="initiative-workspace">
      {/* data-shell-flush: the shell drops its padding ring and breadcrumb
          row for this page (app.css); the header above prints the trail. */}
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        {header}
        {tab === 'work' ? (
          <ExplorerLayout
            railWidth="lg"
            railLabel="work list"
            panePadding="none"
            asidePlacement="beside"
            className="min-h-0 flex-1"
            data-testid="initiative-work"
            rail={(
              <WorkListView
                groups={WORK_GROUPS}
                items={visibleRows.map((r) => toWorkListItem(r, marketRuns[r.id], pendingIds.has(r.id)))}
                count={allRows.length}
                currentId={current?.id ?? null}
                query={query}
                onQueryChange={setQuery}
                sort={sort}
                sortOptions={WORK_SORT_OPTIONS}
                onSortChange={(v) => setSort(v as WorkSort)}
                filterFacets={[
                  {
                    id: 'type',
                    label: 'Type',
                    options: [{ value: 'story', label: 'Story' }, { value: 'bug', label: 'Bug' }],
                    selected: filters.types,
                    onChange: (types) => setFilters((f) => ({ ...f, types })),
                  },
                  {
                    id: 'owner',
                    label: 'Owner',
                    options: ownerOptions(allRows),
                    selected: filters.owners,
                    onChange: (owners) => setFilters((f) => ({ ...f, owners })),
                  },
                  {
                    id: 'priority',
                    label: 'Priority',
                    options: [
                      { value: 'critical', label: 'Critical' },
                      { value: 'high', label: 'High' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'low', label: 'Low' },
                    ],
                    selected: filters.priorities,
                    onChange: (priorities) => setFilters((f) => ({ ...f, priorities })),
                  },
                ]}
                activeFilterCount={activeFilterCount(filters)}
                onClearFilters={() => setFilters(NO_FILTERS)}
                onCreate={!canDispatch ? undefined : current || firstEpic
                  ? () => setCreating(current
                    ? { parentId: current.epicId, parentTitle: current.epicTitle }
                    : { parentId: firstEpic!.id, parentTitle: firstEpic!.title })
                  : () => setCreating({ parentId: null, parentTitle: null })}
                onOpenItem={(row) => setWantedItem(row.id)}
                // Read-only rows (no checkbox) for a role that cannot PATCH work.
                onToggleDone={canDispatch
                  ? (row, done) => {
                      void patchItem(row.id, { status: done ? 'done' : 'open' }).then((ok) => {
                        if (ok && row.id === current?.id) thread.refreshComments();
                      });
                    }
                  : undefined}
                loading={workLoading && !rawTree}
                error={workFailure ? `The work list could not be read: ${workFailure}` : null}
                // Three different empties: work exists but the search/filters
                // hide it, no work at all for someone who can add some, and
                // no work for someone who cannot.
                emptyLabel={allRows.length > 0
                  ? 'No work matches this search or these filters'
                  : canDispatch
                    ? "No work yet — ingest this initiative's documents or add an epic"
                    : "No work yet — it arrives when this initiative's documents are ingested"}
                storageKey={`initiative.${id}.work-groups`}
              />
            )}
            aside={current ? (
              <ContextColumn
                state={runColumn}
                onStateChange={setRunColumn}
                roomy
                label="Run draft column"
                activeId="run-draft"
                onActivate={() => setRunColumn('open')}
                data-testid="initiative-run-column"
                panels={[{
                  id: 'run-draft',
                  label: 'Run draft',
                  icon: <BranchIcon size={18} />,
                  content: (
                    <RunDraft
                      item={current}
                      codebases={codebases}
                      run={currentRun}
                      canDispatch={canDispatch}
                      showGrantCue={showGrantCue}
                      instruction={instructions[current.id] ?? ''}
                      onEstimateSaved={handleEstimateSaved}
                      onAuthorize={(choice) => setAuthorizing({ item: current, choice })}
                    />
                  ),
                }]}
              />
            ) : undefined}
          >
            {current ? (
              <WorkItemDetail
                item={current}
                thread={thread}
                decisions={itemDecisions}
                contributors={contributors}
                runs={marketplaceRuns}
                tab={detailTab}
                onTabChange={setDetailTab}
                canEdit={canDispatch}
                canDispatch={canDispatch}
                onPatch={(fields) => {
                  // A status move writes an audit row server-side; re-read the
                  // thread so Activity shows it.
                  void patchItem(current.id, fields).then((ok) => {
                    if (ok && fields.status) thread.refreshComments();
                  });
                }}
                onOpenEpic={() => setQuery(current.epicTitle)}
                onOpenDecisions={() => setTab('decisions')}
                onPrepare={(text) => {
                  setInstructions((prev) => ({ ...prev, [current.id]: text }));
                  // The prepared instruction lands in the run draft — show it.
                  if (runColumn === 'collapsed') setRunColumn('open');
                }}
              />
            ) : (
              <EmptyState
                title={workLoading ? 'Loading work…' : 'Nothing to open'}
                body={workLoading ? undefined : 'Pick a work item from the list, or add one.'}
              />
            )}
          </ExplorerLayout>
        ) : (
          <Stack gap="md" className="min-h-0 flex-1 overflow-y-auto p-6">
            {tab === 'decisions' && <DecisionQueue decisions={decisions ?? []} />}
            {tab === 'agents' && (
              <InitiativeRail
                initiativeId={id}
                activity={agentActivity}
                codebases={codebases}
                runs={marketplaceRuns}
                workTree={workTree}
              />
            )}
            {tab === 'contributors' && (
              <>
                <OwnerEditor
                  projectId={id ?? ''}
                  contributors={contributors}
                  ownerId={ownerId}
                  ownerName={ownerName}
                  onOwner={(oid, oname) => setOwnerOverride({ ownerId: oid, ownerName: oname })}
                  onRole={handleRoleOverride}
                />
                <ContributorsTable
                  contributors={contributors}
                  projectId={id ?? ''}
                  onRole={handleRoleOverride}
                  onOpenPerson={handleOpenPerson}
                />
              </>
            )}
          </Stack>
        )}
      </Stack>

      {/* Contributor detail card — opened from the Contributors table, keeping
          the user (and their breadcrumb) on this initiative. */}
      {openPerson && (
        <ContributorModal
          personId={openPerson.id}
          roleLabel={openPerson.role}
          onClose={() => setOpenPerson(null)}
        />
      )}

      {creating && (
        <Modal
          open
          onClose={() => setCreating(null)}
          ariaLabel={creating.parentTitle ? `New work in ${creating.parentTitle}` : 'New epic'}
          maxWidth={560}
        >
          <NewItemForm
            defaultType={creating.parentId ? 'story' : 'epic'}
            typeOptions={creating.parentId ? ['story', 'bug'] : ['epic']}
            onSave={(draft) => { createItem(creating.parentId, draft); setCreating(null); }}
            onCancel={() => setCreating(null)}
          />
        </Modal>
      )}

      {/* Marketplace: authorize, with the run draft's choices prefilled. The
          drawer owns the four dispatch gates and their confirms. */}
      <EstimateDrawer
        open={authorizing != null}
        onClose={() => setAuthorizing(null)}
        item={authorizing?.item ?? null}
        codebases={codebases.map((cb) => ({ id: cb.id, repoFullName: cb.repoFullName }))}
        // The initiative this run is charged to — the drawer reads the caller's
        // own sprint envelope on it and reports what is left BEFORE they
        // authorize, instead of leaving the envelope brake's 409 to say it.
        orgProjectId={id ?? null}
        initialModel={authorizing?.choice.model}
        initialAgentProjectId={authorizing?.choice.agentProjectId}
        initialInstruction={authorizing ? instructions[authorizing.item.id] : undefined}
        initialCapUsd={authorizing?.choice.capUsd}
        onDispatched={handleDispatched}
        onEstimateSaved={handleEstimateSaved}
      />
    </ViewportFillRegion>
  );
}

export default ProjectDetailPage;
