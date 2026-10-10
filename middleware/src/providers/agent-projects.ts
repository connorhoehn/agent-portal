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
import {
  mockFinishRun, mockRecentRunsForProjects, mockRunsForProject, mockStartRun,
} from '../mock/agent-project-runs.js';
import {
  mockGetAgentProject, mockLinkAgentProject, mockListAgentProjects, mockMarkCloned,
  mockUnlinkAgentProject,
} from '../mock/agent-projects.js';
import { config } from '../config.js';
import { hasColumns } from './column-probe.js';
// One vocabulary for "who served this inference", shared with providers/bots.ts.
import type { ModelProvider } from '../lib/run-cost.js';
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

// The 14 seeded repositories now live behind a fixture in
// mock/agent-projects.ts rather than as a const array here. They were moved
// because the write paths below need somewhere to put a row: mutating a bare
// module-level array is the "auditor damages shared state" problem the
// scenario control plane exists to end, and the hand-typed `createdAt`
// literals they carried were frozen at edit time (the seed does not even set
// the column — it defaults to NOW()). Behind the fixture,
// `POST /api/__mock/reset` puts the seeded fleet back.
//
// The rows still mirror `schema/seed_program.sql`'s `agent_projects` exactly
// (id, repo_full_name, org_project_id) — one linked codebase per seeded
// initiative. Before that mirror existed `listAgentProjects()` returned `[]`
// unconditionally in mock mode, so the dispatch preflight (bot-runner.ts
// `preflightWorkItem`, which filters `listAgentProjects()` by
// `orgProjectId === item.projectId`) 400'd EVERY initiative with "no codebase
// delivers this initiative" even though the initiative header (providers/
// projects.ts MOCK_INITIATIVES[].repo) shows the very same repo the seed links
// (org-leader.md defect #3 / sme #3 / program-owner #13).

export async function listAgentProjects(): Promise<AgentProject[]> {
  if (config.mock.aurora) return mockListAgentProjects();
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
  if (config.mock.aurora) return mockGetAgentProject(id);
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
  // A raw exec() reaches the RDS Data API whatever config.mock.aurora says, so
  // without this branch `POST /api/agent-projects` 500'd offline and a repo
  // could not be linked at all in dev:mock — invisible to the judge, because
  // rule 4's evidence is a GET-only wire capture.
  if (config.mock.aurora) {
    return mockLinkAgentProject({
      repoFullName: input.repoFullName,
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
      connectionName: input.connectionName ?? null,
      orgProjectId: input.orgProjectId ?? null,
    });
  }
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
  // Before the uuid guard on purpose: the mock branch answers about the rows
  // it actually holds, and a caller passing a non-uuid gets the same honest
  // `false` either way.
  if (config.mock.aurora) return mockUnlinkAgentProject(id);
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

  // Offline there is no vault (`borrowApiKey` throws under MOCK_AGENTCORE, on
  // purpose) and no github.com: the command only ever reaches the fake microVM
  // in mock/devbox-shell.ts, which answers any `git clone`. So the mock builds
  // the same credentialed shape with the token left out, rather than refusing
  // — every seeded repository is private and carries a connection, and a
  // refusal here would 503 every offline dispatch at ensureWorkspace. Same
  // placement as lib/change-delivery.ts's mock branch: below everything that
  // reads the project, above the first thing that reaches outside.
  const token = config.mock.agentcore ? null : await borrowApiKey(project.connectionName);
  const authed = token
    ? `https://x-access-token:${token}@github.com/${project.repoFullName}.git`
    : url;
  const command = [
    `rm -rf ${target}`,
    `git clone --depth 50 ${authed} ${target}`,
    `git -c safe.directory='*' -C ${target} remote set-url origin ${url}`,
    verify,
  ].join(' && ') + tail;
  return { command, redacted };
}

export async function markCloned(id: string, sessionId: string): Promise<void> {
  // A raw exec() reaches the RDS Data API whatever config.mock.aurora says —
  // there is no mock branch inside `exec`. Without this guard the last step of
  // the clone/session flow was the one statement in that flow that still
  // demanded a live cluster, so an offline workspace could be established and
  // then 500 while recording that it had been. (The same shape of bug
  // bot-runner.ts's work-item claim already fixed by routing through
  // updateWorkItem instead of exec.)
  //
  // The stamp comes from mock/core/clock.ts, not `new Date()`. It was
  // `new Date().toISOString()` here for exactly as long as rule 3 could not see
  // it: the rule scanned `src/mock/**` only, so a provider minting its own
  // timestamp inside its own mock branch was invisible. The rule now reads
  // provider mock branches too.
  if (config.mock.aurora) { mockMarkCloned(id, sessionId); return; }
  await exec(
    `UPDATE agent_projects SET session_id = :sid, cloned_at = NOW(), updated_at = NOW() WHERE id = :id::uuid`,
    [s('sid', sessionId), s('id', id)],
  );
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function startRun(input: {
  projectId: string; prompt: string; model?: string | null; sessionId?: string | null;
  /**
   * The work item this run is answering, when a marketplace dispatch started
   * it. First-class rather than the `UPDATE ... SET work_item_id` that used to
   * follow the insert: that write was raw SQL guarded by `!config.mock.aurora`,
   * so offline the binding simply did not happen and every captured change
   * came back detached from the issue that asked for it.
   */
  workItemId?: string | null;
}): Promise<ProjectRun> {
  // The run rows render offline (mockRunsForProject) but could not be *made*
  // offline, so the portal's run button 500'd here on a laptop. The mock row
  // starts `running` with a clock stamp and no duration — the same state the
  // table's defaults produce — and `finishRun` below closes it.
  if (config.mock.aurora) {
    return mockStartRun({
      projectId: input.projectId, prompt: input.prompt, model: input.model ?? null,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    });
  }
  const id = randomUUID();
  const rows = await exec(
    `INSERT INTO agent_project_runs (id, project_id, prompt, model, session_id, work_item_id)
     VALUES (:id::uuid, :pid::uuid, :prompt, :model, :sid, :wid)
     RETURNING *`,
    [
      s('id', id), s('pid', input.projectId), s('prompt', input.prompt),
      maybe('model', input.model ?? null), maybe('sid', input.sessionId ?? null),
      maybe('wid', input.workItemId ?? null),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('agent_project_runs insert returned no row');
  return rowToRun(row);
}

export async function finishRun(id: string, outcome: {
  status: 'done' | 'failed'; filesChanged?: number | null; diffSummary?: string | null; error?: string | null;
  costUsd?: number | null;
  /**
   * What served the inference. See lib/run-cost.ts: `cost_usd` on its own cannot
   * distinguish "cost nothing because it ran on hardware we own" from "cost
   * unknown because nothing reported a figure", and this run feeds the cost
   * ESTIMATOR (`runPercentiles`) — so an unmarked free run would drag every
   * future forecast toward zero.
   *
   * Omitted leaves the column alone. Dropped silently on a cluster without
   * schema/local_compute_worker_schema.sql, the same way `dispatchedBy` is on a
   * cluster without the attribution migration: a run that cannot record its
   * provenance is still a run worth recording.
   */
  modelProvider?: ModelProvider | null;
}): Promise<void> {
  // `duration_ms` is not written here in mock mode and is not stored in the
  // fixture: the row carries `started_at` and `finished_at`, and the duration
  // falls out of the two the way this statement computes it. A stored copy
  // beside its own stamps is the typed aggregate rule 1 forbids.
  if (config.mock.aurora) {
    mockFinishRun(id, {
      status: outcome.status,
      filesChanged: outcome.filesChanged ?? null,
      diffSummary: outcome.diffSummary ?? null,
      error: outcome.error ?? null,
      costUsd: outcome.costUsd ?? null,
    });
    return;
  }
  // The provider column joins the statement only when there is one to write and
  // the cluster has it — every other finish keeps the previous statement
  // byte-for-byte. providers/column-probe.ts explains why that rule is absolute
  // here: this runs on the governed-run path that worked before local compute.
  const provider = outcome.modelProvider != null
    && await hasColumns('agent_project_runs', ['model_provider'])
    ? outcome.modelProvider
    : null;
  await exec(
    `UPDATE agent_project_runs
        SET status = :status,
            finished_at = NOW(),
            duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
            files_changed = :files,
            diff_summary = :diff,
            error = :err,
            ${provider ? 'model_provider = :provider,' : ''}
            cost_usd = :cost
      WHERE id = :id::uuid`,
    [
      s('status', outcome.status), s('id', id),
      ...(provider ? [s('provider', provider)] : []),
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
  // Third time this shape has bitten today (the work-item claim, markCloned,
  // this): `exec` reaches the RDS Data API whatever config.mock.aurora says,
  // so a raw call here 500'd the focused run list in dev:mock while the list
  // page beside it rendered fine from its own (empty) mock branch.
  if (config.mock.aurora) return mockRunsForProject(projectId, limit);
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
  // This branch used to return the empty map unconditionally, so every linked
  // repo on /admin/codebases read "Nothing has been run against this yet" —
  // indistinguishable from a fleet that has genuinely never been dispatched.
  // Same rows as listRuns above, so the list and the detail agree.
  if (config.mock.aurora) return mockRecentRunsForProjects(ids, perProject);
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
