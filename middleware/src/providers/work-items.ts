// Work-items provider — reads work_items hierarchy from Aurora PostgreSQL.
// Tables: work_items, projects, people (see schema/orgiq_work_items_schema.sql)
//
// Falls back to rich in-memory mock data when config.mock.aurora === true so
// the portal is fully navigable in offline / local dev without Aurora.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';

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

// ─── RDS parameter helpers ────────────────────────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
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

async function dbSearchWorkItems(opts: {
  label?: string;
  team?: string;
  projectId?: string;
  status?: string;
  period?: string;
  limit?: number;
}): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: SqlParameter[] = [intParam('lim', limit)];
  const clauses: string[] = [];

  if (opts.label) {
    clauses.push(`:label = ANY(wi.labels)`);
    params.push(strParam('label', opts.label));
  }
  if (opts.status) {
    clauses.push(`wi.status = :status`);
    params.push(strParam('status', opts.status));
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

  const sql = `
    SELECT
      wi.id, wi.project_id, p.name AS project_name,
      wi.parent_id, wi.type, wi.title, wi.description,
      wi.status, wi.priority, wi.labels,
      wi.story_points, wi.pr_url, wi.pr_status,
      wi.created_at, wi.updated_at, wi.completed_at,
      a.id AS assignee_id, a.name AS assignee_name, a.team AS assignee_dept,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id) AS child_count,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count
    FROM work_items wi
    JOIN projects p ON p.id = wi.project_id
    LEFT JOIN people a ON a.id = wi.assignee_id
    ${where}
    ORDER BY wi.updated_at DESC
    LIMIT :lim
  `;
  const rows = await safeExec(sql, params);
  return rows.map(rowToWorkItem);
}

async function dbGetProjectWorkItems(projectId: string): Promise<WorkItem[]> {
  const sql = `
    SELECT
      wi.id, wi.project_id, p.name AS project_name,
      wi.parent_id, wi.type, wi.title, wi.description,
      wi.status, wi.priority, wi.labels,
      wi.story_points, wi.pr_url, wi.pr_status,
      wi.created_at, wi.updated_at, wi.completed_at,
      a.id AS assignee_id, a.name AS assignee_name, a.team AS assignee_dept,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id) AS child_count,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count
    FROM work_items wi
    JOIN projects p ON p.id = wi.project_id
    LEFT JOIN people a ON a.id = wi.assignee_id
    WHERE wi.project_id = :pid
    ORDER BY wi.type DESC, wi.created_at ASC
  `;
  const rows = await safeExec(sql, [strParam('pid', projectId)]);
  return rows.map(rowToWorkItem);
}

async function dbGetPersonWorkItems(personId: string, opts: { status?: string; limit?: number }): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const params: SqlParameter[] = [strParam('pid', personId), intParam('lim', limit)];
  const extra = opts.status ? `AND wi.status = :status` : '';
  if (opts.status) params.push(strParam('status', opts.status));

  const sql = `
    SELECT
      wi.id, wi.project_id, p.name AS project_name,
      wi.parent_id, wi.type, wi.title, wi.description,
      wi.status, wi.priority, wi.labels,
      wi.story_points, wi.pr_url, wi.pr_status,
      wi.created_at, wi.updated_at, wi.completed_at,
      a.id AS assignee_id, a.name AS assignee_name, a.team AS assignee_dept,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id) AS child_count,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count
    FROM work_items wi
    JOIN projects p ON p.id = wi.project_id
    LEFT JOIN people a ON a.id = wi.assignee_id
    WHERE wi.assignee_id = :pid ${extra}
    ORDER BY wi.updated_at DESC
    LIMIT :lim
  `;
  const rows = await safeExec(sql, params);
  return rows.map(rowToWorkItem);
}

async function dbGetProjectDecisions(projectId: string): Promise<ProjectDecision[]> {
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
  `;
  const rows = await safeExec(sql, [strParam('pid', projectId)]);
  return rows.map((r) => ({
    id: String(r['id'] ?? ''),
    topic: String(r['topic'] ?? ''),
    summary: r['summary'] != null ? String(r['summary']) : null,
    status: String(r['status'] ?? 'open'),
    requiredRole: r['required_role'] != null ? String(r['required_role']) : null,
    escalatedAt: r['escalated_at'] != null ? String(r['escalated_at']) : null,
    workItemId: r['work_item_id'] != null ? String(r['work_item_id']) : null,
    workItemTitle: r['work_item_title'] != null ? String(r['work_item_title']) : null,
  }));
}

async function dbCreateWorkItem(data: {
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
}): Promise<WorkItem> {
  const labelsLiteral = (data.labels ?? []).length > 0
    ? `ARRAY[${(data.labels ?? []).map(l => `'${l.replace(/'/g, "''")}'`).join(',')}]`
    : 'ARRAY[]::TEXT[]';

  const parentClause = data.parentId ? `:parent_id` : 'NULL';
  const assigneeClause = data.assigneeId ? `:assignee_id` : 'NULL';
  const spClause = data.storyPoints != null ? `:story_points` : 'NULL';

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
  if (data.description) params.push(strParam('description', data.description));

  const descClause = data.description ? `:description` : 'NULL';

  const sql = `
    INSERT INTO work_items
      (project_id, parent_id, type, title, description, status, priority, assignee_id, labels, story_points)
    VALUES
      (:project_id, ${parentClause}, :type, :title, ${descClause}, :status, :priority, ${assigneeClause}, ${labelsLiteral}, ${spClause})
    RETURNING id, project_id, parent_id, type, title, description, status, priority,
              labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at,
              assignee_id
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
      prUrl: null, prStatus: null,
      createdAt: now, updatedAt: now, completedAt: null, childCount: 0, childDoneCount: 0,
    };
  }
  const r = rows[0]!;
  return {
    id: String(r['id'] ?? ''),
    projectId: String(r['project_id'] ?? ''),
    projectName: '',
    parentId: r['parent_id'] != null ? String(r['parent_id']) : null,
    type: (r['type'] as WorkItemType) ?? 'story',
    title: String(r['title'] ?? ''),
    description: r['description'] != null ? String(r['description']) : null,
    status: (r['status'] as WorkItemStatus) ?? 'open',
    priority: (r['priority'] as WorkItemPriority) ?? 'medium',
    assigneeId: r['assignee_id'] != null ? String(r['assignee_id']) : null,
    assigneeName: null,
    assigneeDept: null,
    labels: [],
    storyPoints: r['story_points'] != null ? Number(r['story_points']) : null,
    prUrl: null,
    prStatus: null,
    createdAt: String(r['created_at'] ?? new Date().toISOString()),
    updatedAt: String(r['updated_at'] ?? new Date().toISOString()),
    completedAt: null,
    childCount: 0,
    childDoneCount: 0,
  };
}

async function dbUpdateWorkItem(id: string, patch: {
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  assigneeId?: string | null;
  prUrl?: string | null;
  prStatus?: PrStatus | null;
  completedAt?: string | null;
}): Promise<WorkItem | null> {
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

  params.push(strParam('id', id));
  const sql = `
    UPDATE work_items SET ${sets.join(', ')} WHERE id = :id
    RETURNING id, project_id, parent_id, type, title, description, status, priority,
              labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at,
              assignee_id
  `;
  const rows = await safeExec(sql, params);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: String(r['id'] ?? ''),
    projectId: String(r['project_id'] ?? ''),
    projectName: '',
    parentId: r['parent_id'] != null ? String(r['parent_id']) : null,
    type: (r['type'] as WorkItemType) ?? 'story',
    title: String(r['title'] ?? ''),
    description: r['description'] != null ? String(r['description']) : null,
    status: (r['status'] as WorkItemStatus) ?? 'open',
    priority: (r['priority'] as WorkItemPriority) ?? 'medium',
    assigneeId: r['assignee_id'] != null ? String(r['assignee_id']) : null,
    assigneeName: null,
    assigneeDept: null,
    labels: [],
    storyPoints: r['story_points'] != null ? Number(r['story_points']) : null,
    prUrl: r['pr_url'] != null ? String(r['pr_url']) : null,
    prStatus: r['pr_status'] != null ? (r['pr_status'] as PrStatus) : null,
    createdAt: String(r['created_at'] ?? ''),
    updatedAt: String(r['updated_at'] ?? ''),
    completedAt: r['completed_at'] != null ? String(r['completed_at']) : null,
    childCount: 0,
    childDoneCount: 0,
  };
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

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

const D = (days: number): string => {
  const d = new Date('2026-05-21T12:00:00Z');
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

const MOCK_WORK_ITEMS: WorkItem[] = [
  // ── Project: Kubernetes Cluster Upgrade ────────────────────────────────────
  // Epic 1: Control Plane Upgrade
  { id: 'wi-k8s-e1', projectId: 'p-observability', projectName: 'Observability Platform', parentId: null, type: 'epic', title: 'Control Plane Upgrade to 1.29', description: 'Upgrade all control-plane components from 1.26 to 1.29 with zero-downtime SLO.', status: 'in_progress', priority: 'critical', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra', 'backend'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(45), updatedAt: D(2), completedAt: null, childCount: 2, childDoneCount: 1 },
  // Feature 1.1: Pre-upgrade audit
  { id: 'wi-k8s-f1', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-e1', type: 'story', title: 'Pre-upgrade compatibility audit', description: 'Identify deprecated APIs and incompatible workloads before upgrading.', status: 'done', priority: 'high', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(44), updatedAt: D(20), completedAt: D(20), childCount: 2, childDoneCount: 2 },
  { id: 'wi-k8s-s1', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f1', type: 'story', title: 'Audit deprecated API usage across all deployments', description: 'Run pluto and kubent to find usage of removed API versions.', status: 'done', priority: 'high', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: 5, prUrl: 'https://github.com/orgiq/platform/pull/312', prStatus: 'merged', createdAt: D(44), updatedAt: D(30), completedAt: D(30), childCount: 0, childDoneCount: 0 },
  { id: 'wi-k8s-s2', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f1', type: 'story', title: 'Test workloads in staging 1.29 cluster', description: 'Spin up ephemeral staging cluster at 1.29 and validate all namespace workloads.', status: 'done', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'testing'], storyPoints: 8, prUrl: 'https://github.com/orgiq/platform/pull/331', prStatus: 'merged', createdAt: D(40), updatedAt: D(22), completedAt: D(22), childCount: 0, childDoneCount: 0 },
  // Feature 1.2: Control plane upgrade execution
  { id: 'wi-k8s-f2', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-e1', type: 'story', title: 'Control plane node upgrade', description: 'Rolling upgrade of kube-apiserver, etcd, controller-manager, and scheduler.', status: 'in_progress', priority: 'critical', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(20), updatedAt: D(1), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-k8s-s3', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f2', type: 'story', title: 'Upgrade etcd cluster from 3.4 to 3.5', description: 'Backup etcd, upgrade leader then followers, verify quorum.', status: 'done', priority: 'critical', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra', 'etcd'], storyPoints: 13, prUrl: 'https://github.com/orgiq/platform/pull/388', prStatus: 'merged', createdAt: D(18), updatedAt: D(10), completedAt: D(10), childCount: 2, childDoneCount: 2 },
  { id: 'wi-k8s-t1', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-s3', type: 'story', title: 'Snapshot etcd before upgrade', description: null, status: 'done', priority: 'critical', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'etcd'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(18), updatedAt: D(12), completedAt: D(12), childCount: 0, childDoneCount: 0 },
  { id: 'wi-k8s-t2', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-s3', type: 'story', title: 'Validate etcd quorum post-upgrade', description: null, status: 'done', priority: 'high', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'etcd'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(18), updatedAt: D(10), completedAt: D(10), childCount: 0, childDoneCount: 0 },
  { id: 'wi-k8s-s4', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f2', type: 'story', title: 'Upgrade kube-apiserver pods', description: 'Cordon, drain, upgrade image, uncordon. Repeat per control-plane node.', status: 'in_progress', priority: 'critical', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: 8, prUrl: 'https://github.com/orgiq/platform/pull/401', prStatus: 'open', createdAt: D(8), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-k8s-s5', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f2', type: 'story', title: 'Update admission webhooks and cert-manager', description: 'Ensure TLS bootstrapping certs are renewed for 1.29 admission API changes.', status: 'open', priority: 'high', assigneeId: null, assigneeName: null, assigneeDept: null, labels: ['kubernetes', 'security', 'infra'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(5), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  // Epic 2: Worker Node Fleet
  { id: 'wi-k8s-e2', projectId: 'p-observability', projectName: 'Observability Platform', parentId: null, type: 'epic', title: 'Worker Node Fleet Upgrade', description: 'Replace all worker node groups with 1.29 AMIs using rolling drain strategy.', status: 'open', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(30), updatedAt: D(5), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-k8s-f3', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-e2', type: 'story', title: 'Node drain and replacement strategy', description: 'Design and implement blue/green node group replacement with PodDisruptionBudgets.', status: 'open', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(30), updatedAt: D(8), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-k8s-s6', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f3', type: 'story', title: 'Implement PodDisruptionBudgets for all stateful workloads', description: null, status: 'open', priority: 'high', assigneeId: 'p-004', assigneeName: 'Priya Patel', assigneeDept: 'Platform Engineering', labels: ['kubernetes', 'infra'], storyPoints: 8, prUrl: null, prStatus: null, createdAt: D(25), updatedAt: D(8), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-k8s-s7', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f3', type: 'story', title: 'Write node replacement runbook', description: null, status: 'open', priority: 'medium', assigneeId: 'p-009', assigneeName: "Ryan O'Brien", assigneeDept: 'Product', labels: ['kubernetes', 'documentation'], storyPoints: 3, prUrl: null, prStatus: null, createdAt: D(20), updatedAt: D(8), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-k8s-f4', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-e2', type: 'story', title: 'GPU node group upgrade coordination', description: 'Coordinate with ML team to migrate GPU workloads during node replacement window.', status: 'open', priority: 'medium', assigneeId: 'p-013', assigneeName: 'Ahmed Hassan', assigneeDept: 'Data Platform', labels: ['kubernetes', 'ml', 'infra'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(20), updatedAt: D(5), completedAt: null, childCount: 1, childDoneCount: 0 },
  { id: 'wi-k8s-s8', projectId: 'p-observability', projectName: 'Observability Platform', parentId: 'wi-k8s-f4', type: 'story', title: 'Coordinate ML team GPU workload cutover window', description: null, status: 'open', priority: 'medium', assigneeId: 'p-013', assigneeName: 'Ahmed Hassan', assigneeDept: 'Data Platform', labels: ['kubernetes', 'ml'], storyPoints: 13, prUrl: null, prStatus: null, createdAt: D(18), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── Project: Istio Service Mesh Migration ──────────────────────────────────
  { id: 'wi-istio-e1', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: null, type: 'epic', title: 'Sidecar Injection Rollout', description: 'Enable Istio sidecar injection across all production namespaces with mTLS in STRICT mode.', status: 'in_progress', priority: 'high', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['istio', 'service-mesh', 'kubernetes', 'security'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(60), updatedAt: D(3), completedAt: null, childCount: 2, childDoneCount: 1 },
  { id: 'wi-istio-f1', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-e1', type: 'story', title: 'Namespace opt-in labels', description: null, status: 'done', priority: 'high', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['istio', 'kubernetes'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(58), updatedAt: D(30), completedAt: D(30), childCount: 2, childDoneCount: 2 },
  { id: 'wi-istio-s1', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-f1', type: 'story', title: 'Apply istio-injection=enabled to core namespaces', description: null, status: 'done', priority: 'high', assigneeId: 'p-001', assigneeName: 'Alex Chen', assigneeDept: 'Platform Engineering', labels: ['istio', 'kubernetes'], storyPoints: 3, prUrl: 'https://github.com/orgiq/platform/pull/255', prStatus: 'merged', createdAt: D(55), updatedAt: D(40), completedAt: D(40), childCount: 0, childDoneCount: 0 },
  { id: 'wi-istio-s2', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-f1', type: 'story', title: 'Document injection troubleshooting guide', description: null, status: 'in_review', priority: 'medium', assigneeId: 'p-009', assigneeName: "Ryan O'Brien", assigneeDept: 'Product', labels: ['istio', 'documentation'], storyPoints: 5, prUrl: 'https://github.com/orgiq/platform/pull/289', prStatus: 'open', createdAt: D(45), updatedAt: D(3), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-istio-f2', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-e1', type: 'story', title: 'Traffic policy and mTLS configuration', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['istio', 'security', 'service-mesh'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(30), updatedAt: D(2), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-istio-s3', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-f2', type: 'story', title: 'Configure mTLS STRICT mode for payment-svc', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['istio', 'security'], storyPoints: 8, prUrl: 'https://github.com/orgiq/platform/pull/410', prStatus: 'draft', createdAt: D(15), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-istio-s4', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-f2', type: 'story', title: 'Port circuit-breaker configs from Hystrix to Istio DestinationRules', description: null, status: 'open', priority: 'high', assigneeId: 'p-004', assigneeName: 'Priya Patel', assigneeDept: 'Platform Engineering', labels: ['istio', 'resilience'], storyPoints: 13, prUrl: null, prStatus: null, createdAt: D(10), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-istio-e2', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: null, type: 'epic', title: 'Observability Integration', description: 'Connect Istio telemetry to unified observability stack (Prometheus + Grafana + Tempo).', status: 'open', priority: 'medium', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['istio', 'observability', 'service-mesh'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(40), updatedAt: D(5), completedAt: null, childCount: 1, childDoneCount: 0 },
  { id: 'wi-istio-f3', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-e2', type: 'story', title: 'Kiali + Jaeger integration', description: null, status: 'open', priority: 'medium', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['istio', 'observability'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(35), updatedAt: D(5), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-istio-s5', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-f3', type: 'story', title: 'Deploy Kiali dashboard for mesh topology', description: null, status: 'open', priority: 'medium', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['istio', 'observability'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(30), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-istio-s6', projectId: 'p-zero-trust', projectName: 'Zero Trust Network', parentId: 'wi-istio-f3', type: 'story', title: 'Configure Jaeger sampling rates per service class', description: null, status: 'open', priority: 'low', assigneeId: null, assigneeName: null, assigneeDept: null, labels: ['istio', 'observability'], storyPoints: 3, prUrl: null, prStatus: null, createdAt: D(28), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── Project: CI/CD Pipeline Unification ───────────────────────────────────
  { id: 'wi-cicd-e1', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: null, type: 'epic', title: 'Migrate to Unified GitHub Actions Workflows', description: 'Replace 14 disparate Jenkins + CircleCI pipelines with a shared GitHub Actions monorepo workflow.', status: 'in_progress', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'github-actions', 'devops'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(50), updatedAt: D(1), completedAt: null, childCount: 2, childDoneCount: 1 },
  { id: 'wi-cicd-f1', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-e1', type: 'story', title: 'Shared reusable workflow library', description: null, status: 'done', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'github-actions'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(48), updatedAt: D(25), completedAt: D(25), childCount: 2, childDoneCount: 2 },
  { id: 'wi-cicd-s1', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-f1', type: 'story', title: 'Create reusable build-test-publish workflow', description: null, status: 'done', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'github-actions'], storyPoints: 8, prUrl: 'https://github.com/orgiq/platform/pull/190', prStatus: 'merged', createdAt: D(48), updatedAt: D(33), completedAt: D(33), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cicd-s2', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-f1', type: 'story', title: 'Implement OIDC-based AWS credential vending', description: null, status: 'done', priority: 'high', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'security', 'aws'], storyPoints: 5, prUrl: 'https://github.com/orgiq/platform/pull/201', prStatus: 'merged', createdAt: D(45), updatedAt: D(28), completedAt: D(28), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cicd-f2', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-e1', type: 'story', title: 'Service-by-service pipeline migration', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-003', assigneeName: 'James Wright', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'github-actions'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(25), updatedAt: D(1), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-cicd-s3', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-f2', type: 'story', title: 'Migrate orgiq-supervisor service to GitHub Actions', description: null, status: 'done', priority: 'high', assigneeId: 'p-002', assigneeName: 'Maria Santos', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'github-actions'], storyPoints: 5, prUrl: 'https://github.com/orgiq/platform/pull/222', prStatus: 'merged', createdAt: D(24), updatedAt: D(15), completedAt: D(15), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cicd-s4', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-f2', type: 'story', title: 'Migrate data-platform services to GitHub Actions', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-003', assigneeName: 'James Wright', assigneeDept: 'Platform Engineering', labels: ['ci-cd', 'github-actions'], storyPoints: 8, prUrl: 'https://github.com/orgiq/platform/pull/240', prStatus: 'draft', createdAt: D(18), updatedAt: D(1), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-cicd-s5', projectId: 'p-llm-platform', projectName: 'LLM Application Platform', parentId: 'wi-cicd-f2', type: 'story', title: 'Migrate legacy Jenkins jobs for newsroom services', description: null, status: 'open', priority: 'low', assigneeId: null, assigneeName: null, assigneeDept: null, labels: ['ci-cd', 'github-actions'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(10), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── Project: Unified Observability Stack ──────────────────────────────────
  { id: 'wi-otel-e1', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: null, type: 'epic', title: 'OpenTelemetry Collector Migration', description: 'Replace CloudWatch Agents and Datadog agents with ADOT collector as the single telemetry pipeline.', status: 'in_progress', priority: 'high', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'opentelemetry', 'kubernetes'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(70), updatedAt: D(2), completedAt: null, childCount: 2, childDoneCount: 1 },
  { id: 'wi-otel-f1', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-e1', type: 'story', title: 'ADOT Collector DaemonSet deployment', description: null, status: 'done', priority: 'high', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'opentelemetry', 'kubernetes'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(68), updatedAt: D(35), completedAt: D(35), childCount: 2, childDoneCount: 2 },
  { id: 'wi-otel-s1', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f1', type: 'story', title: 'Deploy ADOT collector as DaemonSet in production', description: null, status: 'done', priority: 'high', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'opentelemetry'], storyPoints: 5, prUrl: 'https://github.com/orgiq/infra/pull/88', prStatus: 'merged', createdAt: D(65), updatedAt: D(45), completedAt: D(45), childCount: 0, childDoneCount: 0 },
  { id: 'wi-otel-s2', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f1', type: 'story', title: 'Configure Prometheus remote-write to Amazon Managed Prometheus', description: null, status: 'done', priority: 'high', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'prometheus'], storyPoints: 3, prUrl: 'https://github.com/orgiq/infra/pull/95', prStatus: 'merged', createdAt: D(60), updatedAt: D(40), completedAt: D(40), childCount: 0, childDoneCount: 0 },
  { id: 'wi-otel-f2', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-e1', type: 'story', title: 'Service instrumentation', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'opentelemetry'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(35), updatedAt: D(2), completedAt: null, childCount: 3, childDoneCount: 1 },
  { id: 'wi-otel-s3', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f2', type: 'story', title: 'Instrument orgiq-supervisor with OTel traces', description: null, status: 'done', priority: 'high', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'opentelemetry'], storyPoints: 8, prUrl: 'https://github.com/orgiq/agents/pull/44', prStatus: 'merged', createdAt: D(33), updatedAt: D(20), completedAt: D(20), childCount: 0, childDoneCount: 0 },
  { id: 'wi-otel-s4', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f2', type: 'story', title: 'Instrument ingestion pipeline with OTel spans', description: null, status: 'in_progress', priority: 'medium', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'opentelemetry'], storyPoints: 5, prUrl: 'https://github.com/orgiq/agents/pull/58', prStatus: 'draft', createdAt: D(15), updatedAt: D(2), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-otel-s5', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f2', type: 'story', title: 'Migrate CloudWatch metric namespace to OTel conventions', description: null, status: 'open', priority: 'medium', assigneeId: null, assigneeName: null, assigneeDept: null, labels: ['observability', 'cloudwatch'], storyPoints: 13, prUrl: null, prStatus: null, createdAt: D(10), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-otel-e2', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: null, type: 'epic', title: 'Grafana Dashboard Library', description: 'Standardized dashboards for SLO burn rates, agent traces, and infra capacity.', status: 'open', priority: 'medium', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'grafana'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(40), updatedAt: D(5), completedAt: null, childCount: 1, childDoneCount: 0 },
  { id: 'wi-otel-f3', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-e2', type: 'story', title: 'SLO burn-rate dashboards', description: null, status: 'open', priority: 'medium', assigneeId: 'p-021', assigneeName: 'Ben Foster', assigneeDept: 'Platform Engineering', labels: ['observability', 'grafana'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(38), updatedAt: D(5), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-otel-s6', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f3', type: 'story', title: 'Create SLO burn-rate dashboard for API gateway', description: null, status: 'open', priority: 'medium', assigneeId: null, assigneeName: null, assigneeDept: null, labels: ['observability', 'grafana'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(35), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-otel-s7', projectId: 'p-inference-platform', projectName: 'Unified Observability Stack', parentId: 'wi-otel-f3', type: 'story', title: 'Create agent invocation latency p99 dashboard', description: null, status: 'open', priority: 'low', assigneeId: null, assigneeName: null, assigneeDept: null, labels: ['observability', 'grafana'], storyPoints: 3, prUrl: null, prStatus: null, createdAt: D(30), updatedAt: D(5), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── Project: Cedar Auth Policy Migration ──────────────────────────────────
  { id: 'wi-cedar-e1', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: null, type: 'epic', title: 'Replace RBAC with Cedar Policy Engine', description: 'Migrate all application-level authz checks from hardcoded role checks to Cedar policies in Amazon Verified Permissions.', status: 'in_progress', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth', 'security', 'aws'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(55), updatedAt: D(3), completedAt: null, childCount: 2, childDoneCount: 1 },
  { id: 'wi-cedar-f1', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: 'wi-cedar-e1', type: 'story', title: 'Policy schema and seed policies', description: null, status: 'done', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(53), updatedAt: D(25), completedAt: D(25), childCount: 2, childDoneCount: 2 },
  { id: 'wi-cedar-s1', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: 'wi-cedar-f1', type: 'story', title: 'Design Cedar schema for OrgIQ principal/resource types', description: null, status: 'done', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth'], storyPoints: 8, prUrl: 'https://github.com/orgiq/infra/pull/112', prStatus: 'merged', createdAt: D(52), updatedAt: D(38), completedAt: D(38), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cedar-s2', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: 'wi-cedar-f1', type: 'story', title: 'Seed role-based Cedar policies (member/org-leader/hr-admin)', description: null, status: 'done', priority: 'high', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth'], storyPoints: 5, prUrl: 'https://github.com/orgiq/infra/pull/128', prStatus: 'merged', createdAt: D(45), updatedAt: D(28), completedAt: D(28), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cedar-f2', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: 'wi-cedar-e1', type: 'story', title: 'Middleware authz middleware integration', description: null, status: 'in_progress', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth', 'backend'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(25), updatedAt: D(3), completedAt: null, childCount: 2, childDoneCount: 1 },
  { id: 'wi-cedar-s3', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: 'wi-cedar-f2', type: 'story', title: 'Implement requireAction() Cedar middleware helper', description: null, status: 'done', priority: 'critical', assigneeId: 'p-022', assigneeName: 'Sophie Turner', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth', 'backend'], storyPoints: 13, prUrl: 'https://github.com/orgiq/middleware/pull/67', prStatus: 'merged', createdAt: D(24), updatedAt: D(12), completedAt: D(12), childCount: 0, childDoneCount: 0 },
  { id: 'wi-cedar-s4', projectId: 'p-rag-search', projectName: 'Cedar Auth Policy Migration', parentId: 'wi-cedar-f2', type: 'story', title: 'Gate ManageIngest and ManageCanary with Cedar policies', description: null, status: 'in_progress', priority: 'high', assigneeId: 'p-003', assigneeName: 'James Wright', assigneeDept: 'Platform Engineering', labels: ['cedar', 'auth'], storyPoints: 8, prUrl: 'https://github.com/orgiq/middleware/pull/79', prStatus: 'open', createdAt: D(12), updatedAt: D(3), completedAt: null, childCount: 0, childDoneCount: 0 },

  // ── Project: Developer Onboarding ─────────────────────────────────────────
  { id: 'wi-onboard-e1', projectId: 'p-mobile-redesign', projectName: 'Developer Onboarding Improvements', parentId: null, type: 'epic', title: 'Self-Service Dev Environment Setup', description: 'Reduce time-to-first-commit from 5 days to same day for new engineers.', status: 'open', priority: 'high', assigneeId: 'p-005', assigneeName: 'David Kim', assigneeDept: 'Platform Engineering', labels: ['onboarding', 'devex', 'developer-experience'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(30), updatedAt: D(7), completedAt: null, childCount: 1, childDoneCount: 0 },
  { id: 'wi-onboard-f1', projectId: 'p-mobile-redesign', projectName: 'Developer Onboarding Improvements', parentId: 'wi-onboard-e1', type: 'story', title: 'Automated dev toolchain bootstrap script', description: null, status: 'open', priority: 'high', assigneeId: 'p-003', assigneeName: 'James Wright', assigneeDept: 'Platform Engineering', labels: ['onboarding', 'devex'], storyPoints: null, prUrl: null, prStatus: null, createdAt: D(28), updatedAt: D(7), completedAt: null, childCount: 2, childDoneCount: 0 },
  { id: 'wi-onboard-s1', projectId: 'p-mobile-redesign', projectName: 'Developer Onboarding Improvements', parentId: 'wi-onboard-f1', type: 'story', title: 'Write bootstrap.sh to install all required tools via brew/mise', description: null, status: 'open', priority: 'high', assigneeId: 'p-003', assigneeName: 'James Wright', assigneeDept: 'Platform Engineering', labels: ['onboarding', 'devex'], storyPoints: 5, prUrl: null, prStatus: null, createdAt: D(25), updatedAt: D(7), completedAt: null, childCount: 0, childDoneCount: 0 },
  { id: 'wi-onboard-s2', projectId: 'p-mobile-redesign', projectName: 'Developer Onboarding Improvements', parentId: 'wi-onboard-f1', type: 'story', title: 'Create ONBOARDING.md with architecture overview + runbook', description: null, status: 'open', priority: 'medium', assigneeId: 'p-009', assigneeName: "Ryan O'Brien", assigneeDept: 'Product', labels: ['onboarding', 'documentation'], storyPoints: 3, prUrl: null, prStatus: null, createdAt: D(20), updatedAt: D(7), completedAt: null, childCount: 0, childDoneCount: 0 },
];

const MOCK_DECISIONS: ProjectDecision[] = [
  { id: 'dec-001', topic: 'Observability stack: Datadog vs Grafana OSS', summary: 'Evaluate Datadog vs Grafana stack for unified observability. Datadog\'s APM integration is strong but $180k/yr at current scale. Grafana Tempo + Mimir offers 60% cost reduction with more ops overhead. Decision unblocks OTel migration epic.', status: 'escalated', requiredRole: 'org-leader', escalatedAt: D(5), workItemId: 'wi-otel-e1', workItemTitle: 'OpenTelemetry Collector Migration' },
  { id: 'dec-002', topic: 'SSO provider: Okta vs AWS IAM Identity Center', summary: 'Platform needs to pick a single SSO provider before Cedar policy migration completes. AWS IAM Identity Center integrates natively with Verified Permissions but has limited SCIM support. Okta has mature SCIM and broad app catalog.', status: 'escalated', requiredRole: 'hr-admin', escalatedAt: D(3), workItemId: 'wi-cedar-e1', workItemTitle: 'Replace RBAC with Cedar Policy Engine' },
  { id: 'dec-003', topic: 'Kubernetes upgrade window: maintenance or rolling?', summary: 'Control-plane upgrade can be done during a 2-hour maintenance window (simpler) or via zero-downtime rolling strategy (more complex). SRE recommends rolling given 99.95% SLO commitment.', status: 'resolved', requiredRole: null, escalatedAt: null, workItemId: 'wi-k8s-e1', workItemTitle: 'Control Plane Upgrade to 1.29' },
  { id: 'dec-004', topic: 'Istio vs Linkerd for service mesh', summary: 'Original ADR chose Linkerd for simplicity but Istio selected after audit of team expertise and integration requirements for Kiali/Jaeger. Decision is resolved.', status: 'resolved', requiredRole: null, escalatedAt: null, workItemId: 'wi-istio-e1', workItemTitle: 'Sidecar Injection Rollout' },
];

// Project ID → decisions index
const PROJECT_DECISIONS: Record<string, string[]> = {
  'p-observability': ['dec-003'],
  'p-inference-platform': ['dec-001'],
  'p-rag-search': ['dec-002'],
  'p-zero-trust': ['dec-004'],
};

// ─── Public API ───────────────────────────────────────────────────────────────

export async function searchWorkItems(opts: {
  label?: string;
  team?: string;
  projectId?: string;
  status?: string;
  period?: string;
  limit?: number;
}): Promise<WorkItem[]> {
  if (!config.mock.aurora) {
    return dbSearchWorkItems(opts);
  }
  // Mock path
  let items = MOCK_WORK_ITEMS.slice();
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
  if (opts.period === 'today') {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    items = items.filter((i) => new Date(i.updatedAt) >= cutoff);
  } else if (opts.period === 'week') {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    items = items.filter((i) => new Date(i.updatedAt) >= cutoff);
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.slice(0, Math.min(opts.limit ?? 50, 200));
}

export async function getProjectWorkItems(projectId: string): Promise<WorkItem[]> {
  if (!config.mock.aurora) {
    return dbGetProjectWorkItems(projectId);
  }
  return MOCK_WORK_ITEMS.filter((i) => i.projectId === projectId);
}

export async function getProjectWorkTree(projectId: string): Promise<WorkItemTree[]> {
  const items = await getProjectWorkItems(projectId);
  return buildWorkItemTree(items);
}

export async function getPersonWorkItems(personId: string, opts: { status?: string; limit?: number } = {}): Promise<WorkItem[]> {
  if (!config.mock.aurora) {
    return dbGetPersonWorkItems(personId, opts);
  }
  let items = MOCK_WORK_ITEMS.filter((i) => i.assigneeId === personId);
  if (opts.status) items = items.filter((i) => i.status === opts.status);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.slice(0, opts.limit ?? 30);
}

export async function getProjectDecisions(projectId: string): Promise<ProjectDecision[]> {
  if (!config.mock.aurora) {
    return dbGetProjectDecisions(projectId);
  }
  const ids = PROJECT_DECISIONS[projectId] ?? [];
  return MOCK_DECISIONS.filter((d) => ids.includes(d.id));
}

export async function createWorkItem(data: {
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
}): Promise<WorkItem> {
  if (!config.mock.aurora) {
    return dbCreateWorkItem(data);
  }
  // Mock: return a synthetic item
  const id = `wi-mock-${Date.now()}`;
  const now = new Date().toISOString();
  const item: WorkItem = {
    id,
    projectId: data.projectId,
    projectName: '',
    parentId: data.parentId ?? null,
    type: data.type,
    title: data.title,
    description: data.description ?? null,
    status: data.status ?? 'open',
    priority: data.priority ?? 'medium',
    assigneeId: data.assigneeId ?? null,
    assigneeName: null,
    assigneeDept: null,
    labels: data.labels ?? [],
    storyPoints: data.storyPoints ?? null,
    prUrl: null,
    prStatus: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    childCount: 0,
    childDoneCount: 0,
  };
  MOCK_WORK_ITEMS.push(item);
  return item;
}

export async function updateWorkItem(id: string, patch: {
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  assigneeId?: string | null;
  prUrl?: string | null;
  prStatus?: PrStatus | null;
}): Promise<WorkItem | null> {
  if (!config.mock.aurora) {
    return dbUpdateWorkItem(id, patch);
  }
  const item = MOCK_WORK_ITEMS.find((i) => i.id === id);
  if (!item) return null;
  if (patch.status !== undefined) item.status = patch.status;
  if (patch.priority !== undefined) item.priority = patch.priority;
  if (patch.assigneeId !== undefined) item.assigneeId = patch.assigneeId;
  if (patch.prUrl !== undefined) item.prUrl = patch.prUrl;
  if (patch.prStatus !== undefined) item.prStatus = patch.prStatus;
  item.updatedAt = new Date().toISOString();
  if (patch.status === 'done') item.completedAt = item.completedAt ?? item.updatedAt;
  return { ...item };
}

/** One work item by id — the marketplace's dispatch precondition read. */
export async function getWorkItem(id: string): Promise<WorkItem | null> {
  if (config.mock.aurora) {
    const item = MOCK_WORK_ITEMS.find((i) => i.id === id);
    return item ? { ...item } : null;
  }
  const sql = `
    SELECT
      wi.id, wi.project_id, p.name AS project_name,
      wi.parent_id, wi.type, wi.title, wi.description,
      wi.status, wi.priority, wi.labels,
      wi.story_points, wi.pr_url, wi.pr_status,
      wi.created_at, wi.updated_at, wi.completed_at,
      a.id AS assignee_id, a.name AS assignee_name, a.team AS assignee_dept,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id) AS child_count,
      (SELECT COUNT(*)::int FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count
    FROM work_items wi
    JOIN projects p ON p.id = wi.project_id
    LEFT JOIN people a ON a.id = wi.assignee_id
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
  if (config.mock.aurora) return;
  const params: SqlParameter[] = [strParam('wid', workItemId), strParam('body', body)];
  const authorClause = opts.authorId ? ':author' : 'NULL';
  if (opts.authorId) params.push(strParam('author', opts.authorId));
  await safeExec(
    `INSERT INTO work_item_comments (work_item_id, author_id, body, is_system)
     VALUES (:wid, ${authorClause}, :body, ${opts.isSystem ? 'TRUE' : 'FALSE'})`,
    params,
  );
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

export async function getProjectActivity(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<ProjectActivityItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  if (config.mock.aurora) return [];

  // Comments (human + system audit rows) joined to their work item.
  const commentRows = await exec(
    `SELECT c.id, c.body, c.is_system, c.created_at::text AS at,
            c.author_id, p.name AS author_name,
            w.id AS work_item_id, w.title, w.pr_url, w.pr_status
       FROM work_item_comments c
       JOIN work_items w ON w.id = c.work_item_id
       LEFT JOIN people p ON p.id = c.author_id
      WHERE w.project_id = :pid
      ORDER BY c.created_at DESC
      LIMIT :lim`,
    [strParam('pid', projectId), intParam('lim', limit)],
  );

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
    const isSystem = r['is_system'] === true;
    activity.push({
      id: String(r['id']),
      kind: isSystem ? 'status' : 'comment',
      action: isSystem ? 'updated' : 'commented on',
      actorId: r['author_id'] ? String(r['author_id']) : null,
      actorName: r['author_name'] ? String(r['author_name']) : null,
      workItemId: String(r['work_item_id']),
      ticketId: ticketLabel(String(r['work_item_id'])),
      subject: isSystem ? String(r['body']) : String(r['title']),
      at: String(r['at']),
      prUrl: r['pr_url'] ? String(r['pr_url']) : null,
      prStatus: r['pr_status'] ? String(r['pr_status']) : null,
    });
  }

  for (const r of itemRows) {
    const prStatus = r['pr_status'] ? String(r['pr_status']) : null;
    const done = r['is_done'] === true;
    const updated = r['is_updated'] === true;
    activity.push({
      id: `wi-ev-${String(r['id'])}`,
      kind: prStatus === 'merged' ? 'pr' : done ? 'status' : 'task',
      action: done ? 'completed' : prStatus === 'merged' ? 'merged' : updated ? 'updated' : 'created',
      actorId: r['assignee_id'] ? String(r['assignee_id']) : null,
      actorName: r['assignee_name'] ? String(r['assignee_name']) : null,
      workItemId: String(r['id']),
      ticketId: ticketLabel(String(r['id'])),
      subject: String(r['title']),
      at: String(r['at']),
      prUrl: r['pr_url'] ? String(r['pr_url']) : null,
      prStatus,
    });
  }

  return activity
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
