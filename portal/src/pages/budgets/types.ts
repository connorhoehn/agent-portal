// The /api/budgets contract, split out so both the pure derivations
// (budgetsFormat.ts) and the report components can import without pulling
// React in.

export interface BudgetRow {
  orgProjectId: string;
  orgProjectName: string | null;
  /** Null = spending with no allocation — the blind spot this page surfaces. */
  allocatedUsd: number | null;
  period: string | null;
  updatedBy: string | null;
  /** The person behind updatedBy, when the server could resolve one. */
  updatedByName: string | null;
  updatedAt: string | null;
  spentThisPeriodUsd: number;
  runCountThisPeriod: number;
  lastAgentActivityAt: string | null;
  /** Cron-triggered subset of spend — the maintenance floor, not extra spend. */
  maintenanceUsd: number;
  /** Ledger mode only: this period's entries whose cost is unknown. */
  unknownCostCount?: number;
  // ── DE-55 maintenance reserve (absent on an older BFF) ──
  /** The reserve in force; null without an allocation. */
  reserveUsd?: number | null;
  reserveSource?: 'set' | 'auto' | 'off' | null;
  /** Essential bots' scheduled spend this period. */
  floorSpentUsd?: number;
  /** spent − floor spent. */
  discretionarySpentUsd?: number;
  floorHeldUsd?: number;
  discretionaryHeldUsd?: number;
  /** What every human, job and box dispatch is judged against; null without an allocation. */
  discretionaryRemainingUsd?: number | null;
  // ── DE-38 budget periods (absent on an older BFF) ──
  /** 'YYYY-MM' | 'YYYY-Qn' | sprint id; null for rolling and between sprints. */
  periodKey?: string | null;
  /** 'between-sprints': a sprint-period allocation with no sprint open, so it is not in force. */
  periodState?: 'open' | 'between-sprints';
}

export interface BudgetSummary {
  totalAllocatedUsd: number;
  totalSpentThisPeriodUsd: number;
  totalMaintenanceUsd: number;
  byModel: Array<{ model: string; spentUsd: number; runCount: number }>;
  byTrigger: Array<{ trigger: string; spentUsd: number; runCount: number }>;
}

export interface InitiativeOption {
  id: string;
  name: string;
}

export interface GrantRow {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  granteePersonId: string;
  granteeName: string | null;
  sprintName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  sprintStatus: string | null;
  allocatedUsd: number;
  initiativeSpendInWindowUsd: number;
}

// ─── GET /api/spend/report (routes/spend-report.ts) ────────────────────────
// Below the budgets read tier every dollar field is ABSENT, never zero, and
// `budgetAccess` says why — hence the optional dollar fields.

export type SpendGroupBy = 'initiative' | 'actor' | 'model' | 'source' | 'trigger';
export type SpendPeriod = 'month' | '7d' | '30d';

export interface BudgetAccessLock {
  visible: false;
  reason: string;
  requestItemId: string;
}

export interface SpendGroup {
  /** Null = unattributed (no initiative / no person on the entry). */
  key: string | null;
  label: string;
  knownUsd?: number;
  unknownCount: number;
  entries: number;
  burnPerDay7d?: number;
  projectedPeriodEndUsd?: number;
  /** Null when holds cannot be grouped this way (model, trigger) or are not tracked. */
  heldUsd?: number | null;
  allocatedUsd?: number;
  remainingUsd?: number;
}

export interface SpendEnvelope {
  grantId: string;
  granteePersonId: string;
  granteeName: string | null;
  granteeUserId: string | null;
  sprintId: string | null;
  sprintName: string | null;
  sprintStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
  allocatedUsd: number;
  /** The grantee's own dispatched burn; null = unknown (not attributable), never zero. */
  spentUsd: number | null;
  unknownCount: number;
  heldUsd: number | null;
  remainingUsd: number | null;
  attributionAvailable: boolean;
  initiativeSpendInWindowUsd: number;
}

export interface SpendHoldView {
  id: string;
  source: string;
  actorId: string | null;
  actorName: string | null;
  amountUsd: number;
  essential: boolean;
  basis: string;
  createdAt: string;
  expiresAt: string;
}

export interface OpenItemFit {
  id: string;
  key: string | null;
  title: string;
  priority: string;
  storyPoints: number | null;
  model: string | null;
  p25Usd?: number | null;
  p75Usd?: number | null;
  basis: 'forecast' | 'estimate' | null;
  aheadUsd?: number;
  fitsRemaining?: boolean | null;
}

export interface InitiativeSpend {
  id: string;
  name: string | null;
  allocation?: {
    allocatedUsd: number | null;
    period: string | null;
    periodKey?: string | null;
    periodState?: 'open' | 'between-sprints';
    spentUsd: number;
    runCount: number;
    unknownCount: number;
    effectiveHardCapUsd: number | null;
    hardCapSource: string | null;
  };
  reserve?: {
    reserveUsd: number | null;
    reserveSource: string | null;
    allowFloorSpill: boolean;
    floorSpentUsd: number;
    floorHeldUsd: number;
    discretionarySpentUsd: number;
    discretionaryHeldUsd: number;
    discretionaryRemainingUsd: number | null;
    maintenance30dUsd: number;
    maintenance30dRuns: number;
  };
  holds: { tracked: boolean; heldUsd?: number | null; count: number; items: SpendHoldView[] };
  envelopes: SpendEnvelope[];
  people: SpendGroup[];
  forecast: {
    p25Usd?: number;
    p75Usd?: number;
    estimatedItems: number;
    unestimatedSizedItems: number;
    unsizedItems: number;
    models?: Array<{ model: string | null; p25Usd: number; p75Usd: number; items: number }>;
    mixedModels: boolean;
    discretionaryRemainingUsd?: number | null;
    items: OpenItemFit[];
  };
  runs: {
    since: string;
    total: number;
    byStatus: { done: number; failed: number; skipped: number; running: number };
    byTrigger: Array<{ trigger: string; total: number; done: number; failed: number; skipped: number; running: number }>;
    overRunBudget: number;
    skippedForBudget: number;
  };
  budgetAccess?: BudgetAccessLock;
}

export interface SpendReport {
  groupBy: SpendGroupBy;
  period: SpendPeriod;
  since: string;
  asOf: string;
  periodStart: string;
  periodEnd: string;
  daysLeftInPeriod: number;
  ledgerMode: 'off' | 'dual' | 'ledger';
  holdsTracked: boolean;
  initiativeId: string | null;
  totals: {
    knownUsd?: number;
    unknownCount: number;
    entries: number;
    heldUsd?: number | null;
    burnPerDay7d?: number;
    projectedPeriodEndUsd?: number;
  };
  groups: SpendGroup[];
  initiative?: InitiativeSpend;
  budgetAccess?: BudgetAccessLock;
}
