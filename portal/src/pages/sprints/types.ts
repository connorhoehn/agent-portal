// The wire contracts this page reads: /api/sprints, /api/graph/work,
// /api/grants, /api/graph/projects/:id, /api/roster.
//
// Split out of SprintsPage.tsx so the six view components can share one
// definition of a Sprint rather than each importing from a 1,276-line module
// that also owns fetching, validation, modals, tables and forms.

export interface Sprint {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  name: string;
  goal: string | null;
  stewardPersonId: string | null;
  stewardName: string | null;
  stewardAvatarUrl?: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
  itemCount: number;
  doneItemCount: number;
  pointsTotal: number;
  pointsDone: number;
  /** Sum of work_items.estimated_cost_usd — what the sprint was planned to cost. */
  estimatedCostUsd: number;
  /** budget_grants.allocated_usd scoped to this sprint. */
  grantedUsd: number;
  grantCount: number;
  /** Initiative spend inside the sprint dates. NOT anyone's personal burn. */
  initiativeSpendInWindowUsd: number;
  isSteward: boolean;
  isGrantee: boolean;
  myItemCount: number;
  myOpenItemCount: number;
}

export interface SprintsResponse {
  scope: 'mine' | 'all';
  /** people.id behind the session, or null for an unlinked account. */
  personId: string | null;
  canSeeAll: boolean;
  sprints: Sprint[];
}

export interface WorkItem {
  id: string;
  projectId: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  storyPoints: number | null;
  estimatedCostUsd: number | null;
  prUrl: string | null;
  /** ISO timestamp of the last change; the board's "Recently updated" quick filter. */
  updatedAt?: string;
}

// The GrantRow the /api/grants contract returns (a subset — the fields this
// page renders).
export interface GrantRow {
  id: string;
  granteePersonId: string;
  granteeName: string | null;
  allocatedUsd: number;
  grantedBy: string | null;
  /** Why the envelope was granted. Editable so a mistyped note can be fixed;
   *  optional so the page still works before the backend returns it. */
  note?: string | null;
}

// An initiative's contributor list (/api/graph/projects/:id); their `personId`
// is the graph id the sprint/grant APIs key on. These are the common case for a
// sprint's steward/grantee, so they are surfaced first — but not the only
// eligible set (audit RM-5): a cross-initiative SME who does not contribute here
// must still be pickable, so both selects also read the org roster below.
export interface Contributor { personId: string; name: string; role: string | null }
export interface ProjectDetailLite { contributors?: Contributor[] }

// The full set of people the sprint/grant APIs will accept — /api/roster.
// `isSme` flags the SMEs the operating model spreads across initiatives.
export interface RosterPerson { id: string; name: string; title?: string | null; isSme?: boolean }
export interface RosterResponse { people: RosterPerson[] }

// The initiative options for the "New sprint" form come from the projects
// rollup (every initiative, not only ones that already have a sprint).
export interface InitiativeOption { id: string; name: string }

// One node of /api/graph/projects/:id/work, flattened for the "add item" picker.
// `status` carries the item's board state so terminal items can be kept out of
// the picker (adding a done/cancelled item only muddies the sprint's rollups).
export interface WorkTreeNode { id: string; type: string; title: string; status?: string; children?: WorkTreeNode[] }
