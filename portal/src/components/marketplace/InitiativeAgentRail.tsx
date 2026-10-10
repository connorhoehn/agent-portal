// InitiativeAgentRail — the hook that feeds the initiative's Agents tab
// (pages/project-detail/InitiativeRail.tsx) and the header's spend stat. The
// rail cards that used to live here became that tab's one list on 2026-10-07.
//
// The operating model: one owner runs the initiative, SMEs direct agents. So
// the page's right rail answers, at a glance: which bots are pointed here,
// what is running right now, and what the recent agent activity produced and
// cost. The bots themselves are managed on the Bots page — these cards observe.

import { useMemo } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp';
import type { Bot, BotRun } from '../../pages/bots/BotsPage';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Aurora stamps carry a `+00` offset ISO 8601 does not allow — shared parser. */
function parseTs(iso: string): number {
  return parsePgTimestampAsUtc(iso)?.getTime() ?? Number.NaN;
}

// ─── The activity hook ───────────────────────────────────────────────────────
// One place that knows which bots target this initiative (direct orgProjectId
// match, or via a codebase that delivers it), lazily pulls their runs, and
// merges them with the bot-less marketplace runs the page already polls.
// The header's "agent spend" stat and the Agents tab read from this.

export interface InitiativeAgentActivity {
  bots: Bot[];
  botsLoading: boolean;
  /**
   * Why the roster is missing: a transport failure, a 403, OR the route's own
   * `degraded` marker (it answers `{ bots: [], degraded, error }` when the
   * Aurora read fails). All three mean "unknown", never "none".
   */
  botsError: string | null;
  /** Marketplace runs + targeting bots' runs, deduped, newest first. */
  runs: BotRun[];
  /**
   * Set when at least one bot's run history could not be read, so `runs` is a
   * floor and `spendUsd` is an UNDERCOUNT rather than a total. Money is the
   * one number on this rail where a silent floor is worse than no number.
   */
  runsError: string | null;
  /** Sum of costUsd over `runs` — the initiative's listed agent spend. */
  spendUsd: number;
}

export function useInitiativeAgentActivity(
  orgProjectId: string | undefined,
  codebases: Array<{ id: string; repoFullName: string }>,
  marketplaceRuns: BotRun[],
): InitiativeAgentActivity {
  // GET /api/bots is readForRolesElseAction(['org-leader','hr-admin',
  // 'program-owner'], 'ManageBots'). All three of those roles hold ManageBots in
  // the seed matrix, so the capability covers the role short-circuit too and
  // this cannot hide the rail from someone the server would have served.
  //
  // Gated rather than left to 403: an unconditional fetch logged a console error
  // on every page load for every role without the capability. The rail already
  // renders nothing in that case — this just stops it being noisy about it.
  const { can, ready } = useCapabilities();
  const mayReadBots = ready && can('ManageBots');
  const { data: botsData, isLoading, error, degraded } = useFetch<{ bots: Bot[] }>(
    mayReadBots ? '/api/bots' : null,
    30_000,
  );
  // A degraded roster is exactly as blinding as a 403 or a dead socket, and
  // the card below already knows how to say "unknown, not empty".
  const botsError = ready && !mayReadBots
    ? '403: bot roster not visible to this role'
    : error ?? degraded;

  const codebaseIds = new Set(codebases.map((c) => c.id));
  const bots = orgProjectId
    ? (botsData?.bots ?? []).filter(
        (b) => b.orgProjectId === orgProjectId || (b.agentProjectId != null && codebaseIds.has(b.agentProjectId)),
      )
    : [];

  // One bulk read for every targeting bot's runs, instead of one `/:id/runs`
  // request per bot (the N+1 this hook used to do). `GET /api/bots/runs`
  // returns the merged, per-bot-capped list directly.
  const botIdsKey = bots.map((b) => b.id).sort().join(',');
  const { data: bulkRunsData, error: bulkRunsFetchError, degraded: bulkRunsDegraded } = useFetch<{ runs: BotRun[] }>(
    botIdsKey ? `/api/bots/runs?botIds=${encodeURIComponent(botIdsKey)}` : null,
  );
  const runsError = bulkRunsFetchError ?? bulkRunsDegraded;
  const botRuns = bulkRunsData?.runs ?? [];

  const runs = useMemo(() => {
    const seen = new Set<string>();
    const merged: BotRun[] = [];
    for (const r of [...marketplaceRuns, ...botRuns]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    merged.sort((a, b) => parseTs(b.startedAt) - parseTs(a.startedAt));
    return merged;
  }, [marketplaceRuns, botRuns]);
  const spendUsd = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return { bots, botsLoading: !ready || isLoading, botsError, runs, runsError, spendUsd };
}
