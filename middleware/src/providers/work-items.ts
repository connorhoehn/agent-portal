// Work-items provider — reads work_items hierarchy from Aurora PostgreSQL.
// Tables: work_items, projects, people (see schema/orgiq_work_items_schema.sql)
//
// Falls back to rich in-memory mock data when config.mock.aurora === true so
// the portal is fully navigable in offline / local dev without Aurora.

import { noteSearchWrite } from '../lib/search-index/writes.js';
import { randomUUID } from 'node:crypto';
import { displayNameForSubject, getUser } from './identity.js';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { restCommentMessage, workThreadChannel } from '../lib/work-thread.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { mockProjectExists, mockProjectName } from './projects.js';
import { clock } from '../mock/core/index.js';
import { workItemComments } from '../mock/work-item-comments.js';
import { workItemCriteria, type WorkItemCriterionRow } from '../mock/work-item-criteria.js';
// Names only, for the activity feed's `LEFT JOIN people` — the same cast
// providers/people.ts serves, so an actor's name here is the name every other
// surface gives that id.
import { mockPeople } from '../mock/people.js';
// The `decisions` table, whole. An initiative's Decisions tab is this table
// filtered by project_id — the SAME rows GET /api/graph/decisions lists — so
// it reads the same fixture rather than a hand-typed copy of half of it.
import { decisionRows } from '../mock/decisions.js';
// The board's rows. `MOCK_EPOCH` is re-exported below rather than redefined —
// providers/activity.ts and the mock seeds must reproject from one anchor.
import {
  workItems,
  nextMockWorkItemId,
  MOCK_EPOCH,
  nextMockWorkItemKey,
} from '../mock/work-items.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// Deliberately flat taxonomy: epics contain stories and bugs, and that's the
// tree. Stories and bugs are the marketplace's dispatchable units; epics roll
// up. (feature/task were collapsed into story — see the migration in
// schema/orgiq_work_items_schema.sql.)
export type WorkItemType   = 'epic' | 'story' | 'bug';
export type WorkItemStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type WorkItemPriority = 'critical' | 'high' | 'medium' | 'low';
export type PrStatus = 'open' | 'draft' | 'merged' | 'closed';

export interface WorkItem {
  id: string;
  /** Immutable public reference for commits/PRs. Null before the key migration. */
  key?: string | null;
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
   * The item's brief (schema/orgiq_work_items_schema.sql). Copy the
   * initiative Overview and the work item's Brief render as data, never as
   * portal literals: `summary` is a Plan-next row's one-line description and
   * the first half of the "What needs attention" body, `blockedReason` its
   * second half, `nextStep`/`nextStepDetail` the Brief's Next-step callout.
   * Null when the item has none — and null for every item on a cluster that
   * has not applied the columns yet (see `briefColumnsAvailable`).
   */
  summary: string | null;
  blockedReason: string | null;
  nextStep: string | null;
  nextStepDetail: string | null;
  /**
   * Sprint membership (`work_items.sprint_id`) and the dollar estimate
   * (`work_items.estimated_cost_usd`) — the two axes the program operating
   * model plans against (docs/program-operating-model.md). Both columns have
   * existed since schema/program_schema.sql and were selected by no query and
   * returned by no route, so every work-item surface showed the complexity
   * estimate and hid the money and the sprint.
   */
  sprintId: string | null;
  estimatedCostUsd: number | null;
  /**
   * Estimate provenance (schema/work_item_estimate_schema.sql). Who stood
   * behind the forecast, when, and — critically — which model it was computed
   * against: a stored Haiku figure must never be shown while Opus is selected,
   * because the two were measured 20x apart on identical points.
   *
   * All null for every item predating that migration, and for any item whose
   * estimate was never authorized. That is attribution starting going forward,
   * the same reasoning `bot_runs.dispatched_by` records.
   */
  estimatedBy: string | null;
  /** `estimatedBy` resolved through app_users; null when the subject has no
   *  account row (deleted, or a machine subject). Render falls back to the id. */
  estimatedByName: string | null;
  estimatedAt: string | null;
  estimateModel: string | null;
  estimateForecast: Record<string, unknown> | null;
  /** Advisory SME sign-off. Never gates dispatch. */
  estimateReviewedBy: string | null;
  estimateReviewedByName: string | null;
  estimateReviewedAt: string | null;
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

export interface SearchWorkItemsOpts {
  label?: string;
  team?: string;
  projectId?: string;
  sprintId?: string;
  status?: string;
  period?: string;
  limit?: number;
}

export interface CreateWorkItemInput {
  projectId: string;
  parentId?: string | null;
  type: WorkItemType;
  title: string;
  description?: string | null;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  assigneeId?: string | null;
  labels?: string[];
  storyPoints?: number | null;
  sprintId?: string | null;
  estimatedCostUsd?: number | null;
}

export interface UpdateWorkItemPatch {
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  title?: string;
  description?: string | null;
  labels?: string[];
  parentId?: string | null;
  storyPoints?: number | null;
  sprintId?: string | null;
  estimatedCostUsd?: number | null;
  assigneeId?: string | null;
  prUrl?: string | null;
  prStatus?: PrStatus | null;
  /** Compare-and-swap: the write only lands if the row still holds this status. */
  expectStatus?: WorkItemStatus;
}

// ─── Status transitions ───────────────────────────────────────────────────────

/**
 * The board's counterpart to `bot-runner.decideDispatch` — pure, so the matrix
 * can be read and tested without a database.
 *
 * The board used to accept every status → every status: `done` → `open` quietly
 * un-completed finished work, and `in_review` → `done` declared an item
 * delivered while its change request was still awaiting a human.
 *
 * The matrix is written to agree with `decideDispatch`, which dispatches only
 * `open` and `in_progress` because `in_review` already has a change awaiting a
 * human and `done`/`cancelled` are finished:
 *
 *   open        → in_progress | cancelled
 *   in_progress → in_review | done | open | cancelled
 *   in_review   → in_progress | done | cancelled
 *   done        → in_progress
 *   cancelled   → open
 *
 * Two shapes are deliberately closed off. Nothing enters `in_review` or `done`
 * without having been `in_progress` first — review is a review *of* something,
 * and an item nobody started is `cancelled`, not `done`. And a completed item
 * reopens to `in_progress` rather than to the backlog, so "this was finished
 * and is being revisited" never renders as "this was never started". (An item
 * reopened for a fresh agent run takes the legal second hop
 * `in_progress → open`, which is also how `bot-runner` hands back a failed run.)
 */
export type StatusTransitionDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; status: number; error: string };

const ALLOWED_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  open:        ['in_progress', 'cancelled'],
  in_progress: ['in_review', 'done', 'open', 'cancelled'],
  in_review:   ['in_progress', 'done', 'cancelled'],
  done:        ['in_progress'],
  cancelled:   ['open'],
};

/** Why a particular move is refused, when the generic answer is unhelpful. */
const TRANSITION_REASONS: Partial<Record<`${WorkItemStatus}->${WorkItemStatus}`, string>> = {
  'open->in_review': 'an item that was never started has nothing to review — move it to in_progress first',
  'open->done': 'an item that was never started is cancelled, not done',
  'in_review->open': 'a review is on a change in flight — send it back to in_progress, not to the backlog',
  'done->open': 'a completed item reopens to in_progress; returning it to the backlog erases that it was ever finished',
  'done->cancelled': 'a completed item cannot be cancelled — reopen it to in_progress first',
  'cancelled->in_progress': 'a cancelled item is revived to open before it can be worked again',
  'cancelled->in_review': 'a cancelled item is revived to open before it can be worked again',
  'cancelled->done': 'a cancelled item is revived to open before it can be worked again',
};

export function decideStatusTransition(
  item: Pick<WorkItem, 'status'>,
  next: WorkItemStatus,
  ctx: { openChangeRequests?: number } = {},
): StatusTransitionDecision {
  const from = item.status;
  if (from === next) return { kind: 'allow' };

  if (!ALLOWED_TRANSITIONS[from].includes(next)) {
    const reason = TRANSITION_REASONS[`${from}->${next}`]
      ?? `a ${from} work item cannot move to ${next}`;
    return { kind: 'refuse', status: 400, error: reason };
  }

  // Governance, not shape: the move is legal but the item is not deliverable
  // yet. 409 because the caller is not wrong — the world is not ready.
  if (next === 'done' && (ctx.openChangeRequests ?? 0) > 0) {
    const n = ctx.openChangeRequests ?? 0;
    return {
      kind: 'refuse',
      status: 409,
      error: `${n} change request${n === 1 ? '' : 's'} on this item ${n === 1 ? 'is' : 'are'} still open — resolve ${n === 1 ? 'it' : 'them'} before marking it done`,
    };
  }

  return { kind: 'allow' };
}

// ─── RDS parameter helpers ────────────────────────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}
function numParam(name: string, value: number): SqlParameter {
  return { name, value: { doubleValue: value } };
}
function boolParam(name: string, value: boolean): SqlParameter {
  return { name, value: { booleanValue: value } };
}

/** Every read projects the same column list, including the two that were dead. */
const ITEM_COLUMNS = `
      wi.id, to_jsonb(wi)->>'work_item_key' AS work_item_key, wi.project_id, p.name AS project_name,
      wi.parent_id, wi.type, wi.title, wi.description,
      wi.status, wi.priority, wi.labels,
      wi.story_points, wi.sprint_id, wi.estimated_cost_usd,
      wi.estimated_by, wi.estimated_at, wi.estimate_model, wi.estimate_forecast,
      wi.estimate_reviewed_by, wi.estimate_reviewed_at,

      wi.pr_url, wi.pr_status,
      wi.created_at, wi.updated_at, wi.completed_at,
      a.id AS assignee_id, a.name AS assignee_name, a.team AS assignee_dept,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id) AS child_count,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count`;

const ITEM_FROM = `
    FROM work_items wi
    JOIN projects p ON p.id = wi.project_id
    LEFT JOIN people a ON a.id = wi.assignee_id`;

// ─── Estimate-attribution names (app_users) ───────────────────────────────────
//
// `estimated_by` / `estimate_reviewed_by` hold a SESSION SUBJECT, so resolving
// them to a person means joining app_users (identity_schema.sql), not people:
// an account with no linked org-graph person still authorized the spend.
//
// The join is OPTIONAL, and that is the load-bearing part. safeExec swallows
// `relation ... does not exist` so a pre-schema cluster reads empty rather than
// 500ing — which means an unconditional `JOIN app_users` on a cluster that has
// work_items but not identity_schema would blank the ENTIRE work board and
// report it as "no work". A missing name must cost the name, never the rows.
//
// Probed once per process against information_schema, mirroring
// providers/bots.ts::attributionAvailable — the same problem (middleware ships
// ahead of schema) already solved the same way there.

let _appUsers: boolean | null = null;

async function appUsersAvailable(): Promise<boolean> {
  // Mock mode stands in for a fully-migrated cluster; the mock write paths
  // resolve names themselves via displayNameForSubject.
  if (config.mock.aurora) return true;
  if (_appUsers !== null) return _appUsers;
  try {
    const rows = await exec(
      `SELECT 1 AS ok FROM information_schema.tables
        WHERE table_name = 'app_users' LIMIT 1`,
    );
    _appUsers = rows.length > 0;
  } catch {
    _appUsers = false;
  }
  return _appUsers;
}

/** Test seam: forget the probe so the next call re-asks. */
export function resetAppUsersProbe(): void { _appUsers = null; }

// ─── Brief columns (summary / blocked_reason / next_step / next_step_detail) ──
//
// Same reasoning as the app_users probe above: the middleware ships ahead of
// the schema, and an unconditional `wi.summary` on a cluster that has not run
// the ALTER in orgiq_work_items_schema.sql fails with `column ... does not
// exist` — which safeExec does NOT swallow (it only swallows a missing
// RELATION), so the whole Work tab would 500. A missing column must cost the
// field, never the board. All four or none: they ship in one ALTER.

const BRIEF_COLUMN_NAMES = ['summary', 'blocked_reason', 'next_step', 'next_step_detail'] as const;
let _briefColumns: boolean | null = null;

async function briefColumnsAvailable(): Promise<boolean> {
  if (config.mock.aurora) return true;
  if (_briefColumns !== null) return _briefColumns;
  try {
    const rows = await exec(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'work_items'
          AND column_name IN (${BRIEF_COLUMN_NAMES.map((c) => `'${c}'`).join(', ')})`,
    );
    _briefColumns = rows.length === BRIEF_COLUMN_NAMES.length;
  } catch {
    _briefColumns = false;
  }
  return _briefColumns;
}

/** Test seam: forget the brief-columns probe so the next call re-asks. */
export function resetBriefColumnsProbe(): void { _briefColumns = null; }

/** The brief columns, or nothing when the cluster lacks them (rowToWorkItem reads null). */
function briefColumns(withBrief: boolean): string {
  return withBrief
    ? `, ${BRIEF_COLUMN_NAMES.map((c) => `wi.${c}`).join(', ')}`
    : '';
}

/** The name columns, or nothing when identity_schema is not on this cluster. */
function nameColumns(withNames: boolean): string {
  return withNames
    ? `, eb.display_name AS estimated_by_name, rb.display_name AS estimate_reviewed_by_name`
    : '';
}

/** The name joins, or nothing. Paired with nameColumns — never use one alone. */
function nameJoins(withNames: boolean): string {
  return withNames
    ? `
    LEFT JOIN app_users eb ON eb.id = wi.estimated_by
    LEFT JOIN app_users rb ON rb.id = wi.estimate_reviewed_by`
    : '';
}

// ─── Aurora query wrapper — degrades gracefully if work_items table is missing ─

async function safeExec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err: unknown) {
    // Swallow ONLY the missing-table error (pre-schema cluster → empty reads).
    // The old broad match (any 'does not exist', any mention of 'work_items')
    // also ate constraint violations, so a failed INSERT read as an empty
    // result and dbCreateWorkItem fabricated a 201 for a row that never landed.
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(msg)) {
      return [];
    }
    throw err;
  }
}

// ─── Aurora queries ───────────────────────────────────────────────────────────

async function dbSearchWorkItems(opts: SearchWorkItemsOpts): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: SqlParameter[] = [intParam('lim', limit)];
  const clauses: string[] = [];

  if (opts.label) {
    clauses.push(`:label = ANY(wi.labels)`);
    params.push(strParam('label', opts.label));
  }
  if (opts.team) {
    // The route documented `team=` and the mock path filtered on it; the Aurora
    // path never referenced it, so `?team=NoSuchTeam` returned the whole board.
    // POSITION (not LIKE) so a team name containing % or _ can't turn into a
    // wildcard, and case-insensitive substring to match the mock path exactly.
    clauses.push(`POSITION(LOWER(:team) IN LOWER(COALESCE(a.team, ''))) > 0`);
    params.push(strParam('team', opts.team));
  }
  if (opts.status) {
    clauses.push(`wi.status = :status`);
    params.push(strParam('status', opts.status));
  }
  if (opts.sprintId) {
    clauses.push(`wi.sprint_id = :sprint_id`);
    params.push(strParam('sprint_id', opts.sprintId));
  }
  if (opts.projectId) {
    clauses.push(`wi.project_id = :project_id`);
    params.push(strParam('project_id', opts.projectId));
  }
  if (opts.period === 'today') {
    clauses.push(`wi.updated_at >= NOW() - INTERVAL '1 day'`);
  } else if (opts.period === 'week') {
    clauses.push(`wi.updated_at >= NOW() - INTERVAL '7 days'`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const withNames = await appUsersAvailable();
  const withBrief = await briefColumnsAvailable();
  const sql = `
    SELECT ${ITEM_COLUMNS}${nameColumns(withNames)}${briefColumns(withBrief)}
    ${ITEM_FROM}${nameJoins(withNames)}
    ${where}
    ORDER BY wi.updated_at DESC
    LIMIT :lim
  `;
  const rows = await safeExec(sql, params);
  return rows.map(rowToWorkItem);
}

// A circuit-breaker LIMIT, not an everyday cap — a single initiative's work
// items are normally a few dozen to a few hundred. Ordering epics first (the
// existing `wi.type DESC`) means a cap that does engage cuts stories/bugs
// before the epics they hang off, rather than orphaning a tree mid-hierarchy.
const PROJECT_WORK_ITEMS_LIMIT = 500;

async function dbGetProjectWorkItems(projectId: string, limit: number = PROJECT_WORK_ITEMS_LIMIT): Promise<WorkItem[]> {
  const withNames = await appUsersAvailable();
  const withBrief = await briefColumnsAvailable();
  const sql = `
    SELECT ${ITEM_COLUMNS}${nameColumns(withNames)}${briefColumns(withBrief)}
    ${ITEM_FROM}${nameJoins(withNames)}
    WHERE wi.project_id = :pid
    ORDER BY wi.type DESC, wi.created_at ASC
    LIMIT :lim
  `;
  const rows = await safeExec(sql, [strParam('pid', projectId), intParam('lim', Math.max(1, Math.min(limit, PROJECT_WORK_ITEMS_LIMIT)))]);
  return rows.map(rowToWorkItem);
}

async function dbGetPersonWorkItems(personId: string, opts: { status?: string; limit?: number }): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const params: SqlParameter[] = [strParam('pid', personId), intParam('lim', limit)];
  const extra = opts.status ? `AND wi.status = :status` : '';
  if (opts.status) params.push(strParam('status', opts.status));

  const withNames = await appUsersAvailable();
  const withBrief = await briefColumnsAvailable();
  const sql = `
    SELECT ${ITEM_COLUMNS}${nameColumns(withNames)}${briefColumns(withBrief)}
    ${ITEM_FROM}${nameJoins(withNames)}
    WHERE wi.assignee_id = :pid ${extra}
    ORDER BY wi.updated_at DESC
    LIMIT :lim
  `;
  const rows = await safeExec(sql, params);
  return rows.map(rowToWorkItem);
}

// Same circuit-breaker reasoning as PROJECT_WORK_ITEMS_LIMIT: one project's
// decision queue is normally small, and escalated/open sort first so a cap
// that does engage drops the least urgent rows.
const PROJECT_DECISIONS_LIMIT = 500;

async function dbGetProjectDecisions(projectId: string, limit: number = PROJECT_DECISIONS_LIMIT): Promise<ProjectDecision[]> {
  const sql = `
    SELECT
      d.id, d.topic, d.summary, d.status,
      d.required_role, d.escalated_at,
      d.work_item_id, wi.title AS work_item_title
    FROM decisions d
    LEFT JOIN work_items wi ON wi.id = d.work_item_id
    WHERE d.project_id = :pid
    ORDER BY
      CASE d.status WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
      COALESCE(d.escalated_at, d.created_at) DESC
    LIMIT :lim
  `;
  const rows = await safeExec(sql, [strParam('pid', projectId), intParam('lim', Math.max(1, Math.min(limit, PROJECT_DECISIONS_LIMIT)))]);
  return rows.map(rowToProjectDecision);
}

function rowToProjectDecision(r: Record<string, unknown>): ProjectDecision {
  return {
    id: String(r['id'] ?? ''),
    topic: String(r['topic'] ?? ''),
    summary: r['summary'] != null ? String(r['summary']) : null,
    status: String(r['status'] ?? 'open'),
    requiredRole: r['required_role'] != null ? String(r['required_role']) : null,
    escalatedAt: r['escalated_at'] != null ? String(r['escalated_at']) : null,
    workItemId: r['work_item_id'] != null ? String(r['work_item_id']) : null,
    workItemTitle: r['work_item_title'] != null ? String(r['work_item_title']) : null,
  };
}

/** One decision in the Decisions-tab shape, or null when there is no such row. */
async function dbGetProjectDecision(decisionId: string): Promise<ProjectDecision | null> {
  const rows = await safeExec(
    `SELECT d.id, d.topic, d.summary, d.status, d.required_role, d.escalated_at,
            d.work_item_id, wi.title AS work_item_title
       FROM decisions d
       LEFT JOIN work_items wi ON wi.id = d.work_item_id
      WHERE d.id = :did`,
    [strParam('did', decisionId)],
  );
  return rows[0] ? rowToProjectDecision(rows[0]) : null;
}

/** The three columns the link decision reads. */
async function dbDecisionLinkRow(decisionId: string): Promise<DecisionLinkRow | null> {
  const rows = await safeExec(
    `SELECT id, project_id, work_item_id FROM decisions WHERE id = :did`,
    [strParam('did', decisionId)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r['id'] ?? ''),
    projectId: r['project_id'] != null ? String(r['project_id']) : null,
    workItemId: r['work_item_id'] != null ? String(r['work_item_id']) : null,
  };
}

/** `ARRAY['a','b']` with single quotes doubled; `ARRAY[]::TEXT[]` when empty. */
function labelsLiteral(labels: string[]): string {
  return labels.length > 0
    ? `ARRAY[${labels.map(l => `'${l.replace(/'/g, "''")}'`).join(',')}]`
    : 'ARRAY[]::TEXT[]';
}

async function dbCreateWorkItem(data: CreateWorkItemInput): Promise<WorkItem> {
  const parentClause = data.parentId ? `:parent_id` : 'NULL';
  const assigneeClause = data.assigneeId ? `:assignee_id` : 'NULL';
  const spClause = data.storyPoints != null ? `:story_points` : 'NULL';
  const sprintClause = data.sprintId ? `:sprint_id` : 'NULL';
  const costClause = data.estimatedCostUsd != null ? `:cost::numeric` : 'NULL';

  const params: SqlParameter[] = [
    strParam('project_id', data.projectId),
    strParam('type', data.type),
    strParam('title', data.title),
    strParam('status', data.status ?? 'open'),
    strParam('priority', data.priority ?? 'medium'),
  ];
  if (data.parentId) params.push(strParam('parent_id', data.parentId));
  if (data.assigneeId) params.push(strParam('assignee_id', data.assigneeId));
  if (data.storyPoints != null) params.push(intParam('story_points', data.storyPoints));
  if (data.sprintId) params.push(strParam('sprint_id', data.sprintId));
  if (data.estimatedCostUsd != null) params.push(numParam('cost', data.estimatedCostUsd));
  if (data.description) params.push(strParam('description', data.description));

  const descClause = data.description ? `:description` : 'NULL';

  const sql = `
    INSERT INTO work_items
      (project_id, parent_id, type, title, description, status, priority, assignee_id,
       labels, story_points, sprint_id, estimated_cost_usd)
    VALUES
      (:project_id, ${parentClause}, :type, :title, ${descClause}, :status, :priority, ${assigneeClause},
       ${labelsLiteral(data.labels ?? [])}, ${spClause}, ${sprintClause}, ${costClause})
    RETURNING id
  `;
  const rows = await safeExec(sql, params);
  // If safeExec swallowed a "table not found" error it returns []. Synthesise a
  // transient item so the UI optimistic update works until the schema is applied.
  if (rows.length === 0) {
    const now = new Date().toISOString();
    return {
      id: `wi-ephemeral-${Date.now()}`,
      projectId: data.projectId, projectName: '',
      parentId: data.parentId ?? null, type: data.type,
      title: data.title, description: data.description ?? null,
      status: data.status ?? 'open', priority: data.priority ?? 'medium',
      assigneeId: data.assigneeId ?? null, assigneeName: null, assigneeDept: null,
      labels: data.labels ?? [], storyPoints: data.storyPoints ?? null,
      // A new item has no brief until someone writes one.
      summary: null, blockedReason: null, nextStep: null, nextStepDetail: null,
      sprintId: data.sprintId ?? null, estimatedCostUsd: data.estimatedCostUsd ?? null,
      // A just-created item has no authorized estimate. Nobody has dispatched
      // it, so nobody has stood behind a forecast for it.
      estimatedBy: null, estimatedByName: null, estimatedAt: null, estimateModel: null, estimateForecast: null,
      estimateReviewedByName: null,
      estimateReviewedBy: null, estimateReviewedAt: null,
      prUrl: null, prStatus: null,
      createdAt: now, updatedAt: now, completedAt: null, childCount: 0, childDoneCount: 0,
    };
  }
  // Read the row back through the one projection every other read uses, so the
  // create response carries the real projectName / assigneeName / labels rather
  // than the '' / null / [] placeholders the hand-built RETURNING mapper faked.
  const created = await getWorkItem(String(rows[0]!['id'] ?? ''));
  if (created) return created;
  throw new Error('work item was inserted but could not be read back');
}

async function dbUpdateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<WorkItem | null> {
  const sets: string[] = ['updated_at = NOW()'];
  const params: SqlParameter[] = [];

  if (patch.status !== undefined) {
    sets.push('status = :status');
    params.push(strParam('status', patch.status));
    // The patch path never wrote completed_at, so items marked done via PATCH
    // carried NULL completion timestamps forever. COALESCE keeps the original
    // completion time if the item is re-done after reopening.
    if (patch.status === 'done') sets.push('completed_at = COALESCE(completed_at, NOW())');
  }
  if (patch.priority !== undefined) { sets.push('priority = :priority'); params.push(strParam('priority', patch.priority)); }
  if (patch.title !== undefined) { sets.push('title = :title'); params.push(strParam('title', patch.title)); }
  if (patch.description !== undefined) {
    sets.push(patch.description ? 'description = :description' : 'description = NULL');
    if (patch.description) params.push(strParam('description', patch.description));
  }
  if (patch.labels !== undefined) sets.push(`labels = ${labelsLiteral(patch.labels)}`);
  if (patch.parentId !== undefined) {
    sets.push(patch.parentId ? 'parent_id = :parent_id' : 'parent_id = NULL');
    if (patch.parentId) params.push(strParam('parent_id', patch.parentId));
  }
  if (patch.storyPoints !== undefined) {
    sets.push(patch.storyPoints != null ? 'story_points = :story_points' : 'story_points = NULL');
    if (patch.storyPoints != null) params.push(intParam('story_points', patch.storyPoints));
  }
  if (patch.sprintId !== undefined) {
    sets.push(patch.sprintId ? 'sprint_id = :sprint_id' : 'sprint_id = NULL');
    if (patch.sprintId) params.push(strParam('sprint_id', patch.sprintId));
  }
  if (patch.estimatedCostUsd !== undefined) {
    sets.push(patch.estimatedCostUsd != null ? 'estimated_cost_usd = :cost::numeric' : 'estimated_cost_usd = NULL');
    if (patch.estimatedCostUsd != null) params.push(numParam('cost', patch.estimatedCostUsd));
  }
  if (patch.assigneeId !== undefined) {
    sets.push(patch.assigneeId ? 'assignee_id = :assignee_id' : 'assignee_id = NULL');
    if (patch.assigneeId) params.push(strParam('assignee_id', patch.assigneeId));
  }
  if (patch.prUrl !== undefined) {
    sets.push(patch.prUrl ? 'pr_url = :pr_url' : 'pr_url = NULL');
    if (patch.prUrl) params.push(strParam('pr_url', patch.prUrl));
  }
  if (patch.prStatus !== undefined) {
    sets.push(patch.prStatus ? 'pr_status = :pr_status' : 'pr_status = NULL');
    if (patch.prStatus) params.push(strParam('pr_status', patch.prStatus));
  }

  // Compare-and-swap when the caller is moving the status: the board reads the
  // item, decides the transition is legal, then writes — and without the guard
  // a dispatch claiming the item in between would be overwritten by a decision
  // made against a status it no longer holds.
  let guard = '';
  if (patch.expectStatus !== undefined) {
    guard = ' AND status = :expect_status';
    params.push(strParam('expect_status', patch.expectStatus));
  }

  params.push(strParam('id', id));
  const sql = `UPDATE work_items SET ${sets.join(', ')} WHERE id = :id${guard} RETURNING id`;
  const rows = await safeExec(sql, params);
  if (rows.length === 0) return null;
  return getWorkItem(id);
}

/**
 * Would parenting `id` under `newParentId` close a loop?
 *
 * A cycle is silent damage: buildWorkItemTree only ever promotes parentless
 * nodes to roots, so a looped subtree is reachable from nothing and simply
 * vanishes from the project tree with no error anywhere.
 */
async function dbWouldCreateParentCycle(id: string, newParentId: string): Promise<boolean> {
  const rows = await safeExec(
    `WITH RECURSIVE ancestry(id, parent_id) AS (
       SELECT id, parent_id FROM work_items WHERE id = :new_parent
       UNION ALL
       SELECT w.id, w.parent_id FROM work_items w JOIN ancestry a ON w.id = a.parent_id
     )
     SELECT 1 FROM ancestry WHERE id = :id LIMIT 1`,
    [strParam('new_parent', newParentId), strParam('id', id)],
  );
  return rows.length > 0;
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

/**
 * TIMESTAMPTZ comes back from the RDS Data API as a NAIVE string, and
 * `new Date()` reads that shape as LOCAL time — the same trap that once made a
 * devbox look four hours old in the future (lib/devbox-fleet-rows.ts::utcIso).
 * Estimates are compared against "how long ago", so the same care applies.
 */
function utcIso(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const isoish = text.includes('T') ? text : text.replace(' ', 'T');
  const d = new Date(hasZone ? isoish : `${isoish}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : text;
}

function parseForecast(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function rowToWorkItem(r: Record<string, unknown>): WorkItem {
  // readField now converts arrayValue → string[]; guard for both array and legacy string forms
  let labels: string[] = [];
  if (Array.isArray(r['labels'])) {
    labels = (r['labels'] as unknown[]).map(String);
  } else if (typeof r['labels'] === 'string' && r['labels'].startsWith('{')) {
    labels = r['labels'].slice(1, -1).split(',').filter(Boolean);
  }
  return {
    id: String(r['id'] ?? ''),
    key: r['work_item_key'] != null ? String(r['work_item_key']) : null,
    projectId: String(r['project_id'] ?? ''),
    projectName: String(r['project_name'] ?? ''),
    parentId: r['parent_id'] != null ? String(r['parent_id']) : null,
    type: (r['type'] as WorkItemType) ?? 'story',
    title: String(r['title'] ?? ''),
    description: r['description'] != null ? String(r['description']) : null,
    status: (r['status'] as WorkItemStatus) ?? 'open',
    priority: (r['priority'] as WorkItemPriority) ?? 'medium',
    assigneeId: r['assignee_id'] != null ? String(r['assignee_id']) : null,
    assigneeName: r['assignee_name'] != null ? String(r['assignee_name']) : null,
    assigneeDept: r['assignee_dept'] != null ? String(r['assignee_dept']) : null,
    labels,
    storyPoints: r['story_points'] != null ? Number(r['story_points']) : null,
    summary: r['summary'] != null ? String(r['summary']) : null,
    blockedReason: r['blocked_reason'] != null ? String(r['blocked_reason']) : null,
    nextStep: r['next_step'] != null ? String(r['next_step']) : null,
    nextStepDetail: r['next_step_detail'] != null ? String(r['next_step_detail']) : null,
    sprintId: r['sprint_id'] != null ? String(r['sprint_id']) : null,
    // NUMERIC arrives from the Data API as a string; Number() is the same
    // treatment story_points already gets.
    estimatedCostUsd: r['estimated_cost_usd'] != null ? Number(r['estimated_cost_usd']) : null,
    estimatedBy: r['estimated_by'] != null ? String(r['estimated_by']) : null,
    estimatedByName: r['estimated_by_name'] != null ? String(r['estimated_by_name']) : null,
    estimatedAt: r['estimated_at'] != null ? utcIso(r['estimated_at']) : null,
    estimateModel: r['estimate_model'] != null ? String(r['estimate_model']) : null,
    // JSONB arrives from the Data API as a string; a malformed one must not
    // take the whole row down, so a parse failure reads as "no stored forecast"
    // rather than throwing — the caller then re-estimates, which is safe.
    estimateForecast: parseForecast(r['estimate_forecast']),
    estimateReviewedBy: r['estimate_reviewed_by'] != null ? String(r['estimate_reviewed_by']) : null,
    estimateReviewedByName: r['estimate_reviewed_by_name'] != null ? String(r['estimate_reviewed_by_name']) : null,
    estimateReviewedAt: r['estimate_reviewed_at'] != null ? utcIso(r['estimate_reviewed_at']) : null,
    prUrl: r['pr_url'] != null ? String(r['pr_url']) : null,
    prStatus: r['pr_status'] != null ? (r['pr_status'] as PrStatus) : null,
    createdAt: String(r['created_at'] ?? ''),
    updatedAt: String(r['updated_at'] ?? ''),
    completedAt: r['completed_at'] != null ? String(r['completed_at']) : null,
    childCount: Number(r['child_count'] ?? 0),
    childDoneCount: Number(r['child_done_count'] ?? 0),
  };
}

// ─── Tree builder (shared between real + mock) ────────────────────────────────

export function buildWorkItemTree(items: WorkItem[]): WorkItemTree[] {
  const map = new Map<string, WorkItemTree>();
  for (const item of items) {
    map.set(item.id, { ...item, children: [] });
  }
  const roots: WorkItemTree[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort epics first (they're roots), then stories before bugs, by createdAt inside
  const TYPE_ORDER = { epic: 0, story: 1, bug: 2 };
  function sortChildren(nodes: WorkItemTree[]) {
    nodes.sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || a.createdAt.localeCompare(b.createdAt));
    for (const n of nodes) sortChildren(n.children);
  }
  sortChildren(roots);
  return roots;
}

// ─── Mock data ────────────────────────────────────────────────────────────────
//
// The rows themselves live in mock/work-items.ts, behind a registered fixture,
// so `POST /api/__mock/reset` undoes a board edit. What stays here is the
// reprojection every reader of a seeded stamp needs.

/**
 * The fixed "today" every seeded `D(n)` offset is written against.
 * Re-exported from the fixture so providers/activity.ts keeps one import site.
 */
export { MOCK_EPOCH };

/**
 * Replay a seeded timestamp's "n before the reference point" offset from real
 * now, so a D(14) completion still reads as fourteen days ago however long
 * ago MOCK_EPOCH was.
 *
 * The single definition of that reprojection: providers/activity.ts had its
 * own day-granularity copy for the initiative activity GRAPH, and the activity
 * FEED needs the same rule at full precision — two copies is how one surface
 * comes to place an event on a day the other does not.
 *
 * Only the SEED is offset-encoded. A stamp written by this process (a board
 * PATCH, a dispatch claiming or settling an item) is a real wall-clock instant
 * and is already on the calendar every reader uses; reprojecting it would
 * invert the offset — now is later than the frozen epoch, so the difference
 * goes negative — and throw the event months into the FUTURE, i.e. above
 * everything, forever. Hence the guard, not a bare subtraction.
 */
export function mockReprojectedIso(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms > MOCK_EPOCH.getTime()) return iso;
  return new Date(clock.now().getTime() - (MOCK_EPOCH.getTime() - ms)).toISOString();
}

/**
 * The mock board — the fixture's live rows.
 *
 * Still a function, not a captured array: `rows()` resolves the scenario the
 * control plane currently has live, so a read after
 * `POST /api/__mock/scenario {"scenario":"empty","fixture":"work-items"}` sees
 * the empty world instead of a photograph of the seeded one.
 */
function mockWorkItems(): WorkItem[] {
  return workItems.rows();
}

/**
 * Which initiative a mock work item belongs to — the sync sibling of
 * `getWorkItem(id)?.projectId`, over the same `mockWorkItems()` array.
 *
 * Exists for arm 1 of `spendPredicateSql` (a bot_run attributed through its
 * work item), which providers/bots.ts `mockRunsAttributedTo` has to resolve
 * from inside a getter — `GrantRow.initiativeSpendInWindowUsd` is derived at
 * every read, and a getter cannot await. Mock-mode only; on a real cluster
 * that subquery is Postgres's job.
 */
export function mockWorkItemProjectId(id: string | null | undefined): string | null {
  if (!id) return null;
  return mockWorkItems().find((i) => i.id === id)?.projectId ?? null;
}

const OPEN_STATUSES = new Set<WorkItemStatus>(['open', 'in_progress', 'in_review']);

/**
 * The initiative-level work rollup (open stories, open bugs, points done,
 * points total), computed from THIS module's own `mockWorkItems()` — the same
 * array `getProjectWorkItems`/`searchWorkItems` return to the initiative
 * detail Work tab. Mirrors the real Aurora rollup SQL in providers/projects.ts
 * exactly (type + status filters), so a mock initiative can no longer restate
 * these numbers independently of its own items: providers/projects.ts's
 * `listProjects()` calls this instead of a hand-typed number on
 * `MOCK_INITIATIVES`, closing the gap where the Initiatives list rollup and
 * the initiative-detail Work tab disagreed (org-leader.md #2 / program-owner
 * #3 — "34/72 pts · 47%" on the list vs. "0/10 pts" on the detail for
 * Observability Platform, because the list number had no relationship to the
 * wi-obs-* items below).
 */
export function mockWorkItemRollup(projectId: string): {
  openStories: number;
  openBugs: number;
  pointsDone: number;
  pointsTotal: number;
  /**
   * Highest priority among this initiative's still-open items, or null when it
   * has none — the same `MAX(priority)` over open rows the Aurora rollup does.
   * Restated by hand on MOCK_INITIATIVES until the board grew the seed's real
   * items, at which point two initiatives badged "high" over a board carrying
   * an open `critical` bug.
   */
  highestOpenPriority: WorkItemPriority | null;
} {
  const items = mockWorkItems().filter((i) => i.projectId === projectId);
  const openStories = items.filter((i) => i.type === 'story' && OPEN_STATUSES.has(i.status)).length;
  const openBugs = items.filter((i) => i.type === 'bug' && OPEN_STATUSES.has(i.status)).length;
  const sized = items.filter((i) => i.type === 'story' || i.type === 'bug');
  const pointsTotal = sized.reduce((n, i) => n + (i.storyPoints ?? 0), 0);
  const pointsDone = sized
    .filter((i) => i.status === 'done')
    .reduce((n, i) => n + (i.storyPoints ?? 0), 0);
  const RANK: WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];
  const highestOpenPriority = RANK.find(
    (p) => items.some((i) => OPEN_STATUSES.has(i.status) && i.priority === p),
  ) ?? null;
  return { openStories, openBugs, pointsDone, pointsTotal, highestOpenPriority };
}

// An initiative's decisions, derived from the `decisions` fixture rather than
// typed out again.
//
// This used to be a hand-written `MOCK_DECISIONS` of seed_program.sql's four
// rows plus a `PROJECT_DECISIONS` index. Two costs: (1) it was a second,
// disjoint decision list — mock/decisions.ts carried seed.sql's rows and this
// carried the program's, so `GET /api/graph/decisions` and this tab could
// never show each other's, out of one table; (2) its `workItemTitle`s were
// typed by hand, so `d-eval-judge-model` claimed the title of an item the mock
// board does not carry. Deriving mirrors `dbGetProjectDecisions` instead: the
// same filter, the same LEFT JOIN on work_items (a title only when the board
// really has that item), and the same ORDER BY.
function mockProjectDecisions(projectId: string): ProjectDecision[] {
  const titleById = new Map(mockWorkItems().map((i) => [i.id, i.title]));
  const rank = (status: string): number =>
    (status === 'escalated' ? 0 : status === 'open' ? 1 : 2);
  return decisionRows
    .rows()
    .filter((d) => d.projectId === projectId)
    .map((d) => ({
      id: d.id,
      topic: d.topic,
      summary: d.summary,
      status: d.status,
      requiredRole: d.requiredRole,
      escalatedAt: d.escalatedAt,
      workItemId: d.workItemId,
      workItemTitle: d.workItemId != null ? titleById.get(d.workItemId) ?? null : null,
    }))
    // ORDER BY CASE status WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
    //          COALESCE(escalated_at, created_at) DESC
    .sort((a, b) => rank(a.status) - rank(b.status)
      || (b.escalatedAt ?? '').localeCompare(a.escalatedAt ?? ''));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function searchWorkItems(opts: SearchWorkItemsOpts): Promise<WorkItem[]> {
  if (!config.mock.aurora) {
    return dbSearchWorkItems(opts);
  }
  // Mock path
  let items = mockWorkItems().slice();
  if (opts.label) {
    const lc = opts.label.toLowerCase();
    items = items.filter((i) => i.labels.some((l) => l.toLowerCase().includes(lc)));
  }
  if (opts.team) {
    const lc = opts.team.toLowerCase();
    items = items.filter((i) => (i.assigneeDept ?? '').toLowerCase().includes(lc));
  }
  if (opts.projectId) {
    items = items.filter((i) => i.projectId === opts.projectId);
  }
  if (opts.status) {
    items = items.filter((i) => i.status === opts.status);
  }
  if (opts.sprintId) {
    items = items.filter((i) => i.sprintId === opts.sprintId);
  }
  // `clock.now()`, not `Date.now()`: the rows a period filter is measured
  // against are the fixture's, and a frozen-clock test that stamps an item
  // "an hour ago" must see that item under `period=today`.
  if (opts.period === 'today') {
    const cutoff = clock.now().getTime() - 24 * 60 * 60 * 1000;
    items = items.filter((i) => Date.parse(i.updatedAt) >= cutoff);
  } else if (opts.period === 'week') {
    const cutoff = clock.now().getTime() - 7 * 24 * 60 * 60 * 1000;
    items = items.filter((i) => Date.parse(i.updatedAt) >= cutoff);
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.slice(0, Math.min(opts.limit ?? 50, 200));
}

export async function getProjectWorkItems(projectId: string, limit: number = PROJECT_WORK_ITEMS_LIMIT): Promise<WorkItem[]> {
  if (!config.mock.aurora) {
    return dbGetProjectWorkItems(projectId, limit);
  }
  return mockWorkItems().filter((i) => i.projectId === projectId).slice(0, limit);
}

export async function getProjectWorkTree(projectId: string, limit: number = PROJECT_WORK_ITEMS_LIMIT): Promise<WorkItemTree[]> {
  const items = await getProjectWorkItems(projectId, limit);
  return buildWorkItemTree(items);
}

export async function getPersonWorkItems(personId: string, opts: { status?: string; limit?: number } = {}): Promise<WorkItem[]> {
  if (!config.mock.aurora) {
    return dbGetPersonWorkItems(personId, opts);
  }
  let items = mockWorkItems().filter((i) => i.assigneeId === personId);
  if (opts.status) items = items.filter((i) => i.status === opts.status);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.slice(0, opts.limit ?? 30);
}

export async function getProjectDecisions(projectId: string, limit: number = PROJECT_DECISIONS_LIMIT): Promise<ProjectDecision[]> {
  if (!config.mock.aurora) {
    return dbGetProjectDecisions(projectId, limit);
  }
  return mockProjectDecisions(projectId).slice(0, limit);
}

// ─── Decision ↔ work-item links ───────────────────────────────────────────────
//
// `decisions.work_item_id` names the work a decision blocks or shapes — the
// Brief's "Dependencies and decisions" row and the Decisions tab's item column
// both read it. Until this, only schema/seed_program.sql could write it, so a
// decision raised mid-sprint could never be attached to the item it held up.

/** The part of a `decisions` row the link rule reads. */
export interface DecisionLinkRow {
  id: string;
  projectId: string | null;
  workItemId: string | null;
}

export type DecisionLinkDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; status: 409; error: string };

/**
 * May `decision` be linked to `item`? Pure, so the rule reads without a
 * database — the same shape as `decideStatusTransition`.
 *
 * A decision links only to work on ITS OWN initiative: the Decisions tab lists
 * a decision by `project_id`, so a link across initiatives would put the item
 * on one page and the decision on another, and neither would show the other.
 * An org-wide decision (`project_id` NULL) has no initiative to match. And a
 * decision already linked to a DIFFERENT item is a 409, not a silent re-point:
 * `work_item_id` is one column, so re-pointing would quietly unlink it from
 * the work that named it first. Linking to the item it already names is
 * idempotent.
 */
export function decideDecisionLink(
  item: Pick<WorkItem, 'id' | 'projectId'>,
  decision: DecisionLinkRow,
): DecisionLinkDecision {
  if (decision.projectId === null) {
    return {
      kind: 'refuse', status: 409,
      error: `decision ${decision.id} is org-wide — it was not raised against an initiative, so it cannot be linked to one initiative's work`,
    };
  }
  if (decision.projectId !== item.projectId) {
    return {
      kind: 'refuse', status: 409,
      error: `decision ${decision.id} belongs to ${decision.projectId}, but ${item.id} is work on ${item.projectId} — a decision links only to its own initiative's work`,
    };
  }
  if (decision.workItemId !== null && decision.workItemId !== item.id) {
    return {
      kind: 'refuse', status: 409,
      error: `decision ${decision.id} is already linked to ${decision.workItemId} — unlink it there first`,
    };
  }
  return { kind: 'allow' };
}

export type DecisionLinkResult =
  | { kind: 'ok'; decision: ProjectDecision }
  | { kind: 'not-found' }
  | { kind: 'refused'; status: 409; error: string };

/**
 * Link `decisionId` to `item` (`decisions.work_item_id = item.id`). The route
 * has already read the item; this reads the decision, applies
 * `decideDecisionLink`, and writes.
 *
 * On Aurora the write re-states the rule in its WHERE clause, so a decision
 * linked elsewhere between the read and the write is refused on the second
 * read rather than overwritten.
 */
export async function linkDecisionToWorkItem(
  item: Pick<WorkItem, 'id' | 'projectId'>,
  decisionId: string,
): Promise<DecisionLinkResult> {
  if (!config.mock.aurora) {
    const row = await dbDecisionLinkRow(decisionId);
    if (!row) return { kind: 'not-found' };
    const verdict = decideDecisionLink(item, row);
    if (verdict.kind === 'refuse') return { kind: 'refused', status: verdict.status, error: verdict.error };
    const written = await safeExec(
      `UPDATE decisions SET work_item_id = :wid
        WHERE id = :did AND project_id = :pid
          AND (work_item_id IS NULL OR work_item_id = :wid)
        RETURNING id`,
      [strParam('wid', item.id), strParam('did', decisionId), strParam('pid', item.projectId)],
    );
    if (written.length === 0) {
      const now = await dbDecisionLinkRow(decisionId);
      if (!now) return { kind: 'not-found' };
      const again = decideDecisionLink(item, now);
      return again.kind === 'refuse'
        ? { kind: 'refused', status: again.status, error: again.error }
        : { kind: 'refused', status: 409, error: `decision ${decisionId} changed while it was being linked — retry` };
    }
    const decision = await dbGetProjectDecision(decisionId);
    return decision ? { kind: 'ok', decision } : { kind: 'not-found' };
  }
  const row = decisionRows.rows().find((d) => d.id === decisionId);
  if (!row) return { kind: 'not-found' };
  const verdict = decideDecisionLink(item, row);
  if (verdict.kind === 'refuse') return { kind: 'refused', status: verdict.status, error: verdict.error };
  // The registered `graph-decisions` fixture's own row: POST /api/__mock/reset
  // puts the seeded link back.
  row.workItemId = item.id;
  const decision = mockProjectDecisions(item.projectId).find((d) => d.id === decisionId);
  return decision ? { kind: 'ok', decision } : { kind: 'not-found' };
}

/**
 * Clear the link, but only when `decisionId` is linked to THIS item — a DELETE
 * addressed through one item must never unlink a decision from another.
 * Returns false when there is no such decision or it is not linked here.
 */
export async function unlinkDecisionFromWorkItem(workItemId: string, decisionId: string): Promise<boolean> {
  if (!config.mock.aurora) {
    const rows = await safeExec(
      `UPDATE decisions SET work_item_id = NULL
        WHERE id = :did AND work_item_id = :wid
        RETURNING id`,
      [strParam('did', decisionId), strParam('wid', workItemId)],
    );
    return rows.length > 0;
  }
  const row = decisionRows.rows().find((d) => d.id === decisionId && d.workItemId === workItemId);
  if (!row) return false;
  row.workItemId = null;
  return true;
}

export async function createWorkItem(data: CreateWorkItemInput): Promise<WorkItem> {
  if (!config.mock.aurora) {
    const created = await dbCreateWorkItem(data);
    await noteSearchWrite({ type: 'work', id: created.id });
    return created;
  }
  // Mock: append a real row to the fixture, so the create shows up in the next
  // GET and `POST /api/__mock/reset` takes it away again. The id is the
  // fixture's high-water mark rather than `Date.now()` — a wall-clock id is
  // both unstable under a frozen clock and unreadable in a journey log.
  const id = nextMockWorkItemId();
  const now = clock.nowIso();
  const item: WorkItem = {
    id,
    key: nextMockWorkItemKey(data.projectId),
    projectId: data.projectId,
    // Same rule as the seeded rows: the name comes from the initiative list,
    // never from the caller. A blank here put an unlabelled row on the board.
    projectName: mockProjectName(data.projectId) ?? data.projectId,
    parentId: data.parentId ?? null,
    type: data.type,
    title: data.title,
    description: data.description ?? null,
    status: data.status ?? 'open',
    priority: data.priority ?? 'medium',
    assigneeId: data.assigneeId ?? null,
    assigneeName: data.assigneeId ? mockPeople.find((p) => p.id === data.assigneeId)?.name ?? null : null,
    assigneeDept: data.assigneeId ? mockPeople.find((p) => p.id === data.assigneeId)?.department ?? null : null,
    labels: data.labels ?? [],
    storyPoints: data.storyPoints ?? null,
    summary: null,
    blockedReason: null,
    nextStep: null,
    nextStepDetail: null,
    sprintId: data.sprintId ?? null,
    estimatedCostUsd: data.estimatedCostUsd ?? null,
    // Same as the Aurora path: a new item has no estimator.
    estimatedBy: null, estimatedByName: null,
    estimatedAt: null,
    estimateModel: null,
    estimateForecast: null,
    estimateReviewedBy: null, estimateReviewedByName: null,
    estimateReviewedAt: null,
    prUrl: null,
    prStatus: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    childCount: 0,
    childDoneCount: 0,
  };
  mockWorkItems().push(item);
  await noteSearchWrite({ type: 'work', id: item.id });
  return item;
}

/**
 * Apply a patch. Returns null when no row matched — either the id is unknown,
 * or `expectStatus` was given and the item has moved on since it was read.
 *
 * This is the mechanical write. The board's transition rules live in
 * `decideStatusTransition` and are applied by the route, deliberately *not*
 * here: `bot-runner`'s reconcile settles items on the machine's authority
 * (in_progress → in_review on capture, → open on failure) and must not be
 * refused by a policy written for a human moving a card.
 */
export async function updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<WorkItem | null> {
  if (!config.mock.aurora) {
    const updated = await dbUpdateWorkItem(id, patch);
    if (updated) await noteSearchWrite({ type: 'work', id });
    return updated;
  }
  const item = mockWorkItems().find((i) => i.id === id);
  if (!item) return null;
  if (patch.expectStatus !== undefined && item.status !== patch.expectStatus) return null;
  if (patch.status !== undefined) item.status = patch.status;
  if (patch.priority !== undefined) item.priority = patch.priority;
  if (patch.title !== undefined) item.title = patch.title;
  if (patch.description !== undefined) item.description = patch.description;
  if (patch.labels !== undefined) item.labels = patch.labels;
  if (patch.parentId !== undefined) item.parentId = patch.parentId;
  if (patch.storyPoints !== undefined) item.storyPoints = patch.storyPoints;
  if (patch.sprintId !== undefined) item.sprintId = patch.sprintId;
  if (patch.estimatedCostUsd !== undefined) item.estimatedCostUsd = patch.estimatedCostUsd;
  if (patch.assigneeId !== undefined) {
    // The Aurora read joins `people` for the name and team, so a reassignment must read back named, not as "Unassigned".
    const person = patch.assigneeId ? mockPeople.find((p) => p.id === patch.assigneeId) : undefined;
    item.assigneeId = patch.assigneeId;
    item.assigneeName = person?.name ?? null;
    item.assigneeDept = person?.department ?? null;
  }
  if (patch.prUrl !== undefined) item.prUrl = patch.prUrl;
  if (patch.prStatus !== undefined) item.prStatus = patch.prStatus;
  item.updatedAt = clock.nowIso();
  if (patch.status === 'done') item.completedAt = item.completedAt ?? item.updatedAt;
  await noteSearchWrite({ type: 'work', id });
  return { ...item };
}

/** Reparenting guard — see dbWouldCreateParentCycle. */
export async function wouldCreateParentCycle(id: string, newParentId: string): Promise<boolean> {
  if (id === newParentId) return true;
  if (!config.mock.aurora) return dbWouldCreateParentCycle(id, newParentId);
  const byId = new Map(mockWorkItems().map((i) => [i.id, i] as const));
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === id) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * Change requests still in flight for this work item.
 *
 * Mirrors the open set `providers/sdlc.listChangeRequests({open:true})` uses:
 * captured, awaiting approval, sent back for changes, or under review. A board
 * that calls an item done while one of these is outstanding declares delivered
 * what governance has not delivered.
 */
export async function countOpenChangeRequests(workItemId: string): Promise<number> {
  if (config.mock.aurora) return 0;
  const rows = await safeExec(
    `SELECT COUNT(*)::int AS n FROM agent_change_requests
      WHERE work_item_id = :wid
        AND status IN ('captured','needs_approval','changes_requested','in_review')`,
    [strParam('wid', workItemId)],
  );
  return rows[0] ? Number(rows[0]['n'] ?? 0) : 0;
}

/**
 * Does this initiative exist? The project-scoped collections used to answer
 * `200 []` for a typo'd id, so "wrong id" and "nothing here yet" were the same
 * response.
 */
export async function projectExists(projectId: string): Promise<boolean> {
  if (config.mock.aurora) {
    // The initiative list is the authority — the same one GET /api/graph/projects
    // serves. Asking "does it have work or decisions?" instead made an existing
    // but empty initiative 404 as "Project not found", which is the confusion the
    // sub-collection 404s exist to prevent, inverted.
    //
    // The work/decision fallbacks stay: they can only widen the answer, and a
    // project referenced only by a work item should still resolve rather than
    // vanish.
    return mockProjectExists(projectId)
      || mockWorkItems().some((i) => i.projectId === projectId)
      || decisionRows.rows().some((d) => d.projectId === projectId);
  }
  const rows = await safeExec('SELECT 1 FROM projects WHERE id = :pid LIMIT 1', [strParam('pid', projectId)]);
  return rows.length > 0;
}

/** Same question for `/people/:personId/work`. */
export async function personExists(personId: string): Promise<boolean> {
  if (config.mock.aurora) return mockWorkItems().some((i) => i.assigneeId === personId);
  const rows = await safeExec('SELECT 1 FROM people WHERE id = :pid LIMIT 1', [strParam('pid', personId)]);
  return rows.length > 0;
}

/** One work item by id — the marketplace's dispatch precondition read. */
/**
 * Record the forecast an operator actually authorized against.
 *
 * Called on a SUCCESSFUL dispatch only. A drawer that was opened and cancelled
 * writes nothing: recomputing a number and then walking away is not an estimate
 * anybody made, and storing it would put a decision in the record that nobody
 * took. Same reasoning `bot_runs.dispatched_by` uses for cron firings.
 *
 * `actor` comes from the session subject at the call site and is never read
 * from a request body — the whole point of attribution is that the subject
 * cannot be chosen by the caller.
 *
 * The model is stored WITH the forecast because a forecast is only valid for
 * its own model: Haiku and Opus were measured 20x apart on identical points.
 */
export async function recordWorkItemEstimate(
  id: string,
  actor: string,
  model: string,
  forecast: Record<string, unknown>,
  costUsd: number | null,
): Promise<void> {
  if (config.mock.aurora) {
    const item = mockWorkItems().find((i) => i.id === id);
    if (item) {
      item.estimatedBy = actor;
      item.estimatedByName = displayNameForSubject(actor);
      item.estimatedAt = clock.nowIso();
      item.estimateModel = model;
      item.estimateForecast = forecast;
      if (costUsd != null) item.estimatedCostUsd = costUsd;
      // A NEW estimate supersedes any prior review — somebody signed off on a
      // different number, and carrying that approval forward would attribute an
      // opinion they never gave.
      item.estimateReviewedBy = null;
      item.estimateReviewedByName = null;
      item.estimateReviewedAt = null;
    }
    return;
  }
  await safeExec(
    `UPDATE work_items
        SET estimated_by         = :actor,
            estimated_at         = NOW(),
            estimate_model       = :model,
            estimate_forecast    = :forecast::jsonb,
            estimated_cost_usd   = COALESCE(:cost, estimated_cost_usd),
            estimate_reviewed_by = NULL,
            estimate_reviewed_at = NULL,
            updated_at           = NOW()
      WHERE id = :id`,
    [
      strParam('id', id),
      strParam('actor', actor),
      strParam('model', model),
      strParam('forecast', JSON.stringify(forecast)),
      // NUMERIC as doubleValue, and an explicit isNull when there is no cost —
      // COALESCE in the SQL then keeps whatever was already stored rather than
      // wiping it. There is no doubleParam/nullParam helper in this repo.
      costUsd != null
        ? { name: 'cost', value: { doubleValue: costUsd } }
        : { name: 'cost', value: { isNull: true } },
    ],
  );
}

/**
 * Advisory SME sign-off on the stored estimate.
 *
 * Deliberately does not gate anything. Dispatch already refuses four ways
 * (grant-scoped 403, per-run cap, initiative allocation, sprint envelope); a
 * fifth hard gate is how a fleet stops because a reviewer is on holiday. This
 * records that somebody looked. Turning it into a gate later is one predicate
 * in the dispatch path — the column is already here.
 */
export async function reviewWorkItemEstimate(id: string, actor: string): Promise<boolean> {
  if (config.mock.aurora) {
    const item = mockWorkItems().find((i) => i.id === id);
    if (!item || !item.estimatedAt) return false;
    item.estimateReviewedBy = actor;
    item.estimateReviewedByName = displayNameForSubject(actor);
    item.estimateReviewedAt = clock.nowIso();
    return true;
  }
  // Guarded on estimated_at: reviewing an item that has no estimate would
  // record approval of nothing.
  const rows = await safeExec(
    `UPDATE work_items
        SET estimate_reviewed_by = :actor,
            estimate_reviewed_at = NOW(),
            updated_at           = NOW()
      WHERE id = :id AND estimated_at IS NOT NULL
      RETURNING id`,
    [strParam('id', id), strParam('actor', actor)],
  );
  return rows.length > 0;
}

export async function getWorkItem(id: string): Promise<WorkItem | null> {
  if (config.mock.aurora) {
    const item = mockWorkItems().find((i) => i.id === id);
    return item ? { ...item } : null;
  }
  const withNames = await appUsersAvailable();
  const withBrief = await briefColumnsAvailable();
  const sql = `
    SELECT ${ITEM_COLUMNS}${nameColumns(withNames)}${briefColumns(withBrief)}
    ${ITEM_FROM}${nameJoins(withNames)}
    WHERE wi.id = :id
  `;
  const rows = await safeExec(sql, [strParam('id', id)]);
  return rows[0] ? rowToWorkItem(rows[0]) : null;
}

/**
 * Append a comment to a work item. is_system=true rows render as audit events
 * in the activity feed — the marketplace uses them to say why a run failed.
 */
export async function addWorkItemComment(
  workItemId: string,
  body: string,
  opts: { authorId?: string | null; isSystem?: boolean } = {},
): Promise<void> {
  // The table is audit history now: a human comment is a message on the work
  // item's thread (createWorkItemComment, lib/work-thread.ts), never a row here.
  if (opts.isSystem !== true) throw new Error('work_item_comments is audit-only; a human comment belongs on the orgiq:work thread');
  if (config.mock.aurora) {
    // This used to `return` — a write that reported success and stored
    // nothing. The one comment `dev:mock` actually produces is the settle
    // comment a simulated marketplace dispatch leaves (lib/bot-runner.ts's
    // settleSimulatedRun), which explains why the item went back to `open`
    // instead of to `done`; dropping it left the item silently reverted with
    // no reason recorded anywhere. Appended to the fixture's live rows, the
    // same way the mock POST paths elsewhere push onto `rows()`.
    //
    // `wic-` + a uuid is the column's own DEFAULT in
    // schema/orgiq_work_items_schema.sql, so an id minted here has the shape
    // Aurora would have given it.
    workItemComments.rows().push({
      id: `wic-${randomUUID()}`,
      workItemId,
      authorId: opts.authorId ?? null,
      body,
      isSystem: opts.isSystem === true,
      createdAt: clock.nowIso(),
    });
    return;
  }
  const params: SqlParameter[] = [strParam('wid', workItemId), strParam('body', body)];
  const authorClause = opts.authorId ? ':author' : 'NULL';
  if (opts.authorId) params.push(strParam('author', opts.authorId));
  await safeExec(
    `INSERT INTO work_item_comments (work_item_id, author_id, body, is_system)
     VALUES (:wid, ${authorClause}, :body, ${opts.isSystem ? 'TRUE' : 'FALSE'})`,
    params,
  );
}

// ── Acceptance-criteria checklist ──────────────────────────────────────────────
// work_item_criteria: an ordered checklist on a work item. `position` is dense
// 0..n-1 within a work_item_id; every mutation renumbers so a caller never has
// to reason about gaps. The renumber is the same shape as
// providers/assessment-aurora.ts's `moveKnowledgeNodeRow` — one
// `UPDATE ... FROM` over a `ROW_NUMBER()` window, which is why the table
// carries no UNIQUE(work_item_id, position): Postgres checks a non-deferred
// unique constraint per row, not after the statement, and would spuriously
// reject a plain two-item swap.

export interface WorkItemCriterion {
  id: string;
  workItemId: string;
  text: string;
  done: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

function mockCriteriaRows(): WorkItemCriterionRow[] {
  return workItemCriteria.rows();
}

function toWorkItemCriterion(r: WorkItemCriterionRow): WorkItemCriterion {
  return { ...r };
}

function rowToCriterion(r: Record<string, unknown>): WorkItemCriterion {
  return {
    id: String(r['id'] ?? ''),
    workItemId: String(r['work_item_id'] ?? ''),
    text: String(r['text'] ?? ''),
    done: r['done'] === true,
    position: Number(r['position'] ?? 0),
    createdAt: utcIso(r['created_at']),
    updatedAt: utcIso(r['updated_at']),
  };
}

export async function listWorkItemCriteria(workItemId: string): Promise<WorkItemCriterion[]> {
  if (config.mock.aurora) {
    return mockCriteriaRows()
      .filter((c) => c.workItemId === workItemId)
      .sort((a, b) => a.position - b.position)
      .map(toWorkItemCriterion);
  }
  const rows = await safeExec(
    `SELECT id, work_item_id, text, done, position, created_at, updated_at
       FROM work_item_criteria
      WHERE work_item_id = :wid
      ORDER BY position`,
    [strParam('wid', workItemId)],
  );
  return rows.map(rowToCriterion);
}

export async function createWorkItemCriterion(workItemId: string, text: string): Promise<WorkItemCriterion> {
  if (config.mock.aurora) {
    const rows = mockCriteriaRows();
    const siblings = rows.filter((c) => c.workItemId === workItemId);
    const now = clock.nowIso();
    const row: WorkItemCriterionRow = {
      id: `wicr-${randomUUID()}`,
      workItemId,
      text,
      done: false,
      position: siblings.length,
      createdAt: now,
      updatedAt: now,
    };
    rows.push(row);
    return toWorkItemCriterion(row);
  }
  const rows = await safeExec(
    `INSERT INTO work_item_criteria (work_item_id, text, position)
     VALUES (:wid, :text,
       (SELECT COALESCE(MAX(position), -1) + 1 FROM work_item_criteria WHERE work_item_id = :wid))
     RETURNING id, work_item_id, text, done, position, created_at, updated_at`,
    [strParam('wid', workItemId), strParam('text', text)],
  );
  return rowToCriterion(rows[0]!);
}

export interface UpdateCriterionPatch {
  text?: string;
  done?: boolean;
  position?: number;
}

/**
 * `position` is a request, not an absolute slot: the renumber sorts the
 * target alongside its siblings by the raw value it was given, so an
 * out-of-range ask (negative, or past the end) lands clamped at the nearer
 * end rather than erroring — the same contract `moveKnowledgeNodeRow` gives.
 */
export async function updateWorkItemCriterion(
  workItemId: string,
  criterionId: string,
  patch: UpdateCriterionPatch,
): Promise<WorkItemCriterion | null> {
  if (config.mock.aurora) {
    const rows = mockCriteriaRows();
    const row = rows.find((c) => c.id === criterionId && c.workItemId === workItemId);
    if (!row) return null;
    const now = clock.nowIso();
    if (patch.text !== undefined) row.text = patch.text;
    if (patch.done !== undefined) row.done = patch.done;
    if (patch.text !== undefined || patch.done !== undefined) row.updatedAt = now;
    if (patch.position !== undefined) {
      // Stable-sort the target into its requested slot among siblings ordered
      // by their CURRENT position, then renumber densely — the in-memory twin
      // of the SQL ROW_NUMBER() window below.
      const withoutTarget = rows
        .filter((c) => c.workItemId === workItemId && c.id !== criterionId)
        .sort((a, b) => a.position - b.position);
      const clamped = Math.max(0, Math.min(patch.position, withoutTarget.length));
      withoutTarget.splice(clamped, 0, row);
      withoutTarget.forEach((c, i) => { c.position = i; });
      row.updatedAt = now;
    }
    return toWorkItemCriterion(row);
  }
  if (patch.text !== undefined || patch.done !== undefined) {
    const sets: string[] = ['updated_at = NOW()'];
    const params: SqlParameter[] = [strParam('id', criterionId), strParam('wid', workItemId)];
    if (patch.text !== undefined) { sets.push('text = :text'); params.push(strParam('text', patch.text)); }
    if (patch.done !== undefined) { sets.push('done = :done'); params.push(boolParam('done', patch.done)); }
    const rows = await safeExec(
      `UPDATE work_item_criteria SET ${sets.join(', ')} WHERE id = :id AND work_item_id = :wid RETURNING id`,
      params,
    );
    if (rows.length === 0) return null;
  } else {
    const existing = await safeExec(
      `SELECT id FROM work_item_criteria WHERE id = :id AND work_item_id = :wid`,
      [strParam('id', criterionId), strParam('wid', workItemId)],
    );
    if (existing.length === 0) return null;
  }
  if (patch.position !== undefined) {
    await safeExec(
      `UPDATE work_item_criteria SET position = :pos WHERE id = :id AND work_item_id = :wid`,
      [strParam('id', criterionId), strParam('wid', workItemId), intParam('pos', patch.position)],
    );
    await safeExec(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (
                  ORDER BY position, CASE WHEN id = :id THEN 0 ELSE 1 END, id
                ) - 1 AS rn
           FROM work_item_criteria
          WHERE work_item_id = :wid
       )
       UPDATE work_item_criteria t SET position = o.rn
        FROM ordered o WHERE t.id = o.id`,
      [strParam('id', criterionId), strParam('wid', workItemId)],
    );
  }
  const rows = await safeExec(
    `SELECT id, work_item_id, text, done, position, created_at, updated_at
       FROM work_item_criteria WHERE id = :id`,
    [strParam('id', criterionId)],
  );
  return rows[0] ? rowToCriterion(rows[0]) : null;
}

export async function deleteWorkItemCriterion(workItemId: string, criterionId: string): Promise<boolean> {
  if (config.mock.aurora) {
    const rows = mockCriteriaRows();
    const idx = rows.findIndex((c) => c.id === criterionId && c.workItemId === workItemId);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    rows
      .filter((c) => c.workItemId === workItemId)
      .sort((a, b) => a.position - b.position)
      .forEach((c, i) => { c.position = i; });
    return true;
  }
  const deleted = await safeExec(
    `DELETE FROM work_item_criteria WHERE id = :id AND work_item_id = :wid RETURNING id`,
    [strParam('id', criterionId), strParam('wid', workItemId)],
  );
  if (deleted.length === 0) return false;
  await safeExec(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS rn
         FROM work_item_criteria WHERE work_item_id = :wid
     )
     UPDATE work_item_criteria t SET position = o.rn
      FROM ordered o WHERE t.id = o.id`,
    [strParam('wid', workItemId)],
  );
  return true;
}

// ── Comments (planning notes / discussion) ─────────────────────────────────────
// Distinct from addWorkItemComment above, which lib/bot-runner.ts uses for
// is_system audit rows and does not need a response shape for. These two serve
// GET/POST /api/graph/work-items/:id/comments, where the caller needs the
// created (or listed) row back with the author's name and title joined.

export interface WorkItemCommentView {
  id: string;
  workItemId: string;
  authorId: string | null;
  authorName: string | null;
  authorTitle: string | null;
  body: string;
  isSystem: boolean;
  createdAt: string;
}

function personName(id: string | null): string | null {
  return id ? mockPeople.find((p) => p.id === id)?.name ?? null : null;
}
function personTitle(id: string | null): string | null {
  return id ? mockPeople.find((p) => p.id === id)?.title ?? null : null;
}

/** Who wrote a REST comment: the session's user, stamped by the server. */
export interface CommentAuthor { userId: string; displayName: string; personId: string }

/** How much of a thread the REST read returns (oldest dropped first). */
export const WORK_THREAD_READ_LIMIT = 1000;

async function personTitles(ids: string[]): Promise<Map<string, { name: string | null; title: string | null }>> {
  const out = new Map<string, { name: string | null; title: string | null }>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  if (config.mock.aurora) {
    for (const id of unique) out.set(id, { name: personName(id), title: personTitle(id) });
    return out;
  }
  const params = unique.map((id, i) => strParam(`p${i}`, id));
  const rows = await safeExec(`SELECT id, name, title FROM people WHERE id IN (${unique.map((_, i) => `:p${i}`).join(', ')})`, params);
  for (const r of rows) out.set(String(r['id']), { name: r['name'] != null ? String(r['name']) : null, title: r['title'] != null ? String(r['title']) : null });
  return out;
}

/**
 * The thread's messages one reader sees: the store's per-channel listing
 * (the same `ChatStore.listMessages` the gateway's history serves from), under
 * that reader's history floor (strictly after `historyFrom`), deletions dropped
 * (routes/chat-pins.ts messageVisible — the one visibility rule). A floor
 * lookup that fails is a refusal, not an open history.
 */
async function visibleThread(workItemId: string, viewerUserId: string | null, limit = WORK_THREAD_READ_LIMIT): Promise<ChatMessage[]> {
  const { socialChat } = await import('../lib/social-chat.js');
  const { historyFloor, messageVisible } = await import('../routes/chat-pins.js');
  const chat = socialChat(); await chat.ready;
  const channel = workThreadChannel(workItemId);
  const floor = viewerUserId ? await historyFloor(channel, viewerUserId) : null;
  const legacy = (await chat.chatStore.listMessages(channel, limit)).filter((m) => messageVisible(m, floor));
  const item = await getWorkItem(workItemId);
  if (!item) return legacy;
  const initiativeChannel = `orgiq:initiative:${item.projectId}`;
  const initiativeFloor = viewerUserId ? await historyFloor(initiativeChannel, viewerUserId) : null;
  const contextual = (await chat.chatStore.listMessages(initiativeChannel, limit)).filter(m => {
    const page = m.metadata?.['pageReference'] as { kind?: string; id?: string } | undefined;
    return page?.kind === 'work-item' && page.id === workItemId && messageVisible(m, initiativeFloor);
  });
  return [...legacy, ...contextual].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

const threadMeta = (m: ChatMessage, k: string) => (typeof m.metadata?.[k] === 'string' ? m.metadata[k] as string : null);
/** A human comment on the thread: everything but a system-flagged row. */
const isThreadComment = (m: ChatMessage) => m.metadata?.['system'] !== true;

/** Each message's author person: its provenance, or — a socket send carries none — the sender's user row. */
async function threadPeople(messages: ChatMessage[]): Promise<(m: ChatMessage) => string | null> {
  const people = new Map<string, string | null>();
  for (const m of messages) {
    if (!threadMeta(m, 'authorPersonId') && m.userId && !people.has(m.userId)) people.set(m.userId, (await getUser(m.userId))?.personId ?? null);
  }
  return (m) => threadMeta(m, 'authorPersonId') ?? (m.userId ? people.get(m.userId) ?? null : null);
}

/** The thread's messages as comment rows, under the viewer's history floor (strictly after `historyFrom`). */
async function threadComments(workItemId: string, viewerUserId: string | null): Promise<WorkItemCommentView[]> {
  const messages = await visibleThread(workItemId, viewerUserId);
  const personOf = await threadPeople(messages);
  const directory = await personTitles(messages.map(personOf).filter((p): p is string => !!p));
  return messages.map((m) => {
    const personId = personOf(m);
    return {
      id: threadMeta(m, 'commentId') ?? m.id,
      workItemId,
      authorId: personId,
      authorName: threadMeta(m, 'displayName') ?? (personId ? directory.get(personId)?.name ?? null : null),
      authorTitle: personId ? directory.get(personId)?.title ?? null : null,
      body: m.message,
      isSystem: m.metadata?.['system'] === true,
      createdAt: m.timestamp,
    };
  });
}

/**
 * What `v_work_item_summary.comment_count` used to count from the table: the
 * item's human comments — now read from its ONE store, the thread, as this
 * reader sees it — plus the newest one's instant. Same rule as the comment
 * feed's `total`, so a "N comments" pill and the Discussion tab cannot disagree.
 */
export interface WorkThreadSummary { commentCount: number; lastCommentAt: string | null }

export async function workThreadSummary(workItemId: string, viewerUserId: string | null): Promise<WorkThreadSummary> {
  const comments = (await visibleThread(workItemId, viewerUserId)).filter(isThreadComment);
  let last: string | null = null;
  for (const m of comments) if (!last || m.timestamp > last) last = m.timestamp;
  return { commentCount: comments.length, lastCommentAt: last };
}

/** The audit half: is_system rows of work_item_comments (status changes, run settlements). */
async function auditComments(workItemId: string): Promise<WorkItemCommentView[]> {
  if (config.mock.aurora) {
    return workItemComments.rows()
      .filter((c) => c.workItemId === workItemId && c.isSystem)
      .map((c) => ({
        id: c.id, workItemId: c.workItemId, authorId: c.authorId,
        authorName: personName(c.authorId), authorTitle: personTitle(c.authorId),
        body: c.body, isSystem: true, createdAt: c.createdAt,
      }));
  }
  const rows = await safeExec(
    `SELECT c.id, c.work_item_id, c.author_id, p.name AS author_name, p.title AS author_title,
            c.body, c.is_system, c.created_at::text AS created_at
       FROM work_item_comments c
       LEFT JOIN people p ON p.id = c.author_id
      WHERE c.work_item_id = :wid AND c.is_system
      ORDER BY c.created_at ASC, c.id ASC`,
    [strParam('wid', workItemId)],
  );
  return rows.map((r) => ({
    id: String(r['id'] ?? ''),
    workItemId: String(r['work_item_id'] ?? ''),
    authorId: r['author_id'] != null ? String(r['author_id']) : null,
    authorName: r['author_name'] != null ? String(r['author_name']) : null,
    authorTitle: r['author_title'] != null ? String(r['author_title']) : null,
    body: String(r['body'] ?? ''),
    isSystem: true,
    createdAt: utcIso(r['created_at']),
  }));
}

/**
 * A work item's comment feed: its ONE thread `orgiq:work:<id>` (human
 * discussion, migrated history included — lib/migrate-work-comments.ts) beside
 * the table's audit events, oldest first. `viewerUserId` applies that reader's
 * history floor to the thread.
 */
export async function listWorkItemComments(
  workItemId: string,
  viewerUserId: string | null = null,
): Promise<{ comments: WorkItemCommentView[]; total: number }> {
  const [thread, audit] = await Promise.all([threadComments(workItemId, viewerUserId), auditComments(workItemId)]);
  const comments = [...thread, ...audit].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const total = comments.filter((c) => !c.isSystem).length;
  return { comments, total };
}

/** A REST comment: a message on the work item's thread, sender stamped from the session's user. Never a table row. */
export async function createWorkItemComment(
  workItemId: string,
  author: CommentAuthor,
  body: string,
): Promise<WorkItemCommentView> {
  const { postThreadMessage } = await import('../lib/social-chat.js');
  const at = config.mock.aurora ? clock.nowIso() : new Date().toISOString();
  const message = restCommentMessage({ workItemId, userId: author.userId, displayName: author.displayName, personId: author.personId, body, at });
  await postThreadMessage(message);
  const title = (await personTitles([author.personId])).get(author.personId)?.title ?? null;
  return {
    id: message.id, workItemId, authorId: author.personId, authorName: author.displayName, authorTitle: title,
    body, isSystem: false, createdAt: at,
  };
}

// ── Project activity feed ─────────────────────────────────────────────────────
// Real activity for a project, unioned from two sources and ordered newest-first:
//   • work_items      — created / updated / completed events
//   • work_item_comments — human comments and is_system audit events
//
// This replaces a hardcoded MOCK_FEED that shipped in ProjectsPage.tsx with
// invented actors ("Alex Chen"), invented ticket ids ("K8S-182") and invented
// relative timestamps ("2m ago") — a fabricated feed rendered over a database
// that already held 132 work items and 249 comments.

export interface ProjectActivityItem {
  id: string;
  kind: 'task' | 'pr' | 'comment' | 'status';
  action: string;
  actorId: string | null;
  actorName: string | null;
  workItemId: string;
  ticketId: string;
  subject: string;
  at: string;
  prUrl?: string | null;
  prStatus?: string | null;
}

/** `wi-cdr-t6` → `CDR-T6`; falls back to the raw id when it has no dashes. */
function ticketLabel(workItemId: string): string {
  const parts = workItemId.split('-');
  return parts.length >= 3 ? parts.slice(1).join('-').toUpperCase() : workItemId.toUpperCase();
}

// The two projections, as pure functions over the fields each source supplies,
// so the Aurora branch and the mock branch cannot describe the same event
// differently. (They did not diverge — the mock branch returned `[]` and
// described nothing at all — but a second hand-written copy of "done →
// completed, merged → pr" is exactly how that starts.)

interface CommentEvent {
  id: string; workItemId: string; body: string; isSystem: boolean; at: string;
  authorId: string | null; authorName: string | null;
  title: string; prUrl: string | null; prStatus: string | null;
}

function commentActivity(c: CommentEvent): ProjectActivityItem {
  return {
    id: c.id,
    kind: c.isSystem ? 'status' : 'comment',
    action: c.isSystem ? 'updated' : 'commented on',
    actorId: c.authorId,
    actorName: c.authorName,
    workItemId: c.workItemId,
    ticketId: ticketLabel(c.workItemId),
    // A system row IS its message ("Marketplace run completed without a
    // captured change…"); a human comment is rendered under the item's title.
    subject: c.isSystem ? c.body : c.title,
    at: c.at,
    prUrl: c.prUrl,
    prStatus: c.prStatus,
  };
}

interface ItemEvent {
  id: string; title: string; at: string; isDone: boolean; isUpdated: boolean;
  assigneeId: string | null; assigneeName: string | null;
  prUrl: string | null; prStatus: string | null;
}

function itemActivity(r: ItemEvent): ProjectActivityItem {
  return {
    id: `wi-ev-${r.id}`,
    kind: r.prStatus === 'merged' ? 'pr' : r.isDone ? 'status' : 'task',
    action: r.isDone ? 'completed' : r.prStatus === 'merged' ? 'merged' : r.isUpdated ? 'updated' : 'created',
    actorId: r.assigneeId,
    actorName: r.assigneeName,
    workItemId: r.id,
    ticketId: ticketLabel(r.id),
    subject: r.title,
    at: r.at,
    prUrl: r.prUrl,
    prStatus: r.prStatus,
  };
}

/**
 * The mock analogue of the two statements below: the same two arms, the same
 * per-arm LIMIT before the merge, over this module's own work-item fixture and
 * mock/work-item-comments.ts.
 *
 * It used to return `[]` unconditionally, which made an initiative with
 * seeded work, seeded comments and (since today) real dispatch history read
 * "no activity yet" offline — an unbuilt feature and an unseeded one looking
 * identical, which is the fourth rule of the mock floor.
 *
 * Work-item stamps are reprojected (mockReprojectedIso): the seeds encode
 * "n days before MOCK_EPOCH", and read literally every seeded event would now
 * be months old and sort below anything this process wrote. Comment stamps
 * are NOT reprojected — the fixture takes them from the clock already, and a
 * comment written by a dispatch is a real instant.
 */
async function mockProjectActivity(projectId: string, limit: number, viewerUserId: string | null): Promise<ProjectActivityItem[]> {
  const items = mockWorkItems().filter((i) => i.projectId === projectId);
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const personName = (id: string | null): string | null =>
    (id ? mockPeople.find((p) => p.id === id)?.name ?? null : null);

  // `JOIN work_items w ON w.id = c.work_item_id WHERE w.project_id = :pid` —
  // an inner join, so a comment whose item this initiative does not own is not
  // this initiative's activity.
  // The table's arm is its audit rows only; human comments come from each
  // item's thread (threadActivity), the one store they live in.
  const comments = workItemComments.rows()
    .filter((c) => byId.has(c.workItemId) && c.isSystem)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((c) => {
      const item = byId.get(c.workItemId)!;
      return commentActivity({
        id: c.id, workItemId: c.workItemId, body: c.body, isSystem: c.isSystem,
        at: c.createdAt, authorId: c.authorId, authorName: personName(c.authorId),
        title: item.title, prUrl: item.prUrl, prStatus: item.prStatus,
      });
    });

  const events = items
    .map((i) => ({
      item: i,
      at: mockReprojectedIso(i.completedAt ?? i.updatedAt ?? i.createdAt),
    }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(({ item, at }) => itemActivity({
      id: item.id, title: item.title, at,
      isDone: item.completedAt != null,
      isUpdated: item.updatedAt > item.createdAt,
      assigneeId: item.assigneeId, assigneeName: item.assigneeName,
      prUrl: item.prUrl, prStatus: item.prStatus,
    }));

  const threads = await threadActivity(
    items.map((i) => ({ id: i.id, title: i.title, prUrl: i.prUrl, prStatus: i.prStatus })), viewerUserId, limit);

  return [...comments, ...threads, ...events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Reads per round when the feed walks an initiative's threads. */
const THREAD_FEED_CONCURRENCY = 8;
/** An initiative's threads the feed reads at most (most recently touched items first). */
export const THREAD_FEED_MAX_ITEMS = 200;

interface ThreadFeedItem { id: string; title: string; prUrl: string | null; prStatus: string | null }

/**
 * The comment arm of the activity feed: each item's thread `orgiq:work:<id>`
 * (human comments, migrated history included), newest `limit` per thread, under
 * the viewer's history floor — the same reader rule as the item's own
 * Discussion tab. The table no longer holds a human comment written after the
 * migration, so counting it would hide every new one.
 */
async function threadActivity(items: ThreadFeedItem[], viewerUserId: string | null, limit: number): Promise<ProjectActivityItem[]> {
  const out: ProjectActivityItem[] = [];
  const walk = items.slice(0, THREAD_FEED_MAX_ITEMS);
  for (let i = 0; i < walk.length; i += THREAD_FEED_CONCURRENCY) {
    const round = walk.slice(i, i + THREAD_FEED_CONCURRENCY);
    const read = await Promise.all(round.map(async (item) => {
      const messages = (await visibleThread(item.id, viewerUserId)).filter(isThreadComment)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
      return { item, messages };
    }));
    for (const { item, messages } of read) {
      if (!messages.length) continue;
      const personOf = await threadPeople(messages);
      const names = await personTitles(messages.map(personOf).filter((p): p is string => !!p));
      for (const m of messages) {
        const personId = personOf(m);
        const directoryName = personId ? names.get(personId)?.name ?? null : null;
        out.push(commentActivity({
          id: threadMeta(m, 'commentId') ?? m.id, workItemId: item.id, body: m.message, isSystem: false,
          at: m.timestamp, authorId: personId, authorName: threadMeta(m, 'displayName') ?? directoryName,
          title: item.title, prUrl: item.prUrl, prStatus: item.prStatus,
        }));
      }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export async function getProjectActivity(
  projectId: string,
  opts: { limit?: number; viewerUserId?: string | null } = {},
): Promise<ProjectActivityItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const viewerUserId = opts.viewerUserId ?? null;
  if (config.mock.aurora) return mockProjectActivity(projectId, limit, viewerUserId);

  // The table's arm: audit rows only (status changes, run settlements).
  const commentRows = await exec(
    `SELECT c.id, c.body, c.is_system, c.created_at::text AS at,
            c.author_id, p.name AS author_name,
            w.id AS work_item_id, w.title, w.pr_url, w.pr_status
       FROM work_item_comments c
       JOIN work_items w ON w.id = c.work_item_id
       LEFT JOIN people p ON p.id = c.author_id
      WHERE w.project_id = :pid AND c.is_system
      ORDER BY c.created_at DESC
      LIMIT :lim`,
    [strParam('pid', projectId), intParam('lim', limit)],
  );

  // The thread arm walks the initiative's items, most recently touched first.
  const threadItems = (await exec(
    `SELECT w.id, w.title, w.pr_url, w.pr_status
       FROM work_items w
      WHERE w.project_id = :pid
      ORDER BY COALESCE(w.completed_at, w.updated_at, w.created_at) DESC, w.id
      LIMIT :lim`,
    [strParam('pid', projectId), intParam('lim', THREAD_FEED_MAX_ITEMS)],
  )).map((r) => ({
    id: String(r['id']), title: String(r['title']),
    prUrl: r['pr_url'] ? String(r['pr_url']) : null, prStatus: r['pr_status'] ? String(r['pr_status']) : null,
  }));

  // Work-item lifecycle events. completed_at wins over updated_at so a finished
  // item reads as "completed", not "updated".
  const itemRows = await exec(
    `SELECT w.id, w.title, w.type, w.status, w.pr_url, w.pr_status,
            w.assignee_id, p.name AS assignee_name,
            COALESCE(w.completed_at, w.updated_at, w.created_at)::text AS at,
            (w.completed_at IS NOT NULL) AS is_done,
            (w.updated_at > w.created_at) AS is_updated
       FROM work_items w
       LEFT JOIN people p ON p.id = w.assignee_id
      WHERE w.project_id = :pid
      ORDER BY COALESCE(w.completed_at, w.updated_at, w.created_at) DESC
      LIMIT :lim`,
    [strParam('pid', projectId), intParam('lim', limit)],
  );

  const activity: ProjectActivityItem[] = [];

  for (const r of commentRows) {
    activity.push(commentActivity({
      id: String(r['id']),
      workItemId: String(r['work_item_id']),
      body: String(r['body']),
      isSystem: true, // the statement above selects is_system rows only
      at: String(r['at']),
      authorId: r['author_id'] ? String(r['author_id']) : null,
      authorName: r['author_name'] ? String(r['author_name']) : null,
      title: String(r['title']),
      prUrl: r['pr_url'] ? String(r['pr_url']) : null,
      prStatus: r['pr_status'] ? String(r['pr_status']) : null,
    }));
  }

  for (const r of itemRows) {
    activity.push(itemActivity({
      id: String(r['id']),
      title: String(r['title']),
      at: String(r['at']),
      isDone: r['is_done'] === true,
      isUpdated: r['is_updated'] === true,
      assigneeId: r['assignee_id'] ? String(r['assignee_id']) : null,
      assigneeName: r['assignee_name'] ? String(r['assignee_name']) : null,
      prUrl: r['pr_url'] ? String(r['pr_url']) : null,
      prStatus: r['pr_status'] ? String(r['pr_status']) : null,
    }));
  }

  activity.push(...await threadActivity(threadItems, viewerUserId, limit));

  return activity
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
