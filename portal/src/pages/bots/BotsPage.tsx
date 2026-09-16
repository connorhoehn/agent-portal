// Bots — the durable roster of mission-configured agents.
//
// A bot is not a run: it is the standing directive — template + written
// mission + target + guardrails + trigger — that produces runs. This page is
// the fleet view: what each bot is pointed at, when it fires, whether it is
// paused (and why), and what it has spent today against its budget. The
// governance story is unchanged — every change a bot ships still flows through
// the Changes review queue and policy gates.

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Banner,
  Button,
  Chip,
  DataTable,
  DotMeter,
  EmptyState,
  Inline,
  Input,
  LoadingState,
  MetaLine,
  PageSection,
  ProgressBar,
  Select,
  Stack,
  StatStrip,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { botStatusChip } from '../../lib/statusTone';
import { usd } from '../../lib/format';
import { BotCreateWizard } from './BotCreateWizard';
import { botListLastRanText, botsRollup, botsSummaryLine, filterBots, type BotStatusFilter } from './botsFormat';

// ─── Types (the /api/bots contract) ──────────────────────────────────────────

export interface Bot {
  id: string;
  name: string;
  template: 'epic' | 'story' | 'bug';
  prompt: string;
  agentProjectId: string | null;
  agentProjectRepo: string | null;
  orgProjectId: string | null;
  orgProjectName: string | null;
  model: string;
  trigger: 'manual' | 'cron' | 'pr_watch';
  cronExpr: string | null;
  enabled: boolean;
  budgetPerRunUsd: number | null;
  budgetPerDayUsd: number | null;
  maxRunsPerDay: number;
  requiresReview: boolean;
  createdBy: string | null;
  createdAt: string;
  lastRunAt: string | null;
  pausedReason: string | null;
  todaySpendUsd: number;
  todayRunCount: number;
}

export interface BotRun {
  id: string;
  /** Null for marketplace runs — they are dispatched from a work item, not a bot. */
  botId: string | null;
  trigger: 'manual' | 'cron' | 'pr_watch' | 'marketplace';
  runId: string | null;
  jobId: string | null;
  workItemId: string | null;
  status: 'running' | 'done' | 'failed' | 'skipped';
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: {
    sessionId?: string;
    boxId?: string;
    changeId?: string;
    prUrl?: string;
    filesChanged?: number;
    reason?: string;
    summary?: string;
    /** Echo of the authorize-time estimate (marketplace runs) — feeds the
        estimate-vs-actual coloring on outcome rows. */
    estimate?: {
      basis: 'repo' | 'model' | 'prior';
      sampleCount: number;
      costUsdP25: number;
      costUsdP75: number;
      minutesP25: number;
      minutesP75: number;
      points: number | null;
      scaled: boolean;
    };
  };
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const TEMPLATE_TONE: Record<Bot['template'], 'purple' | 'info' | 'danger'> = {
  epic: 'purple',
  story: 'info',
  bug: 'danger',
};

export function triggerSummary(bot: Pick<Bot, 'trigger' | 'cronExpr'>): string {
  if (bot.trigger === 'cron') return `cron: ${bot.cronExpr ?? '—'}`;
  if (bot.trigger === 'pr_watch') return 'on new PRs';
  return 'manual';
}

const STATUS_OPTIONS: Array<{ value: BotStatusFilter; label: string }> = [
  { value: 'all', label: 'All bots' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'paused', label: 'Paused' },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BotsPage() {
  // `GET /api/bots` answers `{ bots: [], degraded, error }` when the roster
  // read fails (lib/upstream.ts). Without reading that marker the page draws
  // its "No bots yet" onboarding card — an invitation to create a second copy
  // of every bot that already exists.
  const { data, isLoading, error, degraded, refresh } = useFetch<{ bots: Bot[] }>('/api/bots', 15_000);
  const failure = error ?? degraded;
  const [wizardOpen, setWizardOpen] = useState(false);
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageBots');
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<BotStatusFilter>('all');

  const bots = data?.bots ?? [];
  const filtered = useMemo(() => filterBots(bots, { search, status }), [bots, search, status]);
  const rollup = useMemo(() => botsRollup(bots), [bots]);
  const hasFilters = search.trim() !== '' || status !== 'all';

  const columns: DataTableColumn<Bot>[] = [
    {
      key: 'name',
      header: 'Bot',
      sortable: true,
      // A real Link, not just the row's onClick: DataTable's row-click is a
      // bare <tr onClick> with no tabIndex/keydown handling, so a keyboard
      // user tabbing through the filter bar would otherwise skip straight
      // past every row with no way to open one. This is the row's one
      // focusable, Enter/Space-activatable control; the row click stays as a
      // mouse convenience alongside it.
      render: (bot) => (
        <Inline gap="xs" align="center">
          <Link
            to={`/admin/bots/${bot.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[13px] font-semibold text-text-primary no-underline hover:text-primary hover:underline"
          >
            {bot.name}
          </Link>
          <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>
        </Inline>
      ),
    },
    {
      key: 'paused',
      header: 'Status',
      render: (bot) => {
        const c = botStatusChip(bot);
        return <Chip tone={c.tone} size="xs" dot="static" title={c.title}>{c.label}</Chip>;
      },
    },
    {
      key: 'target',
      header: 'Target',
      render: (bot) => (
        bot.agentProjectRepo && bot.agentProjectId ? (
          <Link
            to={`/admin/projects?project=${bot.agentProjectId}`}
            onClick={(e) => e.stopPropagation()}
            title={`Open the codebase this bot works on: ${bot.agentProjectRepo}`}
            className="font-mono text-[11px] text-text-secondary no-underline hover:text-primary hover:underline"
          >
            {bot.agentProjectRepo}
          </Link>
        ) : bot.orgProjectId ? (
          <Link
            to={`/iq/projects/${bot.orgProjectId}`}
            onClick={(e) => e.stopPropagation()}
            title={`Open the initiative this bot serves: ${bot.orgProjectName ?? bot.orgProjectId}`}
            className="text-[11px] text-primary no-underline hover:underline"
          >
            {bot.orgProjectName ?? bot.orgProjectId}
          </Link>
        ) : (
          <MetaLine size="xs" tone="tertiary" items={['no target']} />
        )
      ),
    },
    { key: 'trigger', header: 'Trigger', render: (bot) => triggerSummary(bot) },
    {
      key: 'lastRunAt',
      header: 'Last ran',
      sortable: true,
      // Same `lastRanText`/`botRunSummary` the detail page uses for its
      // header, so the wording ("never fired") and the empty-runs
      // definition can't diverge between the two surfaces — see
      // `botListLastRanText`'s doc comment in botsFormat.ts for the
      // data-level gap this does NOT close (DEFECTS.md org-leader #20).
      render: (bot) => botListLastRanText(bot, relativeTime),
    },
    {
      key: 'today',
      header: 'Today',
      render: (bot) => (
        <Stack gap="none">
          {bot.maxRunsPerDay != null && bot.maxRunsPerDay > 0 ? (
            <DotMeter
              value={bot.todayRunCount / bot.maxRunsPerDay}
              segments={bot.maxRunsPerDay}
              showPercent={false}
              note="today"
              tone="surface"
            />
          ) : (
            <MetaLine size="xs" items={[`${bot.todayRunCount} ${bot.todayRunCount === 1 ? 'run' : 'runs'} today`]} />
          )}
          <MetaLine
            size="xs"
            tone="tertiary"
            items={[`${usd(bot.todaySpendUsd)}${bot.budgetPerDayUsd != null ? ` of ${usd(bot.budgetPerDayUsd)}` : ' spent'}`]}
          />
        </Stack>
      ),
    },
    {
      key: 'budget',
      header: 'Budget',
      render: (bot) => (
        bot.budgetPerDayUsd != null && bot.budgetPerDayUsd > 0 ? (
          <ProgressBar
            value={Math.min(bot.todaySpendUsd, bot.budgetPerDayUsd)}
            max={bot.budgetPerDayUsd}
            size="sm"
            showRatio={false}
            color={bot.todaySpendUsd >= bot.budgetPerDayUsd * 0.8 ? 'var(--color-warning)' : undefined}
            aria-label="Today's spend vs daily budget"
          />
        ) : (
          <MetaLine size="xs" tone="tertiary" items={['—']} />
        )
      ),
    },
  ];

  return (
    <PageSection
      title="Bots"
      description="Standing missions: pick a template, write what the bot should do, point it at a codebase or an initiative, and govern what it ships."
      actions={canManage ? (
        <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>+ New bot</Button>
      ) : undefined}
    >
      {failure && (
        <UnavailableNotice
          error={failure}
          what="the bot roster"
          source="Bots are read from Aurora"
          onRetry={refresh}
          className="mb-4"
        />
      )}

      {!failure && isLoading && bots.length === 0 ? (
        <LoadingState label="Loading bots…" />
      ) : !failure && bots.length === 0 ? (
        <EmptyState
          title="No bots yet"
          description="A bot is a durable, mission-configured agent — a written mission with budget guardrails and a trigger, whose every change still passes review and policy gates."
          {...(canManage ? { actionLabel: '+ New bot', onAction: () => setWizardOpen(true) } : {})}
        />
      ) : (
        <>
          <StatStrip
            aria-label="Bot fleet summary"
            className="mb-3"
            items={[
              { label: 'Enabled', value: rollup.enabled },
              { label: 'Paused', value: rollup.paused },
              {
                label: 'Spend today',
                value: usd(rollup.spendTodayUsd),
                hint: rollup.budgetTodayUsd != null ? `of ${usd(rollup.budgetTodayUsd)} daily budget` : undefined,
              },
              {
                label: 'Near budget',
                value: rollup.nearBudgetCount,
                tone: rollup.nearBudgetCount > 0 ? 'danger' : 'default',
                hint: '≥80% of daily budget',
              },
            ]}
          />

          <Inline wrap align="center" gap="sm" className="mb-3">
            <Input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, codebase or initiative…"
              // A fixed width, not flex-1: the search box used to take the
              // whole row and push the status select and the summary line
              // onto rows of their own — three full-width rows where one
              // filter row does.
              className="w-[320px]"
            />
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as BotStatusFilter)}
              options={STATUS_OPTIONS}
              // Sized to its longest option; the library default is w-full,
              // which took a whole row of its own beside the search box.
              className="w-44"
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus('all'); }}>
                Clear filters
              </Button>
            )}
            <MetaLine
              size="xs" tone="tertiary"
              className="ml-auto"
              items={[botsSummaryLine(bots.length, filtered.length), 'every change still passes review + policy gates']}
            />
          </Inline>

          <DataTable<Bot>
            data={filtered}
            keyField={(b) => b.id}
            onRowClick={(b) => navigate(`/admin/bots/${b.id}`)}
            striped
            emptyMessage={bots.length === 0 ? 'No bots yet.' : 'No bots match the current filters.'}
            columns={columns}
          />
        </>
      )}

      <BotCreateWizard open={wizardOpen} onClose={() => { setWizardOpen(false); refresh(); }} />
    </PageSection>
  );
}
