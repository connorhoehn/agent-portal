// An initiative, inside the shared Initiatives frame (InitiativesExplorer):
// the explorer column on the left, the pane on the right with the
// initiative's header band (ScopeHeader) over it and the docked composer
// under it.
//
//   Overview (default)  the initiative list in the rail; the stats line,
//                       "Needs attention", "Up next" (InitiativeOverview).
//   Work                a grouped table, replaced by the selected item's
//                       detail without adding another navigation column.
//   Decisions, Agents, Contributors — the initiative list in the rail.
//
// `?item=` without `?tab=` lands on Work, so every deep link to a work item
// (the run badge, Local compute) keeps opening the item. This file owns state,
// data and which child is mounted; the words and numbers come from the pure
// models in ./project-detail (overviewModel, briefModel, composerPrompts,
// workListModel), none of which has React in it.

import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ScopeHeader,
  WorkTableView,
  type ScopeHeaderPeopleGroup,
} from '@connorhoehnslalom/ui-components';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageSection,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch';
import { useUrlState } from '../lib/useUrlState';
import { useCapabilities } from '../lib/capabilities';
import { useSession } from '../lib/auth';
import { githubRepoUrl } from '../lib/repoLink';
import { DEVBOX_MODELS } from '../lib/devboxModels';
import { EstimateDrawer, type EstimateProvenance } from '../components/marketplace/EstimateDrawer';
import { OwnerEditor } from '../components/marketplace/GovernanceEditor';
import { useInitiativeAgentActivity } from '../components/marketplace/InitiativeAgentRail';
import type { BotRun } from './bots/BotsPage';
import { InitiativesExplorer } from './projects/InitiativesExplorer';
import { useInitiativeListRail } from './projects/InitiativeListRail';
import { initiativeBreadcrumbs, initiativeHref } from './projects/initiativeNavigation';
import { InitiativeComposer } from './projects/InitiativeComposer';
import { AddNoteDialog, LinkDecisionDialog } from './project-detail/BriefDialogs';
import { ContributorModal } from './project-detail/ContributorModal';
import { ContributorsTable } from './project-detail/ContributorsTable';
import { DecisionQueue } from './project-detail/DecisionQueue';
import { InitiativeOverview } from './project-detail/InitiativeOverview';
import { InitiativeRail } from './project-detail/InitiativeRail';
import { NewItemForm, type NewItemDraft } from './project-detail/NewItemForm';
import { RunDraft, type RunChoice } from './project-detail/RunDraft';
import { WorkItemDetail, type DetailTab, type WorkItemPatch } from './project-detail/WorkItemDetail';
import { useWorkItemThread } from './project-detail/useWorkItemThread';
import { buildOverview } from './project-detail/overviewModel';
import { briefFacts, runSetupHint } from './project-detail/briefModel';
import { workflowPrompt, type ComposerSetup, type ComposerSubject } from './project-detail/composerPrompts';
import {
  NO_FILTERS,
  WORK_GROUPS,
  WORK_SORT_OPTIONS,
  activeFilterCount,
  ownerOptions,
  toWorkListItem,
  workRows,
  type WorkFilterState,
  type WorkSort,
} from './project-detail/workListModel';
import {
  hasActiveGrantOnInitiative,
  runsByWorkItem,
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

type InitiativeTab = 'overview' | 'work' | 'decisions' | 'agents' | 'contributors';
const TABS: readonly InitiativeTab[] = ['overview', 'work', 'decisions', 'agents', 'contributors'];

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

function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [localItems, setLocalItems] = useState<WorkItemTree[] | null>(null);
  const { can: canDo, ready: capsReady } = useCapabilities();
  const canDispatch = capsReady && canDo('DispatchAgentRun');

  // Pre-dispatch grant cue (audit finding M2 follow-up). Grant-scoped dispatch
  // hard-403s an sme with no active sprint grant on this initiative, but only
  // at Authorize time — so the Run setup says so up front. No new endpoint:
  // reuse the same `scope=mine` sprints SprintsPage already fetches for its own
  // "Your envelope" badge (isGrantee + orgProjectId). Only fetched for sme —
  // every other role gets no cue.
  const { session } = useSession();
  const isSme = session?.role === 'sme';
  const { data: mySprints } = useFetch<MyScopedSprintsResponse>(
    isSme && id ? '/api/sprints?scope=mine' : null,
  );
  // Absent data (still loading, fetch failed, or not an sme) means "say
  // nothing" rather than guess — a wrong cue is worse than none.
  const hasGrant = isSme && mySprints != null ? hasActiveGrantOnInitiative(mySprints.sprints, id ?? '') : null;
  const showGrantCue = canDispatch && isSme && hasGrant === false;

  // Governance edits are optimistic: overrides sit on top of the fetched
  // project until the next reload; the editors revert them on PATCH failure.
  const [ownerOverride, setOwnerOverride] = useState<{ ownerId: string | null; ownerName: string | null } | null>(null);
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string | null>>({});
  const [openPerson, setOpenPerson] = useState<{ id: string; role: string | null } | null>(null);
  const handleRoleOverride = useCallback((personId: string, role: string | null) => {
    setRoleOverrides((prev) => ({ ...prev, [personId]: role }));
  }, []);
  const handleOpenPerson = useCallback((personId: string, role: string | null) => {
    setOpenPerson({ id: personId, role });
  }, []);

  // ?tab= — overview by default, but Work whenever ?item= names an item, so
  // every existing deep link to a work item still opens it.
  const rawTab = searchParams.get('tab');
  const tab: InitiativeTab = TABS.includes(rawTab as InitiativeTab)
    ? rawTab as InitiativeTab
    : searchParams.has('item') ? 'work' : 'overview';
  // One write for the tab and the params that belong to it: leaving for the
  // Overview drops the open item (it would otherwise pull the default back to
  // Work); two separate param writes in one tick would clobber each other.
  const setTab = useCallback((next: string) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next !== 'work') { p.delete('item'); p.delete('view'); p.delete('wq'); }
      if (next === 'overview') p.delete('tab');
      else p.set('tab', next);
      return p;
    });
  }, [setSearchParams]);
  // A list-level Work breadcrumb clears the selection. Never auto-open a
  // different item after navigating up the hierarchy.
  const wantedItem = searchParams.get('item');
  const openItem = useCallback((itemId: string) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('tab', 'work');
      p.set('item', itemId);
      return p;
    });
  }, [setSearchParams]);

  const [sort, setSort] = useState<WorkSort>('priority');
  // ?wq= — the work search. Not ?q=: the initiative list rail owns that one.
  const [query, setQuery] = useUrlState<string>('wq', (raw) => raw ?? '', (v) => (v ? v : null));
  const workSearch = useDebouncedSearch(query, setQuery);
  const [filters, setFilters] = useState<WorkFilterState>(NO_FILTERS);
  // ?view= — the open item's tab (brief | comments | history).
  const [detailTab, setDetailTab] = useUrlState<DetailTab>(
    'view',
    (raw) => (raw === 'comments' || raw === 'history' ? raw : 'brief'),
    (v) => (v === 'brief' ? null : v),
  );
  // Status toggles in flight, so the row's checkbox reads busy until the
  // server answers rather than flickering back and forth.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // The run draft's current choices, for the collapsed Run setup's hint.
  const [runChoice, setRunChoice] = useState<RunChoice | null>(null);
  // "Draft with agent" puts the criteria workflow in the composer; the counter
  // keys the composer so a second press re-seeds it.
  const [composerSeed, setComposerSeed] = useState<{ itemId: string; text: string; n: number } | null>(null);
  const [briefDialog, setBriefDialog] = useState<'note' | 'context' | null>(null);
  // What "New work item" creates: a story under an epic, or a new epic.
  const [creating, setCreating] = useState<{ parentId: string | null; parentTitle: string | null } | null>(null);

  // The initiative list stays visible on every tab, including Work.
  const listRail = useInitiativeListRail({ currentId: id ?? null, defaultScope: 'all' });

  const { data: project, isLoading: projLoading, error: projError } =
    useFetch<ProjectDetail>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : '');

  // `error`/`degraded` are kept: with the work_items read failing, an empty
  // tree must read as a failure, never as "No work yet — create an epic…".
  const { data: rawTree, isLoading: workLoading, error: workError, degraded: workDegraded, refresh: refreshWork } =
    useFetch<WorkItemTree[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/work` : '');
  const workFailure = workError ?? workDegraded;

  const { data: decisions, error: decisionsError, degraded: decisionsDegraded, refresh: refreshDecisions } =
    useFetch<ProjectDecision[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/decisions` : '');

  // The codebases that deliver this initiative. Gated client-side on
  // DispatchAgentRun — the server gate is readForRolesElseAction(['org-leader',
  // 'hr-admin'], 'DispatchAgentRun'), both of which roles hold the capability,
  // so the capability is a faithful proxy and a role without it is spared four
  // red 403s in the console.
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
  const agentActivity = useInitiativeAgentActivity(id, codebases, marketplaceRuns);

  const repoUrl = githubRepoUrl(project?.repoFullName);
  const marketRuns = runsByWorkItem(marketplaceRuns);
  const workTree = localItems ?? rawTree ?? [];
  const treeRead = localItems ?? rawTree ?? null;
  // The list is sorted and searched; the open item is chosen from the whole
  // backlog, so typing a search never swaps the item you are reading.
  const allRows = useMemo(() => workRows(workTree, sort, ''), [workTree, sort]);
  const visibleRows = useMemo(() => workRows(workTree, sort, query, filters), [workTree, sort, query, filters]);
  const current = tab === 'work' && wantedItem ? allRows.find((row) => row.id === wantedItem) ?? null : null;
  const thread = useWorkItemThread(current?.id ?? null);

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
    // client-side id; PATCHing it can only 404.
    if (isPendingId(itemId)) {
      revert();
      toastError(null, 'Not saved', 'This item has not been created on the server yet — reload and try again.');
      return Promise.resolve(false);
    }

    // assigneeName is display-only: the server resolves it from assigneeId.
    const { assigneeName: _name, ...wire } = fields;
    setPendingIds((prev) => new Set(prev).add(itemId));
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
   *  forever, so the first tick on it PATCHes an id no row has. */
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
          // Every provenance field the response carries must be listed here —
          // enumerating by hand already dropped `estimatedByName` once.
          estimatedByName: saved.estimatedByName ?? null,
          estimatedAt: saved.estimatedAt ?? null,
          estimateModel: saved.estimateModel ?? null,
          estimateForecast: saved.estimateForecast ?? null,
          estimatedCostUsd: saved.estimatedCostUsd ?? n.estimatedCostUsd,
          // Straight from the response: a NEW estimate clears any prior review
          // server-side.
          estimateReviewedBy: saved.estimateReviewedBy ?? null,
          estimateReviewedByName: saved.estimateReviewedByName ?? null,
          estimateReviewedAt: saved.estimateReviewedAt ?? null,
        }
      : n)));
  }, [rawTree]);

  if (projLoading) {
    return <PageSection title="Initiative"><LoadingState label="Loading initiative…" /></PageSection>;
  }
  // A 404 is an answer (no such initiative), not an outage.
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

  // Governance, with optimistic overrides applied on top of the fetch.
  const contributors = project.contributors.map((c) =>
    c.personId in roleOverrides ? { ...c, role: roleOverrides[c.personId] ?? null } : c,
  );
  const ownerId = ownerOverride ? ownerOverride.ownerId : project.ownerId ?? null;
  const ownerName = ownerOverride ? ownerOverride.ownerName : project.ownerName ?? null;
  const smes = contributors.filter((c) => (c.role ?? '').toLowerCase() === 'sme' && c.personId !== ownerId);
  const people: ScopeHeaderPeopleGroup[] = [
    { label: 'Owner', people: ownerId && ownerName ? [{ id: ownerId, name: ownerName }] : [] },
    { label: smes.length === 1 ? 'SME' : 'SMEs', people: smes.map((c) => ({ id: c.personId, name: c.name })) },
  ];
  const repoHref = repoUrl ?? project.githubUrl ?? null;
  const statusLabel = project.status
    ? project.status.charAt(0).toUpperCase() + project.status.slice(1).replace(/_/g, ' ')
    : null;
  const firstEpic = workTree.find((n) => n.type === 'epic') ?? null;
  const onWork = tab === 'work';
  const decisionsRead = { data: decisions ?? null, error: decisionsError ?? decisionsDegraded ?? null };

  const header = (
    <ScopeHeader
      title={project.name}
      // Keep the project header stable as descendants open underneath it.
      titleSize="lg"
      tabSize="md"
      status={statusLabel ? { label: statusLabel, tone: project.status === 'archived' ? 'neutral' : 'info' } : null}
      description={project.summary ?? undefined}
      descriptionSize="sm"
      peopleStyle="inline"
      people={people}
      linkStyle="button"
      link={repoHref ? { label: 'Repository', href: repoHref } : null}
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
        { id: 'overview', label: 'Overview' },
        // The count is the rows we hold; none while the read is pending or failed.
        { id: 'work', label: 'Work', ...(treeRead && !workFailure ? { count: allRows.length } : {}) },
        { id: 'decisions', label: 'Decisions', count: decisions?.length },
        // A count only when the roster was readable — "0" for a role that
        // cannot read bots would claim there are none.
        { id: 'agents', label: 'Agents', count: mayReadAgentWork && !agentActivity.botsError ? agentActivity.bots?.length : undefined },
        { id: 'contributors', label: 'Contributors', count: contributors.length },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      // The header draws the rule under its tabs itself, inset to the 24px
      // gutter so it starts under the title rather than at the pane's edge
      // (the v2 mockup; ui-components 2.396.0). A host `border-b` here would
      // be a second, full-bleed rule — and the previous one was also where
      // the selected tab's 2px underline got half painted over by the pane
      // body; at `tabSize="md"` the library now draws a 3px bar inside its
      // own box, as the "Initiative overview v2" story composes it.
      tabsRule="inset"
      data-testid="initiative-header"
    />
  );

  // ─── The composer's subject ────────────────────────────────────────────────
  const projectRef = { id: project.id, name: project.name };
  let subject: ComposerSubject;
  let composerSetup: Partial<ComposerSetup> | undefined;
  if (onWork && current) {
    const criteriaRead = { data: thread.criteriaLoading ? null : thread.criteria, error: thread.criteriaError };
    const facts = briefFacts(current, criteriaRead);
    subject = { kind: 'item', project: projectRef, item: current, facts };
    const seeded = composerSeed && composerSeed.itemId === current.id ? composerSeed : null;
    composerSetup = seeded
      ? { draft: seeded.text, draftKey: `item:${current.id}:seed:${seeded.n}` }
      // The prefill reads the criteria count, so it is keyed on whether that
      // is known yet: the composer re-seeds once when the read lands.
      : { draftKey: `item:${current.id}:${facts.criteriaCount == null ? 'pending' : 'ready'}` };
  } else {
    subject = { kind: 'initiative', project: projectRef, rows: treeRead && !workFailure ? allRows : null };
  }
  const composer = (
    <InitiativeComposer
      presentation="document"
      subject={subject}
      {...(composerSetup ? { setup: composerSetup } : {})}
      {...(onWork && current && canDispatch
        ? { onChat: (msg: { text: string }) => thread.postComment(msg.text) }
        : {})}
      chatUnavailableReason={onWork && current
        ? 'Your role cannot post to the discussion — ask the agent instead'
        : 'Open a work item to discuss it — ask the agent here instead'}
    />
  );

  // ─── Work: full-width backlog ──────────────────────────────────────────────
  const workTable = (
    <WorkTableView
      searchPlaceholder="Find work…"
      groups={WORK_GROUPS.map((group) => group.id === 'in_progress' ? { ...group, defaultOpen: true } : group)}
      groupColors={{ done: 'var(--color-success)' }}
      items={visibleRows.map((r) => ({ ...toWorkListItem(r, marketRuns[r.id], pendingIds.has(r.id), { metaStyle: 'text' }), kindLabel: r.type === 'bug' ? 'Bug' : 'Story' }))}
      count={allRows.length}
      currentId={current?.id ?? null}
      query={workSearch.searchText}
      onQueryChange={workSearch.onSearchChange}
      sort={sort}
      sortOptions={WORK_SORT_OPTIONS.map((option) => ({ ...option, label: option.label.replace(/^By /, '').replace(/^./, (letter) => letter.toUpperCase()) }))}
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
      onOpenItem={(row) => openItem(row.id)}
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
      onRetry={refreshWork}
      // Three different empties: work exists but the search/filters hide it,
      // no work at all for someone who can add some, and no work for someone
      // who cannot.
      emptyLabel={allRows.length > 0
        ? 'No work matches this search or these filters'
        : canDispatch
          ? "No work yet — ingest this initiative's documents or add an epic"
          : "No work yet — it arrives when this initiative's documents are ingested"}
      data-testid="initiative-work-list"
    />
  );

  const selectedCodebase = codebases.find((c) => c.id === runChoice?.agentProjectId) ?? null;
  const runHint = runSetupHint({
    canDispatch,
    isSme,
    hasGrant,
    model: runChoice ? DEVBOX_MODELS.find((m) => m.id === runChoice.model)?.label ?? runChoice.model : null,
    repo: selectedCodebase?.repoFullName ?? null,
    capUsd: runChoice?.capUsd ?? null,
  });

  const workPane = current ? (
    <WorkItemDetail
      item={current}
      thread={thread}
      decisions={decisionsRead}
      contributors={contributors}
      runs={marketplaceRuns}
      tab={detailTab}
      onTabChange={setDetailTab}
      canEdit={canDispatch}
      onPatch={(fields) => {
        // A status move writes an audit row server-side; re-read the thread
        // so Activity shows it.
        void patchItem(current.id, fields).then((ok) => {
          if (ok && fields.status) thread.refreshComments();
        });
      }}
      onOpenEpic={() => setQuery(current.epicTitle)}
      onOpenDecisions={() => setTab('decisions')}
      onDraftCriteria={() => {
        const text = workflowPrompt('criteria', subject);
        if (text) setComposerSeed((prev) => ({ itemId: current.id, text, n: (prev?.n ?? 0) + 1 }));
      }}
      onAddContext={() => setBriefDialog('context')}
      onAddNote={() => setBriefDialog('note')}
      runSetup={{
        hint: runHint,
        body: (
          <RunDraft
            item={current}
            codebases={codebases}
            run={marketRuns[current.id]}
            canDispatch={canDispatch}
            showGrantCue={showGrantCue}
            onEstimateSaved={handleEstimateSaved}
            onAuthorize={(choice) => setAuthorizing({ item: current, choice })}
            onChoiceChange={setRunChoice}
          />
        ),
      }}
    />
  ) : (
    <EmptyState
      size="sm"
      title={workLoading ? 'Loading work…' : wantedItem ? 'Work item unavailable' : 'Select a work item'}
      body={workLoading ? undefined : wantedItem ? 'This item is not in the current work list. Choose another item from the rail.' : 'Choose an item from the Work list to see its brief, discussion, and activity.'}
    />
  );

  return (
    <>
      <InitiativesExplorer
        {...listRail.slots}
        combinedNavigation
        breadcrumbs={initiativeBreadcrumbs({ search: searchParams, scope: listRail.scope, project, tab: wantedItem ? tab : 'overview', item: current?.title })
          .filter((crumb) => crumb.label !== 'All initiatives' && crumb.label !== 'My initiatives')}
        paneHeader={header}
        composer={composer}
        data-testid="initiative-workspace"
      >
        {tab === 'overview' && (
          <InitiativeOverview
            model={buildOverview(project, { tree: treeRead, error: workFailure ?? null, loading: workLoading })}
            onOpen={(href) => {
              const [path, childSearch] = href.split('?');
              const params = new URLSearchParams(initiativeHref(project.id, searchParams, listRail.scope).split('?')[1]);
              new URLSearchParams(childSearch).forEach((value, key) => params.set(key, value));
              navigate(`${path}?${params}`);
            }}
            onRetry={refreshWork}
          />
        )}
        {onWork && (wantedItem ? <Stack gap="none" className="min-w-0">
          <div className="px-6 pt-3"><Button size="sm" variant="ghost" onClick={() => setSearchParams((prev) => {
            const params = new URLSearchParams(prev);
            params.delete('item'); params.delete('view');
            return params;
          })}>← Back to work</Button></div>
          {workPane}
        </Stack> : workTable)}
        {!onWork && tab !== 'overview' && (
          <Stack gap="md" className="p-6">
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
      </InitiativesExplorer>

      {/* Contributor detail card — opened from the Contributors table, keeping
          the user on this initiative. */}
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

      {current && briefDialog === 'note' && (
        <AddNoteDialog
          itemTitle={current.title}
          onPost={thread.postComment}
          onClose={() => setBriefDialog(null)}
        />
      )}
      {current && briefDialog === 'context' && (
        <LinkDecisionDialog
          itemId={current.id}
          itemTitle={current.title}
          decisions={decisions ?? []}
          onLinked={refreshDecisions}
          onClose={() => setBriefDialog(null)}
        />
      )}

      {/* Marketplace: authorize, with the run draft's choices prefilled. The
          drawer owns the four dispatch gates and their confirms. */}
      <EstimateDrawer
        open={authorizing != null}
        onClose={() => setAuthorizing(null)}
        item={authorizing?.item ?? null}
        codebases={codebases.map((cb) => ({ id: cb.id, repoFullName: cb.repoFullName }))}
        // The initiative this run is charged to — the drawer reads the caller's
        // own sprint envelope on it before they authorize.
        orgProjectId={id ?? null}
        initialModel={authorizing?.choice.model}
        initialAgentProjectId={authorizing?.choice.agentProjectId}
        initialInstruction={authorizing?.choice.instruction}
        initialCapUsd={authorizing?.choice.capUsd}
        onDispatched={handleDispatched}
        onEstimateSaved={handleEstimateSaved}
      />
    </>
  );
}

export default ProjectDetailPage;
