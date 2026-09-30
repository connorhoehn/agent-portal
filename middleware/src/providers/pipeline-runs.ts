// The run projection's two row sources (docs/pipelines-tenant-goal.md
// §"The projection"). lib/pipeline-runs.ts is pure; this is the I/O half.
//
// MOCK (`config.mock.aurora`): the registered fixtures themselves —
// `agentJobs`, the bot_runs rows (`allMockRuns()`: seeded + session),
// `agentProjectRuns`, the assessment `runsFixture` and the compaction history
// (read through `listCompactions`, whose mock branch reads the
// `compactionJobs` fixture and derives each pass's phase and output from the
// rows it produced). A scenario switch or `POST /api/__mock/reset` moves the
// projection with them, because nothing here keeps a copy.
//
// AURORA: the same tables through the providers that already own them. A
// source that cannot be read is named in `unavailable` rather than read as
// "no runs" — an empty ledger and an unreadable one are opposite facts.

import { config } from '../config.js';
import {
  projectRuns, type Projection, type RunSources, type BotRunSource, type SourceTable,
} from '../lib/pipeline-runs.js';

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
  const { listCompactions } = await import('./distillation.js');
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
      compactions: await attempt('distillation_compactions', unavailable, () => listCompactions()),
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
    compactions: await attempt('distillation_compactions', unavailable, () => listCompactions()),
    changes: await attempt('agent_change_requests', unavailable, () => listChangeRequests()),
  };
  return { sources, unavailable };
}

/** Read the five sources and project them — once per request. */
export async function loadProjection(): Promise<LoadedProjection> {
  const { sources, unavailable } = await loadRunSources();
  return { ...projectRuns(sources), unavailable };
}
