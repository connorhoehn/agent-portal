// Run controls, offline — `run_limits`, `run_slots`, `fleet_switches` and the
// budget-threshold memory on `initiative_budgets` (schema/run_controls_schema.sql).
//
// Every fixture starts empty: no limit beyond the global bot-run ceiling, no
// slot held, nothing paused, no threshold announced — so today's demo behaves
// exactly as before until someone sets a limit or flips a switch, and
// `POST /api/__mock/reset` undoes whatever they did.

import { defineFixture } from './core/index.js';

export interface RunLimitRow {
  scopeKind: 'global' | 'tenant' | 'initiative';
  scopeId: string;
  maxConcurrent: number | null;
  maxRunsPerDay: number | null;
  maxUsdPerHour: number | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface RunSlotRow {
  scopeKey: string;
  slotNo: number;
  holder: string;
  expiresAt: string;
  createdAt: string;
}

export interface FleetSwitchRow {
  scope: string;
  paused: boolean;
  reason: string | null;
  setBy: string | null;
  setAt: string;
}

export interface BudgetThresholdRow {
  orgProjectId: string;
  lastThresholdNotified: number | null;
  lastThresholdPeriod: string | null;
}

const unavailable = (table: string) => () => { throw new Error(`${table} unavailable: relation does not exist`); };

export const runLimits = defineFixture<RunLimitRow>({
  key: 'run-limits',
  scenarios: { default: () => [], empty: () => [], error: unavailable('run_limits') },
});

export const runSlots = defineFixture<RunSlotRow>({
  key: 'run-slots',
  scenarios: { default: () => [], empty: () => [], error: unavailable('run_slots') },
});

export const fleetSwitches = defineFixture<FleetSwitchRow>({
  key: 'fleet-switches',
  scenarios: { default: () => [], empty: () => [], error: unavailable('fleet_switches') },
});

export const budgetThresholds = defineFixture<BudgetThresholdRow>({
  key: 'budget-thresholds',
  scenarios: { default: () => [], empty: () => [], error: unavailable('initiative_budgets') },
});

/** One budget threshold crossed for one subject in one period (lib/budget-thresholds.ts). */
export interface BudgetThresholdMarkRow {
  subjectKind: 'initiative' | 'user' | 'grant';
  subjectId: string;
  threshold: number;
  periodKey: string;
  crossedAt: string;
}

export const budgetThresholdMarks = defineFixture<BudgetThresholdMarkRow>({
  key: 'budget-threshold-marks',
  scenarios: { default: () => [], empty: () => [], error: unavailable('budget_threshold_marks') },
});

export const fleetSwitchLog = defineFixture<FleetSwitchRow>({
  key: 'fleet-switch-log',
  scenarios: { default: () => [], empty: () => [], error: unavailable('fleet_switch_log') },
});
