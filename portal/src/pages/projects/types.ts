// Shapes returned by GET /api/graph/projects.

export interface ProjectSummary {
  id: string;
  name: string;
  status: string | null;
  description?: string | null;
  contributorCount: number;
  topContributorNames?: string[];
  lastActivityAt?: string | null;
  createdAt: string | null;
  // Operating-model rollups. All null/[] on pre-migration clusters — render
  // what's present, omit cleanly what isn't.
  ownerId?: string | null;
  ownerName?: string | null;
  smeNames?: string[];
  openStories?: number | null;
  openBugs?: number | null;
  pointsDone?: number | null;
  pointsTotal?: number | null;
  /** Month-to-date, not lifetime — see SPEND_TITLE in projectFormat.ts. */
  agentSpendUsd?: number | null;
  /** Genuinely last, unwindowed — an initiative can have $0.00 this month and
      still have run in June. */
  lastAgentActivityAt?: string | null;
  /** Agents (bot_runs) running on this initiative right now. */
  activeAgentRuns?: number | null;
  /** Highest open work-item priority: critical | high | medium | low. */
  priority?: string | null;
  /** Monthly allocation the MTD spend reads against (initiative_budgets). */
  allocatedUsd?: number | null;
  /** `owner/repo` (Mission-2). Rendered as a GitHub link, no capability gate. */
  repoFullName?: string | null;
  /** Present only below the budgets read tier: the server withheld the dollar
      fields (agentSpendUsd / allocatedUsd are absent) and says why and which
      access catalog item opens them. The page renders a locked cell — never a
      zero — and offers the request (BudgetAccessRequest). */
  budgetAccess?: BudgetAccessLocked;
}

/** The server's stand-in for withheld money (middleware lib/budget-read-tier.ts). */
export interface BudgetAccessLocked { visible: false; reason: string; requestItemId: string }

/**
 * GET /api/session/person (M3): whether the signed-in account is connected to
 * an org-graph person. The Mine view needs it to tell "you are not connected"
 * apart from "you are connected, and nothing lists you". The person's name is
 * a separate read (GET /api/graph/people/:id).
 */
export interface SessionPerson {
  linked: boolean;
  personId: string | null;
}
