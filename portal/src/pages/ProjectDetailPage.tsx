// Mission control for an initiative: one owner, SMEs directing agents.
//
// This file owns state, data and which child is mounted — nothing else. The
// header, the work column, the board, the rail, the tables, the modal and the
// forms are in ./project-detail, one component per file; the tone lookups and
// tree arithmetic are in ./project-detail/projectFormat, which has no React in
// it at all.

import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Button,
  Chip,
  ErrorState,
  Inline,
  LoadingState,
  PageSection,
  Stack,
  TabPanel,
  Tabs,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useCapabilities } from '../lib/capabilities';
import { useSession } from '../lib/auth';
import { githubRepoUrl } from '../lib/repoLink';
import { EstimateDrawer } from '../components/marketplace/EstimateDrawer';
import { useInitiativeAgentActivity } from '../components/marketplace/InitiativeAgentRail';
import type { BotRun } from './bots/BotsPage';
import { ContributorModal } from './project-detail/ContributorModal';
import { ContributorsTable } from './project-detail/ContributorsTable';
import { DecisionQueue } from './project-detail/DecisionQueue';
import { InitiativeHeader } from './project-detail/InitiativeHeader';
import { InitiativeRail } from './project-detail/InitiativeRail';
import { WorkPanel } from './project-detail/WorkPanel';
import type { NewItemDraft } from './project-detail/NewItemForm';
import {
  hasActiveGrantOnInitiative,
  runsByWorkItem,
  sumForestPoints,
} from './project-detail/projectFormat';
import {
  HttpError,
  dropFromTree,
  insertChild,
  isPendingId,
  mapTree,
  sendJson,
  surfaceWriteError,
} from './project-detail/writeJson';
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

  const [tab, setTab] = useState('work');

  const { data: project, isLoading: projLoading, error: projError } =
    useFetch<ProjectDetail>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : '');

  const { data: rawTree, isLoading: workLoading } =
    useFetch<WorkItemTree[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/work` : '');

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
  // click away. That list endpoint is tenant-gated only and every role that can
  // open this page can read it, so take the number from there and let the
  // Initiatives list and this header agree by construction.
  const { data: projectList, isLoading: projectListLoading } =
    useFetch<Array<{ id: string; agentSpendUsd: number | null; repoFullName?: string | null }>>('/api/graph/projects', 60_000);
  const projectRollup = (projectList ?? []).find((p) => p.id === id);
  const serverSpendUsd = projectRollup?.agentSpendUsd ?? null;
  // Mission-2 codebase link — the initiative's repo, from the same rollup.
  const repoUrl = githubRepoUrl(projectRollup?.repoFullName);

  const marketRuns = runsByWorkItem(marketplaceRuns);
  const workTree = localItems ?? rawTree ?? [];

  // Status toggle — optimistic, then confirmed. A failure puts the row back
  // where it was and says why, rather than leaving a tick the server refused.
  const handleStatusToggle = useCallback((itemId: string, current: WorkItemStatus) => {
    const newStatus: WorkItemStatus = current === 'done' ? 'open' : 'done';
    const setStatus = (want: WorkItemStatus) => (nodes: WorkItemTree[]) =>
      mapTree(nodes, (n) => (n.id === itemId ? { ...n, status: want } : n));

    setLocalItems(setStatus(newStatus)(localItems ?? rawTree ?? []));

    // An item this page created but the server never acknowledged has a
    // client-side id; PATCHing it can only 404, and the row would silently
    // stay ticked until the next reload dropped it.
    if (isPendingId(itemId)) {
      setLocalItems((prev) => setStatus(current)(prev ?? rawTree ?? []));
      toastError(null, 'Not saved', 'This item has not been created on the server yet — reload and try again.');
      return;
    }

    void (async () => {
      try {
        await sendJson(`/api/graph/work-items/${encodeURIComponent(itemId)}`, 'PATCH', { status: newStatus });
      } catch (err) {
        setLocalItems((prev) => setStatus(current)(prev ?? rawTree ?? []));
        surfaceWriteError(err, 'Updating this item');
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

  const handleAddItem = useCallback((parentId: string, draft: NewItemDraft) => {
    createItem(parentId, draft);
  }, [createItem]);

  const handleAddEpic = useCallback((draft: NewItemDraft) => {
    createItem(null, draft);
  }, [createItem]);

  // Marketplace: the item being estimated, and the optimistic flip on 202.
  const [estimateItem, setEstimateItem] = useState<WorkItemTree | null>(null);

  const handleDispatched = useCallback((workItemId: string, _run: BotRun) => {
    setLocalItems((prev) => mapTree(prev ?? rawTree ?? [], (n) =>
      (n.id === workItemId ? { ...n, status: 'in_progress' as WorkItemStatus } : n)));
  }, [rawTree]);

  if (projLoading) {
    return <PageSection title="Project"><LoadingState label="Loading project…" /></PageSection>;
  }
  if (projError) {
    return (
      <PageSection title="Project">
        <ErrorState title="Failed to load this project" body={projError} action={<BackToProjects />} />
      </PageSection>
    );
  }
  if (!project) {
    return (
      <PageSection title="Project">
        <ErrorState title="Project not found" action={<BackToProjects />} />
      </PageSection>
    );
  }

  const escalatedCount = (decisions ?? []).filter((d) => d.status === 'escalated').length;
  const openDecisionCount = (decisions ?? []).filter((d) => d.status === 'open' || d.status === 'escalated').length;
  // Governance, with optimistic overrides applied on top of the fetch.
  const contributors = project.contributors.map((c) =>
    c.personId in roleOverrides ? { ...c, role: roleOverrides[c.personId] ?? null } : c,
  );
  const ownerId = ownerOverride ? ownerOverride.ownerId : project.ownerId ?? null;
  const ownerName = ownerOverride ? ownerOverride.ownerName : project.ownerName ?? null;
  // Cross-initiative SMEs — the people directing agents here.
  const smes = contributors.filter((c) => (c.role ?? '').toLowerCase() === 'sme');
  const points = sumForestPoints(workTree);

  // Work, decisions and attribution used to be a pane plus two collapsibles
  // wedged into two columns. They are three unrelated concerns, so they are
  // three tabs: one is on screen, the counts stay visible on the triggers.
  const tabs = [
    { id: 'work', label: 'Work' },
    // Activity is not a tab: it sits in the fixed rail beside the work, so
    // the day-by-day lines are readable while the table scrolls.
    {
      id: 'decisions',
      label: 'Decisions',
      badge: escalatedCount > 0
        ? <Chip tone="danger" size="xs">{escalatedCount}</Chip>
        : (decisions ?? []).length > 0
          ? <Chip tone="neutral" size="xs" mono>{(decisions ?? []).length}</Chip>
          : undefined,
    },
    {
      id: 'contributors',
      label: 'Contributors',
      badge: contributors.length > 0
        ? <Chip tone="neutral" size="xs" mono>{contributors.length}</Chip>
        : undefined,
    },
  ];

  return (
    <Stack gap="lg" className="pb-16">
      {/* Two columns from the top of the page: the header, tabs and table on
          the left; the rail on the right runs the full height beside them
          and stays put while the left column scrolls. */}
      <Inline gap="lg" align="start" wrap={false} className="items-start">
        <Stack gap="lg" className="min-w-0 flex-1 basis-[520px]">
      <InitiativeHeader
        project={project}
        projectId={id ?? ''}
        contributors={contributors}
        ownerId={ownerId}
        ownerName={ownerName}
        smes={smes}
        points={points}
        openDecisionCount={openDecisionCount}
        escalatedCount={escalatedCount}
        spend={{
          serverSpendUsd,
          serverPending: projectListLoading,
          clientSpendUsd: agentActivity.spendUsd,
          // Blind if we could not read the roster OR could not read a bot's
          // run history — either way the client sum is a floor, not a total.
          clientBlind: agentActivity.botsError != null || agentActivity.runsError != null,
          clientPending: agentActivity.botsLoading,
        }}
        repoUrl={repoUrl ?? project.githubUrl ?? null}
        repoLabel={projectRollup?.repoFullName ?? (repoUrl ? null : project.githubUrl ? 'GitHub' : null)}
        repoCount={codebases.length}
        onOwner={(oid, oname) => setOwnerOverride({ ownerId: oid, ownerName: oname })}
        onRole={handleRoleOverride}
      />

        <Stack gap="md">
          <Tabs
            idPrefix="initiative"
            aria-label="Initiative detail"
            items={tabs}
            value={tab}
            onValueChange={setTab}
          />

          <TabPanel id="work" when={tab} idPrefix="initiative">
            <WorkPanel
              workTree={workTree}
              workLoading={workLoading}
              canDispatch={canDispatch}
              showGrantCue={showGrantCue}
              marketRuns={marketRuns}
              onStatusToggle={handleStatusToggle}
              onAddItem={handleAddItem}
              onAddEpic={handleAddEpic}
              onEstimate={setEstimateItem}
            />
          </TabPanel>

          <TabPanel id="decisions" when={tab} idPrefix="initiative">
            <DecisionQueue decisions={decisions ?? []} />
          </TabPanel>

          <TabPanel id="contributors" when={tab} idPrefix="initiative">
            <ContributorsTable
              contributors={contributors}
              projectId={id ?? ''}
              onRole={handleRoleOverride}
              onOpenPerson={handleOpenPerson}
            />
          </TabPanel>
        </Stack>
        </Stack>

        {/* The rail is fixed: it sticks to the top of the shell's scroll
            container and scrolls inside itself when its cards are taller than
            that container. Its ceiling is the container's height (the
            viewport minus the shell chrome, --shell-chrome-h in app.css) — a
            rail taller than the container cannot be pinned and clips. */}
        <Stack
          gap="sm"
          className="sticky top-0 max-h-[calc(100vh-var(--shell-chrome-h))] w-[320px] shrink-0 self-start overflow-y-auto rounded-lg bg-surface-panel p-3"
        >
          <InitiativeRail
            initiativeId={id}
            activity={agentActivity}
            codebases={codebases}
            runs={marketplaceRuns}
            workTree={workTree}
          />
        </Stack>
      </Inline>

      {/* Contributor detail card — opened from the identity line or the table,
          keeping the user (and their breadcrumb) on this initiative. */}
      {openPerson && (
        <ContributorModal
          personId={openPerson.id}
          roleLabel={openPerson.role}
          onClose={() => setOpenPerson(null)}
        />
      )}

      {/* Marketplace: estimate → authorize drawer */}
      <EstimateDrawer
        open={estimateItem != null}
        onClose={() => setEstimateItem(null)}
        item={estimateItem}
        codebases={codebases.map((cb) => ({ id: cb.id, repoFullName: cb.repoFullName }))}
        // The initiative this run is charged to — the drawer reads the caller's
        // own sprint envelope on it and reports what is left BEFORE they
        // authorize, instead of leaving the envelope brake's 409 to say it.
        orgProjectId={id ?? null}
        onDispatched={handleDispatched}
      />
    </Stack>
  );
}

export default ProjectDetailPage;
