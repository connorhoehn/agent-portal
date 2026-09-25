// The shapes the initiative detail page reads off the API.
//
// The taxonomy is deliberately flat: epics contain stories and bugs, and that's
// the tree. Stories and bugs are the dispatchable units; the server migrates
// legacy feature/task rows to story.

export type WorkItemType = 'epic' | 'story' | 'bug';
export type WorkItemStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type WorkItemPriority = 'critical' | 'high' | 'medium' | 'low';
export type PrStatus = 'open' | 'draft' | 'merged' | 'closed';

/**
 * Which pane of the work column is mounted.
 *
 * `items` is the default and the flat one: the initiative's whole backlog as a
 * sortable table, with the epic reduced to a column and a filter. `epics` is
 * the rollup for when you want progress per epic rather than the work itself.
 */
export type WorkView = 'items' | 'board' | 'epics';

export interface WorkItem {
  id: string;
  projectId: string;
  projectName: string;
  parentId: string | null;
  type: WorkItemType;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeDept: string | null;
  labels: string[];
  storyPoints: number | null;
  /**
   * The brief fields (M2: work_items.summary / blocked_reason / next_step /
   * next_step_detail). Optional and nullable: an Aurora cluster that has not
   * applied the columns yet sends null (or nothing), and every consumer reads
   * that as "not written", never as an empty string to render.
   */
  /** One sentence: what this item changes. The Plan-next row's description. */
  summary?: string | null;
  /** Why the item cannot move — set alongside the `blocked` label. */
  blockedReason?: string | null;
  /** The next concrete action, e.g. "Confirm the dependency map with Eli Garcia." */
  nextStep?: string | null;
  /** Why that step comes first. */
  nextStepDetail?: string | null;
  /**
   * Estimate provenance, straight off the wire
   * (schema/work_item_estimate_schema.sql). All null until somebody authorizes
   * a dispatch — that is the ordinary state, not a gap.
   */
  estimatedCostUsd?: number | null;
  estimatedBy?: string | null;
  estimatedByName?: string | null;
  estimatedAt?: string | null;
  estimateModel?: string | null;
  estimateForecast?: Record<string, unknown> | null;
  estimateReviewedBy?: string | null;
  estimateReviewedByName?: string | null;
  estimateReviewedAt?: string | null;
  prUrl: string | null;
  prStatus: PrStatus | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  childCount: number;
  childDoneCount: number;
}

export interface WorkItemTree extends WorkItem {
  children: WorkItemTree[];
}

export interface ProjectDecision {
  id: string;
  topic: string;
  summary: string | null;
  status: string;
  requiredRole: string | null;
  escalatedAt: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
}

export interface ProjectContributor {
  personId: string;
  name: string;
  title: string | null;
  role: string | null;
  weight: number;
}

export interface ProjectDetail {
  id: string;
  name: string;
  status: string | null;
  description?: string | null;
  githubUrl?: string | null;
  // Owner — who runs this initiative. Optional: render when present, omit
  // cleanly when the detail response doesn't carry it yet.
  ownerId?: string | null;
  ownerName?: string | null;
  /** Prose: what this initiative is for. One to three sentences. */
  summary?: string | null;
  // Sponsor — the executive who authorized the initiative existing, and whose
  // budget it draws on. Distinct from the OWNER, who runs it day to day: the
  // page previously showed only the latter, so nothing on it answered "who
  // signed off on this" — the question every funding conversation opens with.
  sponsorId?: string | null;
  sponsorName?: string | null;
  sponsorTitle?: string | null;
  createdAt: string | null;
  /** Agent spend month-to-date — same window/number the Initiatives list
      reports for this id. Null when the underlying tables predate the
      work-items schema. */
  agentSpendUsd?: number | null;
  /** The `owner/repo` this initiative's code lives in, null when unlinked. */
  repoFullName?: string | null;
  /** Marketplace runs in flight on this initiative, counted from `running`
      bot_runs rows (M1). Null when the server could not count them — which
      is "unknown", not zero. */
  activeAgentRuns?: number | null;
  /** This month's allocation (initiative_budgets) the MTD spend reads
      against. Null when no allocation exists. */
  allocatedUsd?: number | null;
  contributors: ProjectContributor[];
}

/** One row of the ManageDevbox-gated codebase list, filtered to this initiative. */
export interface Codebase {
  id: string;
  repoFullName: string;
  orgProjectId: string | null;
}

/** The person card the contributor modal fetches. */
export interface PersonDetail {
  id: string;
  name: string;
  title: string | null;
  department: string | null;
  skills: string[];
  influenceScore: number | null;
  connections: Array<{
    strength: number;
    otherPerson: { id: string; name: string; title: string | null };
  }>;
}

// The slice of the `/api/sprints?scope=mine` contract this page needs — same
// fields SprintsPage keys its "Your envelope" badge on (Sprint.orgProjectId,
// Sprint.status, Sprint.isGrantee in pages/sprints/SprintsPage.tsx).
export interface MyScopedSprint {
  orgProjectId: string;
  status: string;
  isGrantee: boolean;
}

export interface MyScopedSprintsResponse {
  sprints: MyScopedSprint[];
}
