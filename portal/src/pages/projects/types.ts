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
  /** `owner/repo` (Mission-2). Rendered as a GitHub link, no capability gate. */
  repoFullName?: string | null;
}
