// The queue's pulse: how deep it is, who is pulling from it, and how long
// until it drains. This is the panel the Queue page was missing — the job list
// said WHAT was queued while nothing said WHO drains it or WHEN it clears.
//
// Reads /api/bots itself (the roster is this panel's own concern); depth and
// worker counts arrive from the page's existing summary/jobs fetches so the
// numbers can never disagree with the list below them.

import { Link } from 'react-router';
import {
  Card, Chip, DotMeter, Inline, MetaLine, SectionLabel, Stack, StatStrip, StatusDot, Toolbar,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { useSession } from '../../lib/auth';
import { botStatusChip } from '../../lib/statusTone';
import { usd } from '../../lib/format';
import { BOTS_ROLES } from './automateNav';
import { T } from './workShared';
import { avgJobMinutes, botsOnQueue, estimateDrainMinutes, pausedBotCount, pullingBotIds, type QueueJobLike } from './queueMath';

interface PulseBot {
  id: string;
  name: string;
  template: string;
  trigger: 'manual' | 'cron' | 'pr_watch';
  cronExpr: string | null;
  enabled: boolean;
  pausedReason: string | null;
  orgProjectName: string | null;
  agentProjectRepo: string | null;
  lastRunAt: string | null;
  todayRunCount: number;
  maxRunsPerDay: number;
  todaySpendUsd: number;
}

function lastRan(iso: string | null): string {
  return iso ? `ran ${relativeTime(iso)}` : 'never ran';
}

function cadence(bot: PulseBot): string {
  if (bot.trigger === 'cron') return `cron ${bot.cronExpr ?? '—'}`;
  if (bot.trigger === 'pr_watch') return 'on new PRs';
  return 'manual';
}

export function QueuePulse({ summary, jobs, degraded }: {
  summary: { jobs: Record<string, number>; busyBoxes: string[] } | null;
  jobs: QueueJobLike[];
  /** True when the summary fetch failed — the meters say unknown, not zero. */
  degraded: boolean;
}) {
  const { session } = useSession();
  // /api/bots is role/capability gated; a member simply gets no roster. That
  // is a THIRD state next to "no bots" and "we could not read the roster" —
  // the route marks the last one `degraded`, and the hint below names which
  // of the three the reader is looking at.
  const { data, error, degraded: botsDegraded } = useFetch<{ bots: PulseBot[] }>('/api/bots', 15_000);
  const botsFailure = error ?? botsDegraded;
  const bots = botsFailure ? [] : data?.bots ?? [];

  const queued = summary?.jobs['queued'] ?? 0;
  const processing = (summary?.jobs['running'] ?? 0) + (summary?.jobs['claimed'] ?? 0);
  const workers = Math.max(summary?.busyBoxes.length ?? 0, processing > 0 ? 1 : 0);
  const eta = estimateDrainMinutes(queued, processing, Math.max(workers, 1), avgJobMinutes(jobs));

  const pulling = pullingBotIds(jobs);
  const canOpenBot = BOTS_ROLES.includes(session?.role ?? '');
  // The stat tile and the roster below it read the same filtered list
  // (queueMath.ts) so a bot can never appear in one and not the other.
  const roster = botsOnQueue(bots);

  return (
    <Stack gap="none" className="mb-5">
      {/* A single stat-strip row, not a stack of KPI cards — the job list
          below is the page. */}
      <StatStrip
        aria-label="Queue pulse"
        items={[
          {
            label: 'Waiting',
            value: degraded ? '—' : queued,
            hint: degraded ? 'queue unreachable' : 'jobs queued, none claimed yet',
          },
          {
            label: 'Processing',
            value: degraded ? '—' : processing,
            tone: !degraded && processing > 0 ? 'accent' : 'default',
            hint: degraded
              ? 'unknown'
              : processing > 0
                ? `on ${summary?.busyBoxes.join(', ') || 'a worker'}`
                : 'nothing mid-flight',
          },
          {
            label: 'Est. to drain',
            value: degraded ? '—' : eta != null ? `~${eta} min` : 'clear',
            hint: degraded
              ? 'unknown'
              : eta != null
                ? 'at the recent average job time'
                : 'the queue is empty',
          },
          {
            label: 'Bots on this queue',
            value: botsFailure ? '—' : roster.length,
            hint: botsDegraded
              ? `roster unreadable — ${botsDegraded}`
              : error
                ? 'roster not visible to this role'
                // Sized to the tile: `StatStripItem` has no `title`, so an
                // overrunning hint is cut mid-word with no way to read the
                // rest — measured 221px needed in 209px, losing "…gates".
                : `${pausedBotCount(roster)} paused · all runs pass review`,
          },
        ]}
      />

      {roster.length > 0 && (
        <Card padding="none" className="mt-3 overflow-hidden">
          <Toolbar
            size="sm"
            end={canOpenBot ? (
              <Link to="/admin/bots" className="text-[11px] text-primary no-underline hover:underline">
                Manage bots →
              </Link>
            ) : undefined}
          >
            <SectionLabel>Bots pulling from this queue</SectionLabel>
          </Toolbar>
          {roster.map((bot) => {
            const isPulling = pulling.has(bot.id);
            const paused = !bot.enabled || bot.pausedReason != null;
            const statusChip = botStatusChip(bot, isPulling);
            const name = canOpenBot ? (
              <Link to={`/admin/bots/${bot.id}`} className="text-[12px] font-semibold text-text-primary no-underline hover:text-primary hover:underline truncate">
                {bot.name}
              </Link>
            ) : (
              <T className="text-[12px] font-semibold text-text-primary truncate">{bot.name}</T>
            );
            return (
              <Inline key={bot.id} align="center" gap="sm" className="px-3.5 py-2 border-b border-border last:border-b-0 min-w-0">
                {isPulling ? (
                  <StatusDot size="xs" pulse color="var(--color-success)" aria-label="Pulling a job now" />
                ) : (
                  <StatusDot size="xs" color={paused ? 'var(--color-warning)' : 'var(--color-state-idle)'} />
                )}
                {name}
                <T className="text-[11px] text-text-tertiary truncate">
                  {bot.orgProjectName ?? bot.agentProjectRepo ?? ''}
                </T>
                <T className="flex-1" />
                <Chip tone={statusChip.tone} size="xs" dot={isPulling ? 'pulse' : undefined} title={statusChip.title}>
                  {statusChip.label}
                </Chip>
                <T className="text-[11px] text-text-tertiary whitespace-nowrap">{cadence(bot)}</T>
                <T className="text-[11px] text-text-tertiary whitespace-nowrap hidden md:inline">
                  {lastRan(bot.lastRunAt)}
                </T>
                <DotMeter
                  label="runs"
                  value={bot.todayRunCount / bot.maxRunsPerDay}
                  note={`${bot.todayRunCount}/${bot.maxRunsPerDay} today`}
                  tone="surface"
                  className="hidden md:flex"
                  data-testid={`bot-quota-${bot.id}`}
                />
                <MetaLine size="xs" items={[`${usd(bot.todaySpendUsd)} today`]} className="hidden md:flex" />
              </Inline>
            );
          })}
        </Card>
      )}
    </Stack>
  );
}
