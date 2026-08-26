// Agent projects — repositories that agents work on, and what they did to them.
//
// Named `agent-projects` rather than `projects` because `projects` already
// means something else here: the org graph's initiatives that people
// contribute to. Distinct tables, but not unrelated things — an enterprise
// project has people who own it *and* code that delivers it. They are joined
// through org_project_id, so a run against a repository can be attributed to
// the initiative it serves, and an initiative can show the code its agents are
// changing.
//
// This is deliberately not a GitHub mirror. The familiar surfaces there exist
// to coordinate people — issue lists, review threads, comment history,
// reactions. On a repository whose contributors are agents there is nobody to
// coordinate with, and an empty discussion tab is worse than no tab.
//
// The questions worth answering are different: which workspace holds this
// checkout, what has been run against it, what changed, and did it work.

import { randomUUID } from 'node:crypto';
import { exec } from './aurora.js';
import { borrowApiKey } from './connected-sources.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export interface AgentProject {
  id: string;
  repoFullName: string;
  /** The initiative this repository implements, if it serves one. */
  orgProjectId: string | null;
  orgProjectName: string | null;
  /** People who own that initiative — the humans accountable for the work. */
  owners: Array<{ personId: string; name: string; role: string | null }>;
  defaultBranch: string;
  connectionName: string | null;
  sessionId: string | null;
  workspacePath: string;
  clonedAt: string | null;
  createdAt: string;
}

export interface ProjectRun {
  id: string;
  projectId: string;
  prompt: string;
  model: string | null;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  filesChanged: number | null;
  diffSummary: string | null;
  error: string | null;
  /** What the run actually cost, as reported by the agent runtime. */
  costUsd: number | null;
}

function rowToProject(r: Record<string, unknown>): AgentProject {
  return {
    id: toStr(r['id']),
    repoFullName: toStr(r['repo_full_name']),
    orgProjectId: r['org_project_id'] ? toStr(r['org_project_id']) : null,
    orgProjectName: r['org_project_name'] ? toStr(r['org_project_name']) : null,
    owners: [],
    defaultBranch: toStr(r['default_branch'], 'main'),
    connectionName: r['connection_name'] ? toStr(r['connection_name']) : null,
    sessionId: r['session_id'] ? toStr(r['session_id']) : null,
    workspacePath: toStr(r['workspace_path'], '/mnt/workspace'),
    clonedAt: r['cloned_at'] ? toStr(r['cloned_at']) : null,
    createdAt: toStr(r['created_at']),
  };
}

function rowToRun(r: Record<string, unknown>): ProjectRun {
  return {
    id: toStr(r['id']),
    projectId: toStr(r['project_id']),
    prompt: toStr(r['prompt']),
    model: r['model'] ? toStr(r['model']) : null,
    status: toStr(r['status'], 'running') as ProjectRun['status'],
    startedAt: toStr(r['started_at']),
    finishedAt: r['finished_at'] ? toStr(r['finished_at']) : null,
    durationMs: r['duration_ms'] == null ? null : toNum(r['duration_ms']),
    filesChanged: r['files_changed'] == null ? null : toNum(r['files_changed']),
    diffSummary: r['diff_summary'] ? toStr(r['diff_summary']) : null,
    error: r['error'] ? toStr(r['error']) : null,
    costUsd: r['cost_usd'] == null ? null : toNum(r['cost_usd']),
  };
}

export async function listAgentProjects(): Promise<AgentProject[]> {
  if (config.mock.aurora) return [];
  const rows = await exec(
    `SELECT ap.*, p.name AS org_project_name
       FROM agent_projects ap
       LEFT JOIN projects p ON p.id = ap.org_project_id
      ORDER BY ap.created_at DESC LIMIT 200`,
  );
  const projects = rows.map(rowToProject);

  // Who owns the initiative each repo serves. An enterprise repository is not
  // ownerless just because agents do the typing — somebody is accountable for
  // the work, and a console that cannot say who is missing the point.
  const ids = projects.map((p) => p.orgProjectId).filter((v): v is string => Boolean(v));
  if (ids.length > 0) {
    const owners = await exec(
      `SELECT pc.project_id, pc.person_id, pe.name, pc.role
         FROM project_contributions pc
         JOIN people pe ON pe.id = pc.person_id
        WHERE pc.project_id IN (${ids.map((_, i) => `:p${i}`).join(', ')})
        ORDER BY pc.weight DESC NULLS LAST`,
      ids.map((v, i) => s(`p${i}`, v)),
    );
    for (const p of projects) {
      p.owners = owners
        .filter((o) => toStr(o['project_id']) === p.orgProjectId)
        .slice(0, 4)
        .map((o) => ({
          personId: toStr(o['person_id']),
          name: toStr(o['name']),
          role: o['role'] ? toStr(o['role']) : null,
        }));
    }
  }
  return projects;
}

export async function getAgentProject(id: string): Promise<AgentProject | null> {
  if (!isUuid(id)) return null;
  const rows = await exec(
    `SELECT ap.*, p.name AS org_project_name
       FROM agent_projects ap
       LEFT JOIN projects p ON p.id = ap.org_project_id
      WHERE ap.id = :id::uuid`,
    [s('id', id)],
  );
  return rows[0] ? rowToProject(rows[0]) : null;
}

export async function linkAgentProject(input: {
  repoFullName: string; defaultBranch?: string; connectionName?: string | null;
  orgProjectId?: string | null; addedBy?: string | null;
}): Promise<AgentProject> {
  const rows = await exec(
    `INSERT INTO agent_projects (repo_full_name, default_branch, connection_name, org_project_id, added_by)
     VALUES (:repo, :branch, :conn, :org, :by)
     ON CONFLICT (repo_full_name) DO UPDATE
       SET connection_name = EXCLUDED.connection_name,
           default_branch  = EXCLUDED.default_branch,
           org_project_id  = EXCLUDED.org_project_id,
           updated_at      = NOW()
     RETURNING *`,
    [
      s('repo', input.repoFullName),
      s('branch', input.defaultBranch || 'main'),
      maybe('conn', input.connectionName ?? null),
      maybe('org', input.orgProjectId ?? null),
      maybe('by', input.addedBy ?? null),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('agent_projects insert returned no row');
  return rowToProject(row);
}

export async function unlinkAgentProject(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await exec(`DELETE FROM agent_projects WHERE id = :id::uuid RETURNING id`, [s('id', id)]);
  return rows.length > 0;
}

/** Where a project's checkout lives inside its workspace. */
export function checkoutPath(project: AgentProject): string {
  const dir = project.repoFullName.split('/')[1] ?? 'repo';
  return `${project.workspacePath.replace(/\/$/, '')}/${dir}`;
}

/**
 * The shell command that puts this repository in the workspace.
 *
 * Public repositories are cloned with no credential at all — a project that
 * needs no secret should not be made to carry one.
 *
 * Private ones need a token, and this is the weak point worth naming: the
 * command API takes a shell string, so the token is briefly present in one.
 * It is stripped from the remote immediately so it is not persisted in
 * .git/config, and the caller logs `redacted` rather than `command`. The right
 * fix is for the devbox to fetch its own credential with its own workload
 * identity — it has one — so the token never leaves AWS. That needs an image
 * rebuild, which wipes every workspace, so it is not this change.
 */
export async function buildCloneCommand(project: AgentProject): Promise<{ command: string; redacted: string }> {
  const target = checkoutPath(project);
  const url = `https://github.com/${project.repoFullName}.git`;
  const redacted = `git clone --depth 50 ${url} ${target}`;

  // `2>&1 | tail -20` bounds the output, but is appended so the pipe binds only
  // to the final `git log` (| is tighter than &&) — a clone that fails stops the
  // && chain and exits nonzero rather than being swallowed by tail's exit 0. The
  // public branch below must follow the same shape; piping `git clone` directly
  // would mask its failure and report a broken checkout as a clean one.
  const tail = ' 2>&1 | tail -20';

  // `-c safe.directory=*` on the verification log: the checkout is owned by a
  // different uid than the shell, and without it `git log` prints a scary
  // "fatal: detected dubious ownership" — harmless (the clone already
  // succeeded) but it looks like a failure in the streamed output.
  const verify = `git -c safe.directory='*' -C ${target} log --oneline -1`;

  if (!project.connectionName) {
    const command = [
      `rm -rf ${target}`,
      `git clone --depth 50 ${url} ${target}`,
      verify,
    ].join(' && ') + tail;
    return { command, redacted };
  }

  const token = await borrowApiKey(project.connectionName);
  const authed = `https://x-access-token:${token}@github.com/${project.repoFullName}.git`;
  const command = [
    `rm -rf ${target}`,
    `git clone --depth 50 ${authed} ${target}`,
    `git -c safe.directory='*' -C ${target} remote set-url origin ${url}`,
    verify,
  ].join(' && ') + tail;
  return { command, redacted };
}

export async function markCloned(id: string, sessionId: string): Promise<void> {
  await exec(
    `UPDATE agent_projects SET session_id = :sid, cloned_at = NOW(), updated_at = NOW() WHERE id = :id::uuid`,
    [s('sid', sessionId), s('id', id)],
  );
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function startRun(input: {
  projectId: string; prompt: string; model?: string | null; sessionId?: string | null;
}): Promise<ProjectRun> {
  const id = randomUUID();
  const rows = await exec(
    `INSERT INTO agent_project_runs (id, project_id, prompt, model, session_id)
     VALUES (:id::uuid, :pid::uuid, :prompt, :model, :sid)
     RETURNING *`,
    [
      s('id', id), s('pid', input.projectId), s('prompt', input.prompt),
      maybe('model', input.model ?? null), maybe('sid', input.sessionId ?? null),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('agent_project_runs insert returned no row');
  return rowToRun(row);
}

export async function finishRun(id: string, outcome: {
  status: 'done' | 'failed'; filesChanged?: number | null; diffSummary?: string | null; error?: string | null;
  costUsd?: number | null;
}): Promise<void> {
  await exec(
    `UPDATE agent_project_runs
        SET status = :status,
            finished_at = NOW(),
            duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
            files_changed = :files,
            diff_summary = :diff,
            error = :err,
            cost_usd = :cost
      WHERE id = :id::uuid`,
    [
      s('status', outcome.status), s('id', id),
      outcome.filesChanged == null ? nul('files') : { name: 'files', value: { longValue: outcome.filesChanged } },
      maybe('diff', outcome.diffSummary ?? null),
      maybe('err', outcome.error ?? null),
      // The column existed from day one; it was simply never written. Every
      // row that lands here feeds the bot/marketplace cost estimator.
      outcome.costUsd == null ? nul('cost') : { name: 'cost', value: { doubleValue: outcome.costUsd } },
    ],
  );
}

export async function listRuns(projectId: string, limit = 25): Promise<ProjectRun[]> {
  if (!isUuid(projectId)) return [];
  const rows = await exec(
    `SELECT id, project_id, prompt, model, status, started_at, finished_at,
            duration_ms, files_changed, diff_summary, error, cost_usd
       FROM agent_project_runs WHERE project_id = :pid::uuid
      ORDER BY started_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
    [s('pid', projectId)],
  );
  return rows.map(rowToRun);
}

/**
 * The latest `perProject` runs for each of several projects, in ONE round-trip.
 *
 * The list surface (GET /api/agent-projects) is polled and shows recent
 * activity per repo. Fetching runs a project at a time cost one RDS Data API
 * call per linked repository — N round-trips growing linearly with the fleet.
 * A window function partitions by project so a single statement returns the
 * top-N runs per project, grouped in memory here. Selects only the columns
 * `rowToRun` reads — the same IN-list bind style as the owners fan-out above —
 * rather than every column of a table whose prompt/diff payloads are large and
 * never rendered in full on the list.
 */
export async function listRecentRunsForProjects(
  ids: string[], perProject = 5,
): Promise<Map<string, ProjectRun[]>> {
  const grouped = new Map<string, ProjectRun[]>();
  if (config.mock.aurora) return grouped;
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return grouped;
  const n = Math.min(Math.max(perProject, 1), 100);
  const rows = await exec(
    `SELECT id, project_id, prompt, model, status, started_at, finished_at,
            duration_ms, files_changed, diff_summary, error, cost_usd
       FROM (
         SELECT id, project_id, prompt, model, status, started_at, finished_at,
                duration_ms, files_changed, diff_summary, error, cost_usd,
                ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY started_at DESC) AS rn
           FROM agent_project_runs
          WHERE project_id IN (${valid.map((_, i) => `:p${i}::uuid`).join(', ')})
       ) t
      WHERE t.rn <= ${n}
      ORDER BY t.project_id, t.started_at DESC`,
    valid.map((v, i) => s(`p${i}`, v)),
  );
  for (const r of rows) {
    const run = rowToRun(r);
    const list = grouped.get(run.projectId);
    if (list) list.push(run);
    else grouped.set(run.projectId, [run]);
  }
  return grouped;
}
