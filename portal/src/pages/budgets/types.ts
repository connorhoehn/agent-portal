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
