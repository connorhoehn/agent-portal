// Who would receive a runbook proposal: the open work items the real selector would give its
// text to, if it were published at the scope the proposal asks for.
//
// Nothing here is a second selector. For every candidate work item it runs `selectRunbooks`
// with the published library plus the proposal applied (a new runbook added, an edit replacing
// its base version, a restore bringing a retired runbook back, a retire taking it out), and
// reads the answer: first MAX_GIVEN_RUNBOOKS of the selection is what a run is handed, the rest
// is passed over on the limit. The token budget the brief adds on top is not modelled.
import type { Runbook, RunbookDoc, RunbookHealth, RunbookProposal, RunbookScope, RunbookVersion } from './types.js';
import { MAX_GIVEN_RUNBOOKS, selectRunbooks, type RunbookCandidate, type WorkItemContext } from './select.js';
import { versionOf } from './version.js';

/** At most this many items are returned; the total is always counted. */
export const REACH_MAX_ITEMS = 20;
/** An org-wide (or tool) scope looks at this many most recently updated open items, and says so. */
export const REACH_SCAN_CAP = 200;

export interface ReachWorkItem {
  id: string;
  key: string | null;
  title: string;
  description: string | null;
  labels: string[];
  projectId: string;
  projectName: string;
  runbookPins: string[];
  updatedAt: string;
}

export interface ReachInitiative { id: string; name: string; repo: string | null }

/** Where the reach reads its work from; injected by suites. */
export interface ReachSource {
  /** Every initiative with the repository it works in. */
  initiatives(): Promise<ReachInitiative[]>;
  /** Open work (not done, not cancelled) of one initiative, most recently updated first. */
  openWork(initiativeId: string, limit: number): Promise<ReachWorkItem[]>;
  /** Open work across the organisation, most recently updated first. */
  openWorkOrgWide(limit: number): Promise<ReachWorkItem[]>;
}

export interface ReachItem {
  id: string;
  key: string | null;
  title: string;
  initiative: { id: string; name: string };
  /** `chosen`: the runbook is given to a run of this item. `passed_over`: it matched but lost on the two-runbook limit. */
  outcome: 'chosen' | 'passed_over';
}

export interface ProposalReach {
  /** `receive`: new and edit. `lose`: retire. `gain`: restore. */
  mode: 'receive' | 'lose' | 'gain';
  scope: RunbookScope;
  items: ReachItem[];
  /** Every open work item that qualifies, not only the ones listed. */
  total: number;
  /** How many open work items were looked at. */
  scanned: number;
  /** True when the scan stopped at the cap, so the total may be low. */
  capped: boolean;
}

const base = (repo: string | null | undefined) => (repo ? repo.replace(/\.git$/, '').split('/').pop()!.toLowerCase() : '');
const NO_HEALTH: RunbookHealth = { status: 'unproven', reason: 'Not yet used.', warning: null };

/** The work the scope can reach. Repo scope: the initiatives working in that repository. Initiative scope: that one. */
async function workInScope(source: ReachSource, scope: RunbookScope): Promise<{ items: ReachWorkItem[]; capped: boolean; repos: Map<string, string | null> }> {
  const initiatives = await source.initiatives();
  const repos = new Map(initiatives.map((i) => [i.id, i.repo] as const));
  let ids: string[] | null = null;
  if (scope.kind === 'initiative' && scope.ref) ids = [scope.ref];
  else if (scope.kind === 'repo' && scope.ref) ids = initiatives.filter((i) => base(i.repo) === base(scope.ref)).map((i) => i.id);
  if (ids === null) {
    const items = await source.openWorkOrgWide(REACH_SCAN_CAP + 1);
    return { items: items.slice(0, REACH_SCAN_CAP), capped: items.length > REACH_SCAN_CAP, repos };
  }
  const all: ReachWorkItem[] = [];
  let capped = false;
  for (const id of ids) {
    const rows = await source.openWork(id, REACH_SCAN_CAP + 1);
    if (rows.length > REACH_SCAN_CAP) capped = true;
    all.push(...rows.slice(0, REACH_SCAN_CAP));
  }
  all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
  if (all.length > REACH_SCAN_CAP) capped = true;
  return { items: all.slice(0, REACH_SCAN_CAP), capped, repos };
}

export interface ReachInput {
  proposal: RunbookProposal;
  /** The runbook a non-new proposal targets. */
  target: Runbook | null;
  /** The scope a new proposal would be published at; a target's own scope is used otherwise. */
  newScope: RunbookScope;
  /** Published runbooks, as the selector sees them today. */
  candidates: readonly RunbookCandidate[];
  /** The target's current version, for restore. */
  targetVersion: RunbookVersion | null;
  source: ReachSource;
}

/** Null when the proposal has nothing to reach (a retire or edit whose runbook is not published, a draft with no text). */
export async function proposalReach(input: ReachInput): Promise<ProposalReach | null> {
  const { proposal: p, target, candidates } = input;
  const mode: ProposalReach['mode'] = p.kind === 'retire' ? 'lose' : p.kind === 'restore' ? 'gain' : 'receive';
  const scope = p.kind === 'new' ? input.newScope : target?.scope ?? input.newScope;
  const published = new Map(candidates.map((c) => [c.runbook.id, c] as const));

  let after: RunbookCandidate[];
  if (p.kind === 'new') {
    if (!p.proposed) return null;
    const id = p.proposed_id ?? '~proposed';
    const runbook: Runbook = { id, scope, owner_person_id: '-', status: 'published', current_version: 1, created_at: p.created_at, updated_at: p.created_at };
    const version = versionOf({ runbook_id: id, version: 1, doc: p.proposed as RunbookDoc, author: { kind: 'person', id: '-' }, files: p.proposed_files ?? [] });
    after = [...candidates.filter((c) => c.runbook.id !== id), { runbook, version, health: NO_HEALTH }];
  } else if (p.kind === 'edit') {
    const current = target ? published.get(target.id) : undefined;
    if (!target || !current || !p.proposed) return null;
    const version = versionOf({ runbook_id: target.id, version: current.version.version, doc: p.proposed as RunbookDoc, author: { kind: 'person', id: '-' }, files: p.proposed_files ?? current.version.files ?? [] });
    after = candidates.map((c) => (c.runbook.id === target.id ? { ...c, version } : c));
  } else if (p.kind === 'retire') {
    if (!target || !published.has(target.id)) return null;
    after = candidates.filter((c) => c.runbook.id !== target.id);
  } else {
    if (!target || target.status !== 'retired' || !input.targetVersion) return null;
    after = [...candidates, { runbook: { ...target, status: 'published' }, version: input.targetVersion, health: NO_HEALTH }];
  }
  const id = p.kind === 'new' ? (p.proposed_id ?? '~proposed') : target!.id;

  const { items, capped, repos } = await workInScope(input.source, scope);
  const outcomeOf = (candidateSet: readonly RunbookCandidate[], w: ReachWorkItem): ReachItem['outcome'] | null => {
    const ctx: WorkItemContext = {
      id: w.id, title: w.title, description: w.description ?? '', labels: w.labels,
      repo: repos.get(w.projectId) ?? null, initiative_id: w.projectId, pinned_runbook_ids: w.runbookPins,
    };
    const at = selectRunbooks(ctx, candidateSet).selected.findIndex((s) => s.runbook_id === id);
    return at < 0 ? null : at < MAX_GIVEN_RUNBOOKS ? 'chosen' : 'passed_over';
  };

  const hits: ReachItem[] = [];
  for (const w of items) {
    let outcome: ReachItem['outcome'] | null;
    if (mode === 'lose') outcome = outcomeOf(candidates, w) === 'chosen' ? 'chosen' : null;
    else if (mode === 'gain') outcome = outcomeOf(after, w) === 'chosen' ? 'chosen' : null;
    else outcome = outcomeOf(after, w);
    if (outcome) hits.push({ id: w.id, key: w.key, title: w.title, initiative: { id: w.projectId, name: w.projectName }, outcome });
  }
  return { mode, scope, items: hits.slice(0, REACH_MAX_ITEMS), total: hits.length, scanned: items.length, capped };
}

const OPEN_STATUSES = ['open', 'in_progress', 'in_review'] as const;
const newestFirst = (a: ReachWorkItem, b: ReachWorkItem) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1);

/**
 * The reach's source over the work-item and initiative providers. These are the reads behind
 * `GET /api/graph/work` and `/projects/:id/work`, which any member of the orgiq tenant may make;
 * the proposal route is gated on that tenant, so the reviewer sees what those routes would show.
 */
export async function providerReachSource(): Promise<ReachSource> {
  const [{ listProjects }, { getProjectWorkItems, searchWorkItems }] = await Promise.all([
    import('../../providers/projects.js'),
    import('../../providers/work-items.js'),
  ]);
  type Row = Awaited<ReturnType<typeof searchWorkItems>>[number];
  const view = (w: Row): ReachWorkItem => ({
    id: w.id, key: w.key ?? null, title: w.title, description: w.description, labels: w.labels ?? [],
    projectId: w.projectId, projectName: w.projectName, runbookPins: w.runbookPins ?? [], updatedAt: w.updatedAt,
  });
  const isOpen = (w: Row) => (OPEN_STATUSES as readonly string[]).includes(w.status);
  return {
    async initiatives() {
      return (await listProjects({ limit: 200 })).map((p) => ({ id: p.id, name: p.name, repo: p.repoFullName }));
    },
    async openWork(initiativeId, limit) {
      return (await getProjectWorkItems(initiativeId, 500)).filter(isOpen).map(view).sort(newestFirst).slice(0, limit);
    },
    async openWorkOrgWide(limit) {
      const per = await Promise.all(OPEN_STATUSES.map((status) => searchWorkItems({ status, limit: Math.min(limit, 200) })));
      return per.flat().map(view).sort(newestFirst).slice(0, limit);
    },
  };
}
