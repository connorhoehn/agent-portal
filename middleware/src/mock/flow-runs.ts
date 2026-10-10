// Durable flow runs (docs/agentic-flows-migration.md slice 4a), mock side.
// Rows mirror schema/flow_runs_schema.sql. Registered, so POST
// /api/__mock/reset clears them; timestamps come from the mock clock.

import { defineFixture } from './core/fixture.js';

export type FlowRunStatus = 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed';
/** An `/agent` loop paused at an approval step: no lease, nothing running, resumed only by resumeWaiting(). */
export const WAITING_APPROVAL = 'waiting-approval' satisfies FlowRunStatus;
export const isWaitingApproval = (run: { status: string }): boolean => run.status === WAITING_APPROVAL;
export type FlowStepStatus = 'pending' | 'running' | 'completed' | 'failed';
export interface FlowRunStep {
  id: string; label: string; status: FlowStepStatus;
  /** `/agent` steps only: the existing flow run this step started (the portal draws that run's own card). */
  ref?: { kind: 'summary' | 'deck' | 'diagram' | 'doc'; runId: string };
  /** `/agent` steps only: acceptance criterion while pending, then why a step failed or what a note recorded. */
  detail?: string;
  /** `/agent` `document:create` / `meeting:create` steps: what the step made (no child run to follow). `href` is an in-app route or an upload URL; a huddle carries the lobby name instead. */
  link?: { kind: 'document' | 'room' | 'huddle'; label: string; href?: string; lobbyName?: string };
}

export interface FlowRunRow {
  id: string;
  tenant: string;
  kind: string;
  requestedBy: string;
  /** What the run reads or writes about (a channel, a team, a run id). Authority is re-checked against it on every read. */
  scope: string;
  status: FlowRunStatus;
  progress: FlowRunStep[];
  /** Private source material; cleared when the run finishes. */
  input: Record<string, unknown> | null;
  result: unknown | null;
  /** Kind-specific mutable facts (e.g. postedAt), merged once. */
  meta: Record<string, unknown>;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export const flowRunsFixture = defineFixture<FlowRunRow>({
  key: 'flows.runs',
  scenarios: { default: () => [], empty: () => [] },
});
