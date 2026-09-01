// The shapes the initiative detail page reads off the API.
//
// The taxonomy is deliberately flat: epics contain stories and bugs, and that's
// the tree. Stories and bugs are the dispatchable units; the server migrates
// legacy feature/task rows to story.

export type WorkItemType = 'epic' | 'story' | 'bug';
export type WorkItemStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type WorkItemPriority = 'critical' | 'high' | 'medium' | 'low';
export type PrStatus = 'open' | 'draft' | 'merged' | 'closed';

/** Which pane of the work column is mounted. */
export type WorkView = 'tree' | 'board';

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
  createdAt: string | null;
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
