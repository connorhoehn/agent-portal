// InitiativeAgentRail — the mission-control rail's agent cards, plus the hook
// that feeds them (and the header's spend stat).
//
// The operating model: one owner runs the initiative, SMEs direct agents. So
// the page's right rail answers, at a glance: which bots are pointed here,
// what is running right now, and what the recent agent activity produced and
// cost. The bots themselves are managed on the Bots page — these cards observe.

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import { readDegraded } from '../../lib/degraded';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { CostVsEstimate, runEstimate } from './EstimateDrawer';
import {
  TEMPLATE_TONE,
  triggerSummary,
  when,
  type Bot,
  type BotRun,
} from '../../pages/bots/BotsPage';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RUN_STATUS_TONE: Record<BotRun['status'], 'warning' | 'success' | 'danger' | 'neutral'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

/** Aurora timestamps arrive without T/Z — same normalization as BotsPage.when. */
function parseTs(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
}

const OUTCOMES_LIMIT = 10;

// ─── The activity hook ───────────────────────────────────────────────────────
// One place that knows which bots target this initiative (direct orgProjectId
// match, or via a codebase that delivers it), lazily pulls their runs, and
// merges them with the bot-less marketplace runs the page already polls.
// The header's "agent spend" stat and both rail cards read from this.

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
  const botsError = error ?? degraded;

  const codebaseIds = new Set(codebases.map((c) => c.id));
  const bots = orgProjectId
    ? (botsData?.bots ?? []).filter(
        (b) => b.orgProjectId === orgProjectId || (b.agentProjectId != null && codebaseIds.has(b.agentProjectId)),
      )
    : [];

  // Lazily fetch each targeting bot's runs, once per bot.
  const [botRuns, setBotRuns] = useState<Record<string, BotRun[]>>({});
  const [runsError, setRunsError] = useState<string | null>(null);
  const botIdsKey = bots.map((b) => b.id).sort().join(',');
  useEffect(() => {
    if (!botIdsKey) return;
    let cancelled = false;
    for (const botId of botIdsKey.split(',')) {
      if (botRuns[botId]) continue;
      fetch(`/api/bots/${encodeURIComponent(botId)}/runs`, { credentials: 'include' })
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          return (await res.json()) as { runs?: BotRun[] };
        })
        .then((body) => {
          if (cancelled) return;
          // 200 with `{ runs: [] }` and a marker is not "this bot never ran".
          const d = readDegraded(body);
          if (d) setRunsError(d);
          setBotRuns((prev) => (prev[botId] ? prev : { ...prev, [botId]: body.runs ?? [] }));
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setRunsError(e instanceof Error ? e.message : 'a run history could not be read');
          setBotRuns((prev) => (prev[botId] ? prev : { ...prev, [botId]: [] }));
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botIdsKey]);

  const seen = new Set<string>();
  const runs: BotRun[] = [];
  for (const r of [...marketplaceRuns, ...bots.flatMap((b) => botRuns[b.id] ?? [])]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    runs.push(r);
  }
  runs.sort((a, b) => parseTs(b.startedAt) - parseTs(a.startedAt));
  const spendUsd = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return { bots, botsLoading: isLoading, botsError, runs, runsError, spendUsd };
}

// ─── AGENTS rail card ────────────────────────────────────────────────────────
// The bots pointed at this initiative, and what's running right now.

export function AgentsRailCard({ activity }: { activity: InitiativeAgentActivity }) {
  const { bots, botsLoading, botsError, runs } = activity;
  const runningNow = runs.filter((r) => r.status === 'running');
  // /admin/bots and /admin/bots/:id are hr-admin routes, and their API carries
  // ManageDevbox. Offering the links to anyone else points at a page that is
  // absent from their nav and that redirects them home — the link claims an
  // affordance the viewer does not have. Bot reads reach org-leader too, so a
  // bot can be listed here by someone who still cannot open its page; that one
  // renders as plain text rather than a link into a redirect.
  const { can, ready } = useCapabilities();
  const canManageBots = ready && can('ManageDevbox');

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">AGENTS</span>
        <div className="flex-1" />
        {canManageBots && (
          <Link to="/admin/bots" className="text-[11px] font-semibold text-primary no-underline hover:underline">
            + New bot
          </Link>
        )}
      </div>

      {botsError ? (
        /403|401|forbidden/i.test(botsError) ? (
          // Not a failure — a denial. /api/bots is org-leader/hr-admin (or
          // ManageDevbox) territory, and "Failed to load bots" read as a
          // broken page to every SME and member who opened an initiative.
          <div className="px-3 py-2.5 text-[11px] text-text-tertiary leading-relaxed">
            The bot roster is not visible to this role, so this list is unknown, not empty —
            standing missions may well be pointed at this initiative.
          </div>
        ) : (
          <div className="px-3 py-2.5 text-[11px] text-danger leading-relaxed">
            Could not load the bot roster ({botsError}) — this list is unknown, not empty.
          </div>
        )
      ) : bots.length === 0 ? (
        <div className="px-3 py-3 text-[11.5px] text-text-tertiary leading-relaxed">
          {botsLoading
            ? 'Loading bots…'
            : 'No bots target this initiative yet — point a standing mission here from the Bots page.'}
        </div>
      ) : (
        bots.map((bot) => {
          // Paused is either half: operator-disabled OR self-paused (budget).
          const paused = !bot.enabled || bot.pausedReason != null;
          return (
            <div key={bot.id} className="px-3 py-2 border-b border-border last:border-b-0">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {canManageBots ? (
                  <Link
                    to={`/admin/bots/${bot.id}`}
                    className="text-[12px] font-semibold text-text-primary no-underline truncate hover:text-primary hover:underline"
                  >
                    {bot.name}
                  </Link>
                ) : (
                  <span className="text-[12px] font-semibold text-text-primary truncate" title={bot.name}>
                    {bot.name}
                  </span>
                )}
                <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>
                <div className="flex-1" />
                {paused ? (
                  <Chip tone="warning" size="xs" dot="static" title={bot.pausedReason ?? undefined}>paused</Chip>
                ) : (
                  <Chip tone="success" size="xs" dot="static">on</Chip>
                )}
              </div>
              <div className="mt-0.5 text-[10.5px] text-text-tertiary">
                {triggerSummary(bot)} · today ${bot.todaySpendUsd.toFixed(2)}
              </div>
            </div>
          );
        })
      )}

      {/* What's on the clock right now — one pulsing row per active run */}
      {runningNow.length > 0 && (
        <div className="border-t border-border bg-surface-inset">
          {runningNow.map((r) => (
            <div key={r.id} className="px-3 py-1.5 flex items-center gap-2 flex-wrap text-[11px]">
              <Chip tone="info" size="xs" dot="pulse">running now</Chip>
              <span className="text-text-tertiary">{r.trigger}</span>
              <div className="flex-1" />
              {/* Computers is another hr-admin route — same reasoning as the
                  bot links above. */}
              {canManageBots && r.outcome?.boxId && (
                <Link
                  to={`/admin/devbox?box=${encodeURIComponent(r.outcome.boxId)}`}
                  className="text-primary no-underline hover:underline font-mono text-[10.5px]"
                  title="Open the live run in Computers"
                >
                  watch →
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── OUTCOMES rail card ──────────────────────────────────────────────────────
// Recent agent activity, newest first, with what it produced and cost.

export function OutcomesRailCard({ activity }: { activity: InitiativeAgentActivity }) {
  const { runs, runsError, spendUsd } = activity;
  const listed = runs.slice(0, OUTCOMES_LIMIT);
  // /admin/changes and /admin/devbox are hr-admin routes; for anyone else the
  // reference is shown as text rather than as a link that redirects home.
  const { can, ready } = useCapabilities();
  const canManageBots = ready && can('ManageDevbox');

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">OUTCOMES</span>
        <div className="flex-1" />
        <span className="text-[10.5px] text-text-tertiary whitespace-nowrap">
          ${spendUsd.toFixed(2)} agent spend (listed runs)
          {runsError ? ' — at least' : ''}
        </span>
      </div>
      {runsError && (
        <div className="px-3 py-2 text-[11px] text-danger leading-relaxed border-b border-border">
          A run history could not be read ({runsError}) — this list and the spend
          above are a floor, not a total.
        </div>
      )}
      {listed.length === 0 && !runsError ? (
        <div className="px-3 py-3 text-[11.5px] text-text-tertiary leading-relaxed">
          No agent runs yet — authorize one from an open story or bug, or let a targeting bot fire.
        </div>
      ) : (
        listed.map((r) => (
          <div key={r.id} className="px-3 py-2 border-b border-border last:border-b-0 text-[11px]">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-text-secondary">{r.trigger}</span>
              <Chip tone={RUN_STATUS_TONE[r.status]} size="xs" dot={r.status === 'running' ? 'pulse' : undefined}>
                {r.status}
              </Chip>
              <div className="flex-1" />
              <CostVsEstimate costUsd={r.costUsd} estimate={runEstimate(r)} />
              <span className="text-text-tertiary whitespace-nowrap" title={r.startedAt}>
                {when(r.startedAt)}
              </span>
            </div>
            {(r.outcome?.changeId || r.outcome?.prUrl || r.outcome?.boxId) && (
              <div className="mt-0.5 flex items-center gap-2.5 flex-wrap">
                {r.outcome?.changeId && (
                  canManageBots ? (
                    <Link to="/admin/changes" className="text-primary no-underline hover:underline">
                      change {r.outcome.changeId.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-text-secondary font-mono text-[10.5px]" title="The review queue needs the ManageDevbox authority">
                      change {r.outcome.changeId.slice(0, 8)}
                    </span>
                  )
                )}
                {r.outcome?.prUrl && (
                  <a
                    href={r.outcome.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary no-underline hover:underline inline-flex items-center gap-0.5"
                  >
                    PR <span aria-hidden="true" className="text-[9px]">↗</span>
                  </a>
                )}
                {r.outcome?.boxId && (
                  canManageBots ? (
                    <Link
                      to={`/admin/devbox?box=${encodeURIComponent(r.outcome.boxId)}`}
                      className="text-text-secondary no-underline hover:text-primary hover:underline font-mono text-[10.5px]"
                    >
                      box {r.outcome.boxId.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-text-tertiary font-mono text-[10.5px]" title="Computers needs the ManageDevbox authority">
                      box {r.outcome.boxId.slice(0, 8)}
                    </span>
                  )
                )}
              </div>
            )}
          </div>
        ))
      )}
    </Card>
  );
}
