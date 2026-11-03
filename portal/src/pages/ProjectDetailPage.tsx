import { ComposerSurface } from '@connorhoehnslalom/ui-components/shared';
// An initiative, inside the shared Initiatives frame (InitiativesExplorer):
// the explorer column on the left, the pane on the right with the
// initiative's header band over it and the docked composer
// under it.
//
//   Overview (default)  the initiative list in the rail; the stats line,
//                       "Needs attention", "Up next" (InitiativeOverview).
//   Work                a grouped table; selecting an item puts its detail
//                       beside the same work list in the existing rail.
//   Decisions, Agents, Contributors — the initiative list in the rail.
//
// `?item=` without `?tab=` lands on Work, so every deep link to a work item
// (the run badge, Local compute) keeps opening the item. This file owns state,
// data and which child is mounted; the words and numbers come from the pure
// models in ./project-detail (overviewModel, briefModel, composerPrompts,
// workListModel), none of which has React in it.

import {
  useSidePane,
  WorkListView,
  WorkTableView,
  type WorkListViewProps,
} from '@connorhoehnslalom/ui-components';
import {
  Button,
  CodeIcon,
  DocumentIcon,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  Inline,
  LoadingState,
  MoreIcon,
  Modal,
  PageHeader,
  PageSection,
  SearchIcon,
  Select,
  Stack,
  StatusPill,
  T,
  Tabs,
  Tooltip,
  useHeaderDensity,
  type BreadcrumbItem,
  type HeaderPeopleGroup,
} from '@connorhoehnslalom/ui-components/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ConversationOwner, ConversationThread } from '../components/chat/ConversationThread';
import type { EstimateProvenance } from '../components/marketplace/EstimateDrawer';
import { OwnerEditor } from '../components/marketplace/GovernanceEditor';
import { useInitiativeAgentActivity } from '../components/marketplace/InitiativeAgentRail';
import { RecentWorkActivity } from '../components/work-graph/RecentWorkActivity';
import { WorkGraphActivity } from '../components/work-graph/WorkGraphActivity';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch';
import { useFetch } from '../hooks/useFetch';
import { useSession } from '../lib/auth';
import { useCapabilities } from '../lib/capabilities';
import { DEVBOX_MODELS } from '../lib/devboxModels';
import { githubRepoUrl } from '../lib/repoLink';
import { toastError } from '../lib/toastStore';
import { useUrlState } from '../lib/useUrlState';
import { HttpError, sendJson } from '../lib/writeJson';
import type { BotRun } from './bots/BotsPage';
import { AddNoteDialog, LinkDecisionDialog } from './project-detail/BriefDialogs';
import { briefFacts } from './project-detail/briefModel';
import { workflowPrompt, type ComposerSetup, type ComposerSubject } from './project-detail/composerPrompts';
import { ContributorsTable } from './project-detail/ContributorsTable';
import { DecisionQueue } from './project-detail/DecisionQueue';
import { InitiativeOverview } from './project-detail/InitiativeOverview';
import { InitiativeRail } from './project-detail/InitiativeRail';
import { NewItemForm, type NewItemDraft } from './project-detail/NewItemForm';
import { buildOverview } from './project-detail/overviewModel';
import {
  flattenWorkItems,
  hasActiveGrantOnInitiative,
  runsByWorkItem,
} from './project-detail/projectFormat';
import { usePrepareJobDeck } from './project-detail/usePrepareJobDeck';
import type {
Codebase,
MyScopedSprintsResponse,
ProjectDecision,
ProjectDetail,
WorkItem,
WorkItemStatus,
WorkItemTree,
} from './project-detail/types';
import { useWorkItemThread } from './project-detail/useWorkItemThread';
import { WorkItemDetail, type DetailTab, type WorkItemPatch } from './project-detail/WorkItemDetail';
import {
  activeFilterCount,
  NO_FILTERS,
  ownerOptions,
  toWorkListItem,
  WORK_GROUPS,
  WORK_SORT_OPTIONS,
  workRows,
  type WorkFilterState,
  type WorkSort,
} from './project-detail/workListModel';
import {
  dropFromTree,
  insertChild,
  isPendingId,
  mapTree,
  surfaceWriteError,
} from './project-detail/writeJson';
import { InitiativeAgentPanel, type InitiativeAgentHandle } from './projects/InitiativeAgentPanel';
import { useInitiativeCall } from './projects/InitiativeCall';
import { postInitiativeComment } from './projects/initiativeComment';
import { InitiativeComposer } from './projects/InitiativeComposer';
import { initiativeConversationMessages, type InitiativeConversationFilter } from './projects/initiativeConversationModel';
import { InitiativeDetailsTrigger, type InitiativeFactsInput } from './projects/InitiativeDetailsCard';
import { useInitiativeSocialChannel } from './projects/InitiativeDiscussion';
import { InitiativeFiles } from './projects/InitiativeFiles';
import { useInitiativeListRail } from './projects/InitiativeListRail';
import { initiativeBreadcrumbs, initiativeHref } from './projects/initiativeNavigation';
import { InitiativeRecordings } from './projects/InitiativeRecordings.tsx';
import { InitiativesExplorer } from './projects/InitiativesExplorer';
import { InitiativeSidePane, useInitiativePane } from './projects/InitiativeSidePane';
import { scopeDiscussionChannel } from './projects/scopeDiscussionModel';
import { ScopePresence } from './projects/ScopePresence';
import { scopePresenceChannel } from './projects/scopePresenceModel';
import { workConversationReferences } from './projects/workConversationContext';
import type { WorkThread } from './projects/workThread';

// Re-exported from its original home so anything importing the grant predicate
// off this module keeps working; the implementation now lives in projectFormat.
export { hasActiveGrantOnInitiative };

type InitiativeTab = 'overview' | 'work' | 'docs' | 'decisions' | 'agents' | 'contributors' | 'activity';
const TABS: readonly InitiativeTab[] = ['overview', 'work', 'docs', 'decisions', 'agents', 'contributors', 'activity'];

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

// Search and Repository are secondary: when the header's own column is
// narrower than this (the huddle pane can squeeze it at any viewport) they
// move into the ⋯ menu.
const WIDE_ACTIONS_PX = 760;
function useWideActions() {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (!node) return;
    const measure = () => setWide(node.getBoundingClientRect().width >= WIDE_ACTIONS_PX);
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return () => observer.disconnect();
  }, [node]);
  return { wideActions: wide, measureRef: setNode };
}

function ProjectDetailPage() {
  const { wideActions, measureRef } = useWideActions();
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

  // Governance edits are optimistic: overrides sit on top of the fetched
  // project until the next reload; the editors revert them on PATCH failure.
  const [ownerOverride, setOwnerOverride] = useState<{ ownerId: string | null; ownerName: string | null } | null>(null);
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string | null>>({});
  const handleRoleOverride = useCallback((personId: string, role: string | null) => {
    setRoleOverrides((prev) => ({ ...prev, [personId]: role }));
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
      if (next !== 'docs') p.delete('recording');
      if (next === 'overview') p.delete('tab');
      else p.set('tab', next);
      return p;
    });
  }, [setSearchParams]);
  const openRecording = useCallback((recordingId: string | null) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      p.set('tab', 'docs'); p.delete('item'); p.delete('view'); p.delete('wq');
      if (recordingId) p.set('recording', recordingId); else p.delete('recording');
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
      p.delete('view');
      if (p.get('pane') === 'brief') p.set('paneRecord', `work-item:${itemId}`);
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
    (raw) => (raw === 'docs' ? 'docs' : raw === 'comments' || raw === 'history' ? 'history' : 'brief'),
    (v) => (v === 'brief' ? null : v),
  );
  // Status toggles in flight, so the row's checkbox reads busy until the
  // server answers rather than flickering back and forth.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [prepareJobRequest, setPrepareJobRequest] = useState<{ itemId: string; revision: number } | null>(null);
  // "Draft with agent" puts the criteria workflow in the composer; the counter
  // keys the composer so a second press re-seeds it.
  const [composerSeed, setComposerSeed] = useState<{ itemId: string; text: string; n: number } | null>(null);
  const [briefDialog, setBriefDialog] = useState<'note' | 'context' | null>(null);
  // What "New work item" creates: a story under an epic, or a new epic.
  const [creating, setCreating] = useState<{ parentId: string | null; parentTitle: string | null } | null>(null);

  // Browsing views use initiative rows; a selected Work item uses work rows.
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
  // "Add a note" posts to the same thread.
  const postToThread = useCallback(async (text: string): Promise<boolean> => {
    if (!id || !current || !canDispatch || !text.trim()) return false;
    await postInitiativeComment(id, current.id, text.trim());
    thread.refreshComments();
    return true;
  }, [id, current?.id, canDispatch, thread.refreshComments]);
  // The initiative's own Discussion, owned the same way (the pane's thread and the content composer share it).
  const [initiativeThread, setInitiativeThread] = useState<WorkThread | null>(null);
  const [conversationFilter, setConversationFilter] = useUrlState<InitiativeConversationFilter>('conversation',
    raw => raw === 'all' || raw === 'initiative' ? raw : 'dialogue', value => value === 'dialogue' ? null : value);
  useEffect(() => { if (current) thread.refreshComments(); }, [current?.id, initiativeThread?.chat.messages, thread.refreshComments]);

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

  // Marketplace: the optimistic flip on 202 (Prepare job dispatches from the
  // composer's deck, usePrepareJobDeck).

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

  // Prepare job: derived from the open item, asked about in the composer's deck
  // (only the questions that need a human). A hook, so before the early returns.
  const jobPrompts = usePrepareJobDeck({
    item: tab === 'work' ? current : null,
    codebases,
    linkedRepo: project?.repoFullName ?? null,
    orgProjectId: id ?? null,
    canDispatch,
    role: session?.role,
    run: current ? marketRuns[current.id] : undefined,
    request: prepareJobRequest,
    onDispatched: handleDispatched,
    onEstimateSaved: handleEstimateSaved,
  });

  // ComposerPromptDeck owns focus for new and reopened questions. Keeping a
  // second page-level focus loop here moved the caret back onto an answer.

  // The call (docs/social-calls-plan.md step 5): owner + SMEs, overrides
  // applied, computed before the early returns because it is a hook.
  const callOwnerId = ownerOverride ? ownerOverride.ownerId : project?.ownerId ?? null;
  const callOwnerName = ownerOverride ? ownerOverride.ownerName : project?.ownerName ?? null;
  const callOwner = useMemo(
    () => (callOwnerId ? { personId: callOwnerId, name: callOwnerName ?? callOwnerId } : null),
    [callOwnerId, callOwnerName],
  );
  const callSmes = useMemo(() => (project?.contributors ?? [])
    .filter((c) => ((c.personId in roleOverrides ? roleOverrides[c.personId] : c.role) ?? '').toLowerCase() === 'sme' && c.personId !== callOwnerId)
    .map((c) => ({ personId: c.personId, name: c.name })), [project, roleOverrides, callOwnerId]);
  // The initiative's bound Social channel (design §4.6) is offered by the
  // bottom Social bar, not drawn on the page (the user, 2026-10-06).
  useInitiativeSocialChannel(project?.id ?? null);
  const initiativeCall = useInitiativeCall({
    project: project ? { id: project.id, name: project.name } : null,
    owner: callOwner,
    smes: callSmes,
    onOpenPeople: () => setTab('contributors'),
  });
  // The page's conversation thread is the shell's right pane (the library
  // SidePane); its ONE composer is docked at the bottom of the content column
  // (the user, 2026-10-07: "keep the chat in the main content… just keep the
  // dialogue thread there"). The footer's Message reveals the pane and the
  // composer takes the caret (InitiativeComposer answers the focus request).
  const conversationPane = useSidePane();
  // The pane's tabs (Discussion | Details | Docs | a run's Log…): the library pane contract, `?pane=` / `?paneRecord=`.
  const paneControl = useInitiativePane(project?.id ?? null);
  const [paneItemFocus, setPaneItemFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!paneItemFocus || current?.id !== paneItemFocus) return;
    const frame = requestAnimationFrame(() => {
      const detail = document.querySelector<HTMLElement>('[data-testid="work-item-detail"]');
      detail?.focus({ preventScroll: true });
      detail?.scrollIntoView({ block: 'start' });
      setPaneItemFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [paneItemFocus, current?.id]);
  const openItemFromPane = (itemId: string) => { openItem(itemId); paneControl.close(); setPaneItemFocus(itemId); };
  const agentPanel = useRef<InitiativeAgentHandle | null>(null);
  // The header's density (library `useHeaderDensity`): one density for every
  // tab, so clicking a tab never moves the header, the tab strip or the pane
  // (docs/work-journeys-goal.md, tab stability — the Activity tab used to
  // compact it 214→96px). The chevron still folds it into the trail, remembered
  // per device.
  const headerDensity = useHeaderDensity({ contentKind: 'detail', headerId: 'initiative' });

  if (projLoading) {
    return <PageSection title="Initiative" size="lg"><LoadingState label="Loading initiative…" /></PageSection>;
  }
  // A 404 is an answer (no such initiative), not an outage.
  if (projError && /\b404\b|not found/i.test(projError)) {
    return (
      <PageSection title="Initiative" size="lg">
        <ErrorState title="Initiative not found" body={`No initiative has the id "${id}".`} action={<BackToProjects />} />
      </PageSection>
    );
  }
  if (projError) {
    return (
      <PageSection title="Initiative" size="lg">
        <ErrorState title="Failed to load this initiative" body="The initiative could not be loaded. Try again in a moment." action={<BackToProjects />} />
      </PageSection>
    );
  }
  if (!project) {
    return (
      <PageSection title="Initiative" size="lg">
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
  // Faces ride on the contributor rows (people.avatar_url); none → initials.
  const avatarOf = (personId: string) => contributors.find((c) => c.personId === personId)?.avatarUrl ?? undefined;
  const ownerAvatar = ownerId ? avatarOf(ownerId) : undefined;
  const people: HeaderPeopleGroup[] = [
    {
      label: 'Owner', people: ownerId && ownerName ? [{ id: ownerId, name: ownerName, ...(ownerAvatar ? { avatarUrl: ownerAvatar } : {}) }] : [],
      // The owner's change control sits beside the owner it changes, on every
      // tab — not as a lone ✎ row above the Contributors table.
      action: (
        <OwnerEditor
          projectId={id ?? ''}
          contributors={contributors}
          ownerId={ownerId}
          ownerName={ownerName}
          onOwner={(oid, oname) => setOwnerOverride({ ownerId: oid, ownerName: oname })}
          onRole={handleRoleOverride}
        />
      ),
    },
    { label: smes.length === 1 ? 'SME' : 'SMEs', people: smes.map((c) => ({ id: c.personId, name: c.name, ...(c.avatarUrl ? { avatarUrl: c.avatarUrl } : {}) })) },
  ];
  const repoHref = repoUrl ?? project.githubUrl ?? null;
  const statusLabel = project.status
    ? project.status.charAt(0).toUpperCase() + project.status.slice(1).replace(/_/g, ' ')
    : null;
  const firstEpic = workTree.find((n) => n.type === 'epic') ?? null;
  const onWork = tab === 'work';
  const focusedWork = onWork && !!wantedItem;
  const decisionsRead = { data: decisions ?? null, error: decisionsError ?? decisionsDegraded ?? null };

  const overview = buildOverview(project, { tree: treeRead, error: workFailure ?? null, loading: workLoading });
  const presenceChannel = scopePresenceChannel(project.id, focusedWork ? wantedItem : null);
  const workspaceHref = `/iq/search?scope=${encodeURIComponent(project.id)}`;
  const facts: InitiativeFactsInput = {
    project,
    statusLabel,
    owner: ownerName ? { name: ownerName, avatarUrl: ownerAvatar } : null,
    smes: smes.map((c) => ({ name: c.name, avatarUrl: c.avatarUrl ?? undefined })),
  };
  const detailsTrigger = <InitiativeDetailsTrigger onOpenDetails={() => paneControl.open('details')} />;
  const headerMenu = [{
        // Creating work is dispatch-gated server-side (POST /work-items), so
        // a role without it is not offered the menu entries.
        items: [
          ...(current ? [{ label: canDispatch ? 'Prepare job' : 'View job setup',
            'data-testid': 'work-item-prepare-job',
            onSelect: () => setPrepareJobRequest(previous => ({ itemId: current.id, revision: (previous?.revision ?? 0) + 1 })) }] : []),
          ...(canDispatch && current ? [{ label: `New story in ${current.epicTitle}`, onSelect: () => setCreating({ parentId: current.epicId, parentTitle: current.epicTitle }) }] : []),
          ...(canDispatch ? [{ label: 'New epic', onSelect: () => setCreating({ parentId: null, parentTitle: null }) }] : []),
          { label: 'Initiative details', onSelect: () => paneControl.open('details') },
          { label: 'Workspace documents', onSelect: () => current ? setDetailTab('docs') : setTab('docs') },
          { label: 'Contributors', onSelect: () => setTab('contributors') },
          ...(wideActions ? [] : [
            { label: 'Search in this initiative', onSelect: () => navigate(`/iq/search?scope=${encodeURIComponent(project.id)}`) },
            ...(repoHref ? [{ label: 'Repository', onSelect: () => { window.open(repoHref, '_blank', 'noopener,noreferrer'); } }] : []),
          ]),
        ],
      }];
  const headerActions = (
    <Inline gap="sm" wrap={false} justify="end" className="shrink-0" data-testid="initiative-header-actions">
      <ScopePresence key={presenceChannel} channel={presenceChannel} />
        <Inline gap="sm" wrap={false}>
          {/* A focused work item's header is only this cluster: the details trigger joins it. */}
          {focusedWork && detailsTrigger}
          {wideActions && <Tooltip content="Search in this initiative">
            <IconButton aria-label="Search in this initiative" variant="outline" size="sm"
              className="h-[26px] w-[26px]" data-testid="initiative-search-link"
              icon={<SearchIcon size={14} />}
              onClick={() => navigate(`/iq/search?scope=${encodeURIComponent(project.id)}`)} />
          </Tooltip>}
          {/* The workspace's governance documents, in the right pane at every width. */}
          <Tooltip content="Workspace documents">
            <IconButton aria-label="Workspace documents" variant="outline" size="sm"
              className="h-[26px] w-[26px]" data-testid="initiative-docs-link"
              icon={<DocumentIcon size={14} />}
              onClick={() => current ? setDetailTab('docs') : setTab('docs')} />
          </Tooltip>
          {initiativeCall.startButton}
          {wideActions && repoHref && <Tooltip content={project.repoFullName ?? repoHref.replace(/^https?:\/\/(www\.)?github\.com\//, '')}>
            <IconButton aria-label="Repository" variant="outline" size="sm"
              className="h-[26px] w-[26px]" data-testid="initiative-repo-link"
              icon={<CodeIcon size={14} />}
              onClick={() => { window.open(repoHref, '_blank', 'noopener,noreferrer'); }} />
          </Tooltip>}
        </Inline>
      {headerMenu.some((section) => section.items.length > 0) && <DropdownMenu trigger="⋯" triggerLabel={`${project.name} menu`}
        sections={headerMenu} align="end" triggerTestId="initiative-header-menu-trigger" data-testid="initiative-header-menu" />}
    </Inline>
  );
  const headerStatus = statusLabel
    ? <StatusPill label={statusLabel} tone={project.status === 'archived' ? 'neutral' : 'info'} variant="text" className="shrink-0 whitespace-nowrap" data-testid="initiative-header-status" />
    : undefined;
  // A focused work item's header is only the action cluster, for the item's
  // own title row (EditorShell `headActions`): the initiative's title band
  // between the trail and the item's title would push the title down
  // (docs/layout-cascade.md wants it directly under the trail).
  const header = focusedWork ? <Stack gap="none" data-testid="initiative-header">{headerActions}</Stack> : null;
  // The initiative's header: the library PageHeader owns the trail, the title
  // row, the people, the tabs, the density and the collapsed state.
  const pageHeader = (trail: BreadcrumbItem[]) => (
    <Stack gap="none" ref={measureRef}>
      <PageHeader
        {...headerDensity.headerProps}
        breadcrumbs={trail}
        title={project.name}
        // The info action and Shift+I reveal the same far-right Details pane.
        info={detailsTrigger}
        badge={headerStatus}
        {...(project.summary ? { description: project.summary } : {})}
        people={people}
        actions={headerActions}
        tabs={[
        { id: 'overview', label: 'Overview' },
        // The count is the rows we hold; none while the read is pending or failed.
        { id: 'work', label: 'Work', ...(treeRead && !workFailure ? { count: allRows.length } : {}) },
        { id: 'docs', label: 'Docs' },
        { id: 'decisions', label: 'Decisions', count: decisions?.length },
        // A count only when the roster was readable — "0" for a role that
        // cannot read bots would claim there are none.
        { id: 'agents', label: 'Agents', count: mayReadAgentWork && !agentActivity.botsError ? agentActivity.bots?.length : undefined },
        { id: 'contributors', label: 'Contributors', count: contributors.length },
        { id: 'activity', label: 'Activity' },
      ]}
        activeTab={tab}
        onTabChange={setTab}
        className="px-6"
        data-testid="initiative-header"
      />
    </Stack>
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
      : undefined;
  } else {
    subject = { kind: 'initiative', project: projectRef, rows: treeRead && !workFailure ? allRows : null };
    // On the Activity canvas the composer opens empty: its one row stays one row, so the graph keeps the column.
  }
  const composer = (
    <InitiativeComposer
      subject={subject}
      prompts={onWork && current ? jobPrompts : undefined}
      onAsk={request => {
        const accepted = agentPanel.current?.submit(request) ?? 'The Agent pane is not ready. Try again.';
        if (accepted === true) paneControl.open('agent');
        return accepted;
      }}
      defaultMode={composerSeed && onWork ? 'agent' : 'chat'}
      expanded
      dock={<Stack gap="none" className="max-h-64 overflow-y-auto">{initiativeCall.dock}</Stack>}
      setup={{ draft: '', draftKey: `initiative:${project.id}:discussion`, ...composerSetup }}
      // Chat → This item's Discussion posts to the same gateway thread the pane shows (its writers only).
      conversation={initiativeThread}
      onComment={() => { thread.refreshComments(); setDetailTab('history'); }}
      chatUnavailableReason={!canDispatch ? 'You can read messages. Your current role cannot post to this discussion.'
        : !initiativeThread ? 'The initiative discussion is still loading.' : undefined}
      chatPending={!capsReady || (canDispatch && !initiativeThread)}
    />
  );

  // The full backlog and selected item's rail share query, filters, sort and
  // permission-gated writes; switching presentation cannot retarget the item.
  const workListProps: WorkListViewProps = {
    searchPlaceholder: 'Find work…',
    groups: WORK_GROUPS.map((group) => group.id === 'in_progress' ? { ...group, defaultOpen: true } : group),
    items: visibleRows.map((r) => ({ ...toWorkListItem(r, marketRuns[r.id], pendingIds.has(r.id), { metaStyle: 'text', ownerAvatarUrl: r.assigneeId ? avatarOf(r.assigneeId) : undefined }), kindLabel: r.type === 'bug' ? 'Bug' : 'Story' })),
    count: allRows.length,
    currentId: current?.id ?? null,
    query: workSearch.searchText,
    onQueryChange: workSearch.onSearchChange,
    sort,
    sortOptions: WORK_SORT_OPTIONS.map((option) => ({ ...option, label: option.label.replace(/^By /, '').replace(/^./, (letter) => letter.toUpperCase()) })),
    onSortChange: (v) => setSort(v as WorkSort),
    filterFacets: [
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
      ],
    activeFilterCount: activeFilterCount(filters),
    onClearFilters: () => setFilters(NO_FILTERS),
    onOpenItem: (row) => openItem(row.id),
    onToggleDone: canDispatch
        ? (row, done) => {
            void patchItem(row.id, { status: done ? 'done' : 'open' }).then((ok) => {
              if (ok && row.id === current?.id) thread.refreshComments();
            });
          }
        : undefined,
    loading: workLoading && !rawTree,
    error: workFailure ? `The work list could not be read: ${workFailure}` : null,
    onRetry: refreshWork,
    emptyLabel: allRows.length > 0
        ? 'No work matches this search or these filters'
        : canDispatch
          ? "No work yet — ingest this initiative's documents or add an epic"
          : "No work yet — it arrives when this initiative's documents are ingested",
  };
  // WorkTableView does not contain its own width: a very long title grows the table past the pane and scrolls the
  // whole document sideways, so the table scrolls inside this wrapper instead.
  const workTable = <Stack gap="none" className="relative min-w-0 max-w-full overflow-x-auto">
    <WorkTableView {...workListProps} groupColors={{ done: 'var(--color-success)' }} data-testid="initiative-work-list" />
  </Stack>;
  const workRail = <WorkListView {...workListProps} groups={WORK_GROUPS.map(group => ({ ...group, defaultOpen: true }))}
    chrome="embedded" layout="rail" sortStyle="menu" onToggleDone={undefined} metaStyle="text" pointsLabel="points" data-testid="initiative-work-rail" />;
  const workRailHeader = <Stack gap="sm" data-testid="focused-work-navigation">
    <Select aria-label="Initiative" value={project.id} disabled={listRail.list.isLoading}
      options={[project, ...(listRail.list.data ?? []).filter(row => row.id !== project.id)]
        .map(row => ({ value: row.id, label: row.name }))}
      onChange={event => navigate(initiativeHref(event.target.value, searchParams, listRail.scope, 'work'))} />
    <Inline justify="between" align="center" gap="sm" wrap={false}>
      <Tabs aria-label="Work views" variant="underline" size="sm" value="work"
        items={[{ id: 'work', label: 'Work' }, { id: 'decisions', label: 'Decisions' }]} onValueChange={setTab} />
      <DropdownMenu trigger={<MoreIcon size={16} />} triggerLabel="More initiative views" triggerVariant="link" sections={[{ items: [
        { label: 'Overview', onSelect: () => setTab('overview') },
        { label: 'Agents', onSelect: () => setTab('agents') },
        { label: 'Contributors', onSelect: () => setTab('contributors') },
      ] }]} />
    </Inline>
  </Stack>;

  const workPane = current ? (
    <WorkItemDetail
      briefOpen={paneControl.isOpen && paneControl.tab === 'brief' && paneControl.recordId === current.id}
      onOpenBrief={() => {
        if (paneControl.isOpen && paneControl.tab === 'brief' && paneControl.recordId === current.id) paneControl.close();
        else paneControl.open('brief', current.id);
      }}
      item={current}
      // A focused item's header is only the action cluster, on the item's own
      // title row — nothing between the trail and the item's title.
      headActions={header}
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
        if (text) { conversationPane.reveal(); setComposerSeed((prev) => ({ itemId: current.id, text, n: (prev?.n ?? 0) + 1 })); }
      }}
      onAddContext={() => setBriefDialog('context')}
      onAddNote={() => setBriefDialog('note')}
      onOpenDiscussion={() => paneControl.open('discussion')}
    />
  ) : (
    <Stack gap="sm" className="px-6 py-4">
      {focusedWork && <PageHeader title="Work item" density="compact" />}
      <EmptyState
        title={workLoading ? 'Loading work…' : wantedItem ? 'Work item unavailable' : 'Select a work item'}
        body={workLoading ? undefined : wantedItem ? 'This item is not in the current work list. Choose another item from the rail.' : 'Choose an item from the Work list to see its brief, discussion, and activity.'}
      />
    </Stack>
  );

  return (
    <>
      <InitiativesExplorer
        rail={focusedWork ? {
          title: 'Work', ...(treeRead && !workFailure ? { count: allRows.length } : {}),
          header: workRailHeader, body: workRail, label: 'work items',
          footer: <Button variant="ghost" size="sm" onClick={() => setSearchParams(prev => {
            const params = new URLSearchParams(prev); params.delete('item'); params.delete('view'); return params;
          })} data-testid="initiative-all-work">All work</Button>,
        } : listRail.rail}
        scope={listRail.scope}
        lens={listRail.lens}
        collapsible
        combinedNavigation
        focusedWork={focusedWork}
        composer={<ComposerSurface data-testid="initiative-central-composer">{composer}</ComposerSurface>}
        breadcrumbs={initiativeBreadcrumbs({ search: searchParams, scope: listRail.scope, project, tab: wantedItem ? tab : 'overview', item: current?.key ?? undefined })
          .filter((crumb) => !['Plan', 'All initiatives', 'My initiatives', ...(current ? ['Work'] : [])].includes(crumb.label))}
        paneHeader={focusedWork ? undefined : pageHeader}
        // The central dock owns the input; the wider right pane owns the transcript.
        data-testid="initiative-workspace"
      >
        {tab === 'overview' && (
          <InitiativeOverview
            model={overview}
            decisions={decisions ?? null}
            onOpen={(href) => {
              const [path, childSearch] = href.split('?');
              const params = new URLSearchParams(initiativeHref(project.id, searchParams, listRail.scope).split('?')[1]);
              new URLSearchParams(childSearch).forEach((value, key) => params.set(key, value));
              navigate(`${path}?${params}`);
            }}
            onRetry={refreshWork}
            recent={<RecentWorkActivity people={contributors} subject={{ kind: 'initiative', id: project.id }} onOpenActivity={() => setTab('activity')} />}
          />
        )}
        {tab === 'activity' && (
          // Its own content expansion: the library canvas owns the timeline row
          // (day/range, Following now) and fills the pane — no card, no second scroll.
          <Stack gap="none" className="h-full min-h-0 w-full" ref={headerDensity.contentRef} data-testid="initiative-activity">
            <Stack gap="none" className="shrink-0 border-b border-border px-6 py-3"><InitiativeRecordings projectId={project.id} projectName={project.name} preview onOpen={openRecording} /></Stack>
            <Stack gap="none" className="min-h-0 flex-1">
            <WorkGraphActivity
              subject={{ kind: 'initiative', id: project.id }}
              cursorChannel={`orgiq:initiative:${project.id}`}
              mode="full"
              className="h-full min-h-0 w-full"
              onPopOut={() => navigate(`/iq/activity?initiative=${encodeURIComponent(project.id)}`)}
            />
            </Stack>
          </Stack>
        )}
        {onWork && (wantedItem ? workPane : workTable)}
        {!onWork && tab !== 'overview' && tab !== 'activity' && (
          <Stack gap="md" className="px-6 pb-6 pt-4">
            {tab === 'decisions' && <DecisionQueue decisions={decisions ?? []} onOpen={(decisionId) => paneControl.open('decision', decisionId)} />}
            {tab === 'docs' && <>
              {searchParams.has('recording') ? <InitiativeRecordings projectId={project.id} projectName={project.name} onOpen={openRecording} />
                : <InitiativeFiles projectId={project.id} projectName={project.name} itemIds={treeRead && !workFailure ? [...new Set([...workTree.map(epic => epic.id), ...allRows.map(row => row.id)])] : null} workspaceHref={workspaceHref} onOpenRecording={openRecording} />}
            </>}
            {tab === 'agents' && (
              <InitiativeRail
                initiativeId={id}
                activity={agentActivity}
                codebases={codebases}
                runs={marketplaceRuns}
                workTree={workTree}
                onOpenLog={(jobId) => paneControl.open('log', jobId)}
              />
            )}
            {tab === 'contributors' && (
              <ContributorsTable
                contributors={contributors}
                projectId={id ?? ''}
                onRole={handleRoleOverride}
                onOpenPerson={(personId) => paneControl.open('person', personId)}
              />
            )}
          </Stack>
        )}
      </InitiativesExplorer>

      {/* The fourth column: the initiative's conversation, Agent, Details and
          any record a page link opened (a run's Log, a Decision, a Person). */}
      <ConversationOwner key={scopeDiscussionChannel(project.id)} channel={scopeDiscussionChannel(project.id)} maySend={canDispatch} onChange={setInitiativeThread} />
      <InitiativeSidePane
        control={paneControl}
        subtitle={project.name}
        workItemLabel={current ? `${current.key ?? 'Work item'} · ${current.title}` : undefined}
        agent={<InitiativeAgentPanel key={`${session?.tenant}:${session?.sub}:${session?.role}:${project.id}`} projectId={project.id} ref={agentPanel} onOpenWorkItem={openItem} />}
        facts={facts}
        overview={overview}
        decisions={decisions ?? null}
        workItemIds={treeRead && !workFailure ? [...new Set([...workTree.map((epic) => epic.id), ...flattenWorkItems(workTree).map((row) => row.id)])] : null}
        workspaceHref={workspaceHref}
        onOpenWorkItem={openItemFromPane}
        onOpenDecisions={() => setTab('decisions')}
        discussion={(
          <Stack gap="none" className="h-full min-h-0" data-testid="initiative-live-discussion">
            <Inline gap="sm" justify="between" align="center" className="border-b border-border px-4 py-2">
              <T size="xs" tone="secondary">Initiative channel</T>
              <DropdownMenu trigger={<T as="span" size="xs" weight="medium">View: {conversationFilter === 'all' ? 'All messages' : conversationFilter === 'initiative' ? 'Initiative only' : 'Dialogue'}</T>}
                triggerLabel="Filter initiative conversation" triggerVariant="link" align="end"
                triggerTitle="Filter the messages you can read. This does not change posting access."
                triggerTestId="initiative-conversation-filter" data-testid="initiative-conversation-filter-menu"
                className="w-[280px] max-w-[calc(100vw-32px)]"
                sections={[{ label: 'Message view', items: [
                  { label: 'Dialogue', checked: conversationFilter === 'dialogue', description: 'Conversation, excluding work-log notes', onSelect: () => setConversationFilter('dialogue') },
                  { label: 'All messages', checked: conversationFilter === 'all', description: 'Conversation and work-item comments', onSelect: () => setConversationFilter('all') },
                  { label: 'Initiative only', checked: conversationFilter === 'initiative', description: 'Messages without work-item context', onSelect: () => setConversationFilter('initiative') },
                ] }]} />
            </Inline>
            {/* The thread only: its one input is the content column's composer. */}
            {initiativeThread && <ConversationThread key={project.id} conversation={{ ...initiativeThread, chat: { ...initiativeThread.chat, messages: initiativeConversationMessages(initiativeThread.chat.messages, conversationFilter) } }} title="Initiative discussion" input="below" notices includeFiles={false}
              renderMessageReferences={workConversationReferences(project.id, openItem, treeRead && !workFailure ? [...workTree, ...allRows] : null)}
              emptyState={<Stack gap="xs" className="px-4 py-4" data-testid="initiative-conversation-empty">
                <T size="sm" weight="semibold">{initiativeThread.chat.messages.length ? 'No messages in this view' : 'No messages yet'}</T>
                <T size="xs" tone="secondary" wrap>{initiativeThread.chat.messages.length
                  ? 'Other messages are available in All messages.'
                  : canDispatch ? 'Write in the composer below. Use /comment for a work-item note.' : 'Messages will appear here when someone posts.'}</T>
                {initiativeThread.chat.messages.length > 0 && <Button variant="link" size="sm" className="self-start" onClick={() => setConversationFilter('all')} data-testid="initiative-conversation-show-all">
                  <T as="span" size="xs">Show all messages</T>
                </Button>}
              </Stack>}
              pins={{ canPin: canDispatch }} attachments={canDispatch} reactions data-testid="scope-discussion-panel" />}
          </Stack>
        )}
      />

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
          onPost={postToThread}
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

    </>
  );
}

export default ProjectDetailPage;
