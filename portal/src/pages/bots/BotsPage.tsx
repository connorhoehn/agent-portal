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
  EmptyState,
  Inline,
  Input,
  MetaLine,
  PageSection,
  ProgressBar,
  Select,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { BotCreateWizard } from './BotCreateWizard';
import { botListLastRanText, botsSummaryLine, filterBots, type BotStatusFilter } from './botsFormat';

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

/** Aurora timestamps arrive without T/Z — same normalization as Codebases. */
export function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const STATUS_OPTIONS: Array<{ value: BotStatusFilter; label: string }> = [
  { value: 'all', label: 'All bots' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'paused', label: 'Paused' },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BotsPage() {
  const { data, error, refresh } = useFetch<{ bots: Bot[] }>('/api/bots', 15_000);
  const [wizardOpen, setWizardOpen] = useState(false);
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageBots');
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<BotStatusFilter>('all');

  const bots = data?.bots ?? [];
  const filtered = useMemo(() => filterBots(bots, { search, status }), [bots, search, status]);
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
        const paused = !bot.enabled || bot.pausedReason != null;
        return paused ? (
          <Chip tone="warning" size="xs" dot="static" title={bot.pausedReason ?? undefined}>paused</Chip>
        ) : (
          <Chip tone="success" size="xs" dot="static">enabled</Chip>
        );
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
      render: (bot) => botListLastRanText(bot, when),
    },
    {
      key: 'today',
      header: 'Today',
      render: (bot) => (
        <MetaLine
          size="xs"
          items={[
            `${bot.todayRunCount}/${bot.maxRunsPerDay} ${bot.todayRunCount === 1 ? 'run' : 'runs'}`,
            `$${bot.todaySpendUsd.toFixed(2)}${bot.budgetPerDayUsd != null ? ` of $${bot.budgetPerDayUsd.toFixed(2)}` : ' spent'}`,
          ]}
        />
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
      {error && <Banner variant="error" className="mb-4">Failed to load bots: {error}</Banner>}

      {!error && bots.length === 0 ? (
        <EmptyState
          title="No bots yet"
          description="A bot is a durable, mission-configured agent — a written mission with budget guardrails and a trigger, whose every change still passes review and policy gates."
          {...(canManage ? { actionLabel: '+ New bot', onAction: () => setWizardOpen(true) } : {})}
        />
      ) : (
        <>
          <Inline wrap align="center" gap="sm" className="mb-3">
            <Input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, codebase or initiative…"
              className="min-w-[220px] flex-1"
            />
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as BotStatusFilter)}
              options={STATUS_OPTIONS}
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus('all'); }}>
                Clear filters
              </Button>
            )}
            <MetaLine
              size="xs" tone="tertiary"
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
