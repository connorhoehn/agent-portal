// Bots — the durable roster of mission-configured agents.
//
// A bot is not a run: it is the standing directive — template + written
// mission + target + guardrails + trigger — that produces runs. This page is
// the fleet view: what each bot is pointed at, when it fires, whether it is
// paused (and why), and what it has spent today against its budget. The
// governance story is unchanged — every change a bot ships still flows through
// the Changes review queue and policy gates.

import { useState } from 'react';
import { Link } from 'react-router';
import {
  PageSection,
  Card,
  Chip,
  ProgressBar,
  EmptyState,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { BotCreateWizard } from './BotCreateWizard';

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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BotsPage() {
  const { data, error, refresh } = useFetch<{ bots: Bot[] }>('/api/bots', 15_000);
  const [wizardOpen, setWizardOpen] = useState(false);
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  const bots = data?.bots ?? [];

  return (
    <PageSection
      title="Bots"
      description="Standing missions: pick a template, write what the bot should do, point it at a codebase or an initiative, and govern what it ships."
    >
      <div className="flex items-center gap-2 mb-4">
        {canManage && (
          <button
            onClick={() => setWizardOpen(true)}
            className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer"
          >
            + New bot
          </button>
        )}
        {bots.length > 0 && (
          <span className="text-[11px] text-text-tertiary">
            {bots.length} {bots.length === 1 ? 'bot' : 'bots'} · every change still passes review + policy gates
          </span>
        )}
      </div>

      {error && (
        <Card padding="md" className="mb-4">
          <div className="text-[12px] text-danger">Failed to load bots: {error}</div>
        </Card>
      )}

      {!error && bots.length === 0 ? (
        <EmptyState
          title="No bots yet"
          description="A bot is a durable, mission-configured agent — a written mission with budget guardrails and a trigger, whose every change still passes review and policy gates."
          {...(canManage ? { actionLabel: '+ New bot', onAction: () => setWizardOpen(true) } : {})}
        />
      ) : (
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
          {bots.map((bot) => {
            // Paused is either half: operator-disabled OR self-paused (budget).
            const paused = !bot.enabled || bot.pausedReason != null;
            return (
              <Card key={bot.id} padding="none" className="overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2 flex-wrap">
                  <Link
                    to={`/admin/bots/${bot.id}`}
                    className="text-[13px] font-semibold text-text-primary no-underline truncate hover:text-primary hover:underline"
                  >
                    {bot.name}
                  </Link>
                  <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>
                  <div className="flex-1" />
                  {paused ? (
                    <Chip tone="warning" size="xs" dot="static">paused</Chip>
                  ) : (
                    <Chip tone="success" size="xs" dot="static">enabled</Chip>
                  )}
                </div>

                {paused && bot.pausedReason && (
                  <div className="px-3.5 py-2 border-b border-border bg-warning-bg/40 text-[11px] text-warning">
                    {bot.pausedReason}
                  </div>
                )}

                <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2 flex-wrap min-w-0">
                  {bot.agentProjectRepo && bot.agentProjectId ? (
                    <Link
                      to={`/admin/projects?project=${bot.agentProjectId}`}
                      title={`Open the codebase this bot works on: ${bot.agentProjectRepo}`}
                      className="text-[12px] font-mono text-text-secondary no-underline truncate hover:text-primary hover:underline"
                    >
                      {bot.agentProjectRepo}
                    </Link>
                  ) : bot.orgProjectId ? (
                    <Link
                      to={`/iq/projects/${bot.orgProjectId}`}
                      title={`Open the initiative this bot serves: ${bot.orgProjectName ?? bot.orgProjectId}`}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary no-underline hover:underline truncate max-w-[60%]"
                    >
                      {bot.orgProjectName ?? bot.orgProjectId}
                    </Link>
                  ) : (
                    <span className="text-[11px] text-text-tertiary">no target</span>
                  )}
                  <div className="flex-1" />
                  <span className="text-[11px] text-text-tertiary whitespace-nowrap">{triggerSummary(bot)}</span>
                  <span className="text-[11px] text-text-tertiary whitespace-nowrap" title={bot.lastRunAt ?? undefined}>
                    · last ran {when(bot.lastRunAt)}
                  </span>
                </div>

                <div className="px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                    <span>
                      today: {bot.todayRunCount}/{bot.maxRunsPerDay} {bot.todayRunCount === 1 ? 'run' : 'runs'}
                      {' · '}${bot.todaySpendUsd.toFixed(2)}
                      {bot.budgetPerDayUsd != null ? ` of $${bot.budgetPerDayUsd.toFixed(2)}` : ' spent'}
                    </span>
                  </div>
                  {bot.budgetPerDayUsd != null && bot.budgetPerDayUsd > 0 && (
                    <div className="mt-1.5">
                      <ProgressBar
                        value={Math.min(bot.todaySpendUsd, bot.budgetPerDayUsd)}
                        max={bot.budgetPerDayUsd}
                        size="sm"
                        showRatio={false}
                        color={bot.todaySpendUsd >= bot.budgetPerDayUsd * 0.8 ? 'var(--color-warning)' : undefined}
                        aria-label="Today's spend vs daily budget"
                      />
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <BotCreateWizard open={wizardOpen} onClose={() => { setWizardOpen(false); refresh(); }} />
    </PageSection>
  );
}
