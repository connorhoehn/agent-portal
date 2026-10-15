// The run projection's two row sources (docs/pipelines-tenant-goal.md
// §"The projection"). lib/pipeline-runs.ts is pure; this is the I/O half.
//
// MOCK (`config.mock.aurora`): the registered fixtures themselves —
// `agentJobs`, the bot_runs rows (`allMockRuns()`: seeded + session),
// `agentProjectRuns` and the assessment `runsFixture`. A scenario switch or `POST /api/__mock/reset` moves the
// projection with them, because nothing here keeps a copy.
//
// AURORA: the same tables through the providers that already own them. A
// source that cannot be read is named in `unavailable` rather than read as
// "no runs" — an empty ledger and an unreadable one are opposite facts.

import { config } from '../config.js';
import {
  normalizeAgentSteps, projectRuns,
  type Projection, type Run, type RunSources, type BotRunSource, type InvocationSource, type SourceTable,
} from '../lib/pipeline-runs.js';
import { presentRunTitles, type RunNames } from '../lib/pipeline-run-titles.js';
import { liveAgentRuns } from '../lib/agent-runs-live.js';
import { userNameFor } from '../lib/user-names.js';

/** How far back the agent-run source reads — the observability surfaces' own week. */
const INVOCATION_WINDOW_HOURS = 24 * 7;
const INVOCATION_LIMIT = 1000;

/** `invocation_traces` → InvocationSource, from either row source (snake_case, `exec()` shape). */
export function invocationSourceFromRow(r: Record<string, unknown>): InvocationSource {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const ts = str(r['ts_iso']) ?? str(r['tsIso']) ?? str(r['ts']) ?? '';
  return {
    invocationId: String(r['invocation_id']),
    agentId: String(r['agent_id'] ?? 'unknown'),
    agentName: String(r['agent_name'] ?? r['agent_id'] ?? 'unknown'),
    aguiRunId: str(r['agui_run_id']),
    threadId: str(r['agui_thread_id']),
    steps: normalizeAgentSteps(r['steps']),
    parentInvocationId: str(r['parent_invocation_id']),
    userId: str(r['user_id']),
    tenant: str(r['tenant']),
    // RDS Data API hands TIMESTAMPTZ back naive (CLAUDE.md, the devbox fleet
    // gotcha); the SELECT below formats it as UTC ISO so it is never read local.
    ts,
    durationMs: num(r['duration_ms']),
    guardrailAction: str(r['guardrail_action']),
    schemaValid: typeof r['schema_valid'] === 'boolean' ? r['schema_valid'] : null,
    totalCostUsd: num(r['total_cost_usd']),
    promptSnippet: str(r['prompt_snippet']),
  };
}

export interface LoadedProjection extends Projection {
  /** Sources that could not be read, with the reason — never silently empty. */
  unavailable: Array<{ table: SourceTable | 'agent_change_requests'; error: string }>;
}

async function attempt<T>(
  table: SourceTable | 'agent_change_requests',
  unavailable: LoadedProjection['unavailable'],
  read: () => Promise<T[]> | T[],
): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    unavailable.push({ table, error: (err as Error).message });
    return [];
  }
}

export async function loadRunSources(): Promise<{ sources: RunSources; unavailable: LoadedProjection['unavailable'] }> {
  const unavailable: LoadedProjection['unavailable'] = [];
  const { listChangeRequests } = await import('./sdlc.js');

  if (config.mock.aurora) {
    const [{ agentJobs }, { allMockRuns }, { agentProjectRuns }, { runsFixture }] = await Promise.all([
      import('../mock/agent-jobs.js'), import('../mock/bots.js'),
      import('../mock/agent-project-runs.js'), import('../mock/assessment.js'),
    ]);
    const sources: RunSources = {
      agentJobs: await attempt('agent_jobs', unavailable, () => agentJobs.rows()),
      botRuns: await attempt('bot_runs', unavailable, () => allMockRuns()),
      agentProjectRuns: await attempt('agent_project_runs', unavailable, () => agentProjectRuns.rows()),
      assessmentRuns: await attempt('assessment_runs', unavailable, () => runsFixture.rows()),
      invocations: await attempt('invocation_traces', unavailable, async () => {
        // The one offline invocation_traces: the seeded day with every written
        // bundle layered on top (mock/observability.ts traceRows()).
        const { traceRows } = await import('../mock/observability.js');
        return traceRows().map((r) => invocationSourceFromRow({ ...r, ts_iso: r.tsIso }));
      }),
      liveAgentRuns: liveAgentRuns(),
      changes: await attempt('agent_change_requests', unavailable, () => listChangeRequests()),
    };
    return { sources, unavailable };
  }

  const [{ listJobs }, bots, projects, assessment] = await Promise.all([
    import('./agent-jobs.js'), import('./bots.js'), import('./agent-projects.js'), import('./assessment.js'),
  ]);
  const sources: RunSources = {
    agentJobs: await attempt('agent_jobs', unavailable, () => listJobs({ limit: 500 })),
    botRuns: await attempt('bot_runs', unavailable, async () => {
      const roster = await bots.listBots();
      const perBot = await bots.listBotRunsForBotsResult(roster.map((b) => b.id), 200);
      if (perBot.degraded) throw new Error(perBot.error ?? 'bot_runs unreadable');
      // Marketplace firings carry no bot, so the per-bot read cannot see them;
      // the in-flight ones are the ones a reader needs.
      const active = await bots.listActiveRuns(100);
      const byId = new Map<string, BotRunSource>();
      for (const r of [...perBot.items, ...active]) byId.set(r.id, r);
      return [...byId.values()];
    }),
    agentProjectRuns: await attempt('agent_project_runs', unavailable, async () => {
      const linked = await projects.listAgentProjects();
      const grouped = await projects.listRecentRunsForProjects(linked.map((p) => p.id), 100);
      return [...grouped.values()].flat();
    }),
    assessmentRuns: await attempt('assessment_runs', unavailable, () => assessment.listRuns({ limit: 500 })),
    invocations: await attempt('invocation_traces', unavailable, async () => {
      const { exec } = await import('./aurora.js');
      // A cluster that has not re-applied observability_schema.sql has no
      // agui_run_id column: that is `unavailable` with the database's own
      // words, never "no agent runs".
      const rows = await exec(
        `SELECT invocation_id::text AS invocation_id, agent_id, agent_name,
                agui_run_id, agui_thread_id, steps::text AS steps, tenant,
                parent_invocation_id::text AS parent_invocation_id, user_id,
                to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts_iso,
                duration_ms, guardrail_action, schema_valid,
                total_cost_usd::float8 AS total_cost_usd, prompt_snippet
           FROM observability.invocation_traces
          WHERE ts > now() - make_interval(hours => :hours)
          ORDER BY ts DESC
          LIMIT :lim`,
        [
          { name: 'hours', value: { longValue: INVOCATION_WINDOW_HOURS } },
          { name: 'lim', value: { longValue: INVOCATION_LIMIT } },
        ],
      );
      return rows.map((r) => invocationSourceFromRow(r as Record<string, unknown>));
    }),
    liveAgentRuns: liveAgentRuns(),
    changes: await attempt('agent_change_requests', unavailable, () => listChangeRequests()),
  };
  return { sources, unavailable };
}

/** Read the six sources (plus the relayed runs) and project them — once per request. */
export async function loadProjection(): Promise<LoadedProjection> {
  const { sources, unavailable } = await loadRunSources();
  const projection = projectRuns(sources);
  // Name the person behind each account id (a clone prints its persona) so a run record never reads "Triggered by u-mia".
  for (const run of projection.runs) {
    const name = userNameFor(run.triggeredBy);
    if (name) run.triggeredByName = name;
  }
  // Titles in words: the team, work item, bot and initiative behind each id (lib/pipeline-run-titles.ts).
  const names = await loadRunNames(projection.runs);
  presentRunTitles(projection.runs, names);
  // The definition's owner, beside who started the run: the author's recorded name, else the bot's creator.
  for (const run of projection.runs) {
    const owner = names.owner(run.definitionId);
    if (owner) run.ownerName = owner;
  }
  return { ...projection, unavailable };
}

/** The names the projection's ids stand for, read once per projection; a reader that fails names nothing. */
async function loadRunNames(runs: readonly Run[]): Promise<RunNames> {
  const quiet = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => { try { return await read(); } catch { return fallback; } };
  const [teams, bots, linked, stored] = await Promise.all([
    quiet(async () => (await import('./assessment.js')).listTeams(), []),
    quiet(async () => (await import('./bots.js')).listBots(), []),
    quiet(async () => (await import('./agent-projects.js')).listAgentProjects(), []),
    quiet(async () => (await import('./pipeline-definitions.js')).listStoredDefinitions(), []),
  ]);
  const workItemIds = [...new Set(runs.map((r) => r.context.workItemId).filter((id): id is string => !!id))].slice(0, 60);
  const items = await Promise.all(workItemIds.map((id) => quiet(async () => (await import('./work-items.js')).getWorkItem(id), null)));
  const teamNames = new Map(teams.map((t) => [t.id, t.name]));
  const botRows = new Map(bots.map((b) => [b.id, { name: b.name, initiative: b.orgProjectName ?? null }]));
  const owners = new Map<string, string>();
  for (const b of bots) { const n = userNameFor(b.createdBy); if (n) owners.set(`bot:${b.id}`, n); }
  for (const d of stored) { const n = userNameFor(d.owner); if (n) owners.set(d.id, n); }
  // The offline link rows carry no initiative name (mock/agent-projects.ts); the initiative fixture has it.
  const findInitiative = config.mock.aurora ? (await import('../mock/initiatives.js')).findInitiative : null;
  const projectNames = new Map(linked.map((p) => [p.id, p.orgProjectName ?? (p.orgProjectId && findInitiative ? findInitiative(p.orgProjectId)?.name ?? null : null)]));
  const workItems = new Map(items.flatMap((w) => (w ? [[w.id, { title: w.title, initiative: w.projectName || null }] as const] : [])));
  return {
    team: (id) => teamNames.get(id) ?? null,
    workItem: (id) => workItems.get(id) ?? null,
    bot: (id) => botRows.get(id) ?? null,
    project: (id) => projectNames.get(id) ?? null,
    owner: (definitionId) => owners.get(definitionId) ?? null,
  };
}
