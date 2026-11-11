// The initiative's Agents tab.
//
// Until 2026-10-07 this was five stacked bordered boxes — Delivered by,
// Activity, an Agents | Compute strip, Agents and Outcomes — and Outcomes
// read only "cron · done · $0.74 · 3h ago". It is now one table-first
// surface: a small section heading whose meta line carries the delivering
// repo and the spend counted from the listed rows; ONE row of segmented
// controls (Runs | Bots | Compute, and the 30/90/180-day window); then a
// single table of the agent runs on this initiative — work item, agent,
// outcome, spend, when, logs. The table's own empty row is the empty state.
//
// The runs come from `GET /api/bots/initiative-runs`, a session floor: the
// runs on an initiative are work-queue facts every reader may see, while the
// bot roster (configuration) stays behind its own gate and only the Bots view
// reads it.

import { plural } from '../../lib/plural';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  ActionRowList,
  type ActionRowColumn,
} from '@connorhoehn/ui-components';
import {
  Button, Chip, DataTable, Inline, InlineAlert, Link as ExternalLink, MetaLine,
  SegmentedControl, Stack, StatusPill, T, type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { usd } from '../../lib/format';
import { botStatusChip, runStateChip } from '../../lib/statusTone';
import type { useInitiativeAgentActivity } from '../../components/marketplace/InitiativeAgentRail';
import { ComputersRailCard } from '../../components/marketplace/InitiativeComputeRail';
import { EnvironmentsRailCard } from '../../components/marketplace/InitiativeEnvironmentsRail';
import { TEMPLATE_TONE, triggerSummary, type BotRun } from '../bots/BotsPage';
import { RANGE_DAYS, runTableRows, type RunTableRow } from './agentRunsModel';
import { flattenWorkItems } from './projectFormat';
import { OUTCOME_LABEL, OUTCOME_TONE, reportsByRunRef, runsListHref, type RunReportRow } from '../iq/runsModel';
import { runHref } from '../iq/runRows';
import { RecordLink } from '../decisions/RecordLink';
import type { Codebase, WorkItemTree } from './types';

type AgentActivity = ReturnType<typeof useInitiativeAgentActivity>;

const VIEW_OPTIONS = [
  { value: 'runs', label: 'Runs' },
  { value: 'bots', label: 'Bots' },
  { value: 'compute', label: 'Compute' },
];
const RANGE_OPTIONS = RANGE_DAYS.map((d) => ({ value: String(d), label: `${d}d` }));

const BOT_COLUMNS: ActionRowColumn[] = [
  { id: 'status', width: 'sm', label: 'Status' },
  { id: 'spend', width: 'md', label: 'Spent today', align: 'end' },
];

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
function pillTone(tone: string): Tone {
  return tone === 'success' || tone === 'warning' || tone === 'danger' || tone === 'info' ? tone : 'neutral';
}

interface InitiativeRunsResponse {
  runs: BotRun[];
  bots: Array<{ id: string; name: string }>;
  degraded?: boolean;
  error?: string;
}

export function InitiativeRail({
  initiativeId,
  activity,
  codebases,
  workTree,
  onOpenLog,
  onOpenLearning,
}: {
  initiativeId: string | undefined;
  /** Opens the run's log in the right pane; the link keeps its page href for a new tab. */
  onOpenLog?: (jobId: string) => void;
  /** Opens the initiative's Learning tab, where the runs show what each one learned. */
  onOpenLearning?: () => void;
  /** The bot roster for the Bots view (gated; `botsError` says when not readable). */
  activity: AgentActivity;
  codebases: Codebase[];
  /** Kept for the page's call site; the runs are read from initiative-runs. */
  runs?: BotRun[];
  workTree: WorkItemTree[];
}) {
  const [view, setView] = useState('runs');
  const [days, setDays] = useState<number>(30);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // The Bots page is for the roles that hold ManageBots (the route's own gate lists the same roles): for
  // anyone else the bots are listed here without a link that would redirect them home.
  const { can, ready } = useCapabilities();
  const canManageBots = ready && can('ManageBots');

  const { data, error, isLoading } = useFetch<InitiativeRunsResponse>(
    initiativeId ? `/api/bots/initiative-runs?orgProjectId=${encodeURIComponent(initiativeId)}` : null,
    15_000,
  );
  // A bot run's outcome is its run report's: joined by the queue job id, which is the report's run ref. The read is
  // gated to the roles that read run reports, so for anyone else it fails quietly and the table keeps its own status.
  const reportsRead = useFetch<{ reports: RunReportRow[] }>(
    initiativeId ? `/api/run-reports?initiative=${encodeURIComponent(initiativeId)}&limit=200` : null, 15_000,
  );
  const reportByJob = useMemo(
    () => reportsByRunRef(reportsRead.error ? [] : reportsRead.data?.reports ?? []),
    [reportsRead.data, reportsRead.error],
  );
  const runsError = error ?? (data?.degraded ? data.error ?? 'degraded' : null);
  const workTitles = useMemo(
    () => new Map(flattenWorkItems(workTree).map((w) => [w.id, w.title] as const)),
    [workTree],
  );
  const table = useMemo(
    () => runTableRows(data?.runs ?? [], data?.bots ?? [], days, workTitles),
    [data, days, workTitles],
  );

  const itemHref = (id: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', 'work');
    params.set('item', id);
    return `?${params}`;
  };

  // Five columns fit the ~580px column beside the Discussion pane: the work
  // item carries its agent as a second line, the outcome its status and words
  // on one line.
  const columns: DataTableColumn<RunTableRow>[] = [
    {
      key: 'workItem', header: 'Work item', sortable: true,
      compare: (a, b) => a.workItemLabel.localeCompare(b.workItemLabel),
      // A run with no work item is a bot's standing mission: its bot leads.
      render: (r) => (
        <Inline gap="sm" wrap={false} className="whitespace-nowrap">
          {r.workItemId
            ? <Link to={itemHref(r.workItemId)} className="text-primary no-underline hover:underline" data-testid="agents-run-item">
                <T size="sm" weight="medium" tone="inherit">{r.workItemLabel}</T>
              </Link>
            : <T size="sm" weight="medium">{r.agent}</T>}
          <T size="xs" tone="secondary" data-testid="agents-run-agent">
            {r.workItemId ? r.agent : `${r.workItemLabel} · ${r.run.trigger.replace(/_/g, ' ')}`}
          </T>
        </Inline>
      ),
    },
    {
      key: 'outcome', header: 'Outcome',
      render: (r) => (
        <Inline gap="xs" wrap>
          <StatusPill variant="text" tone={pillTone(runStateChip(r.run.status).tone)} label={r.run.status} className="shrink-0" />
          {r.run.jobId && reportByJob.get(r.run.jobId) && (
            <RecordLink to={runHref(r.run.jobId)} data-testid="agents-run-report">
              <Chip tone={OUTCOME_TONE[reportByJob.get(r.run.jobId)!.outcome]} size="xs">{OUTCOME_LABEL[reportByJob.get(r.run.jobId)!.outcome]}</Chip>
            </RecordLink>
          )}
          {r.outcome && <T size="xs" tone="secondary" className="block max-w-[280px] truncate" title={r.outcome}>{r.outcome}</T>}
          {r.run.outcome?.prUrl && <ExternalLink href={r.run.outcome.prUrl} external>PR</ExternalLink>}
        </Inline>
      ),
    },
    {
      key: 'spend', header: 'Spend', align: 'right', sortable: true, width: '72px',
      compare: (a, b) => (a.run.costUsd ?? 0) - (b.run.costUsd ?? 0),
      render: (r) => <T size="sm" className="whitespace-nowrap tabular-nums">{usd(r.run.costUsd)}</T>,
    },
    {
      key: 'when', header: 'When', align: 'right', sortable: true, width: '96px',
      compare: (a, b) => a.startedMs - b.startedMs,
      render: (r) => <T size="sm" tone="secondary" className="whitespace-nowrap" title={new Date(r.startedMs).toLocaleString()}>{relativeTime(r.run.startedAt)}</T>,
    },
    {
      key: 'logs', header: 'Logs', align: 'right', width: '56px',
      // The run's transcript and tool calls, from the work queue every
      // signed-in reader may read: in the right pane, its page on demand.
      render: (r) => r.run.jobId
        ? <Link to={`/iq/work/${encodeURIComponent(r.run.jobId)}`} className="text-primary no-underline hover:underline" data-testid="agents-run-logs"
            // Detail goes far right (the user, 2026-10-07): a plain click opens
            // the log in the pane; a modified click still opens the page.
            onClick={(event) => {
              if (!onOpenLog || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              onOpenLog(r.run.jobId!);
            }}>
            <T size="sm" tone="inherit">Logs</T>
          </Link>
        : <T size="sm" tone="secondary">—</T>,
    },
  ];

  const { bots, botsError, botsLoading } = activity;
  const rosterDenied = !!botsError && /403|401|forbidden/i.test(botsError);

  const meta = [
    ...codebases.map((cb) => (
      <Link key={cb.id} to={`/admin/projects?project=${cb.id}`} title="Open this codebase — runs, changes, workspace"
        className="text-primary no-underline hover:underline" data-testid="agents-repo-link">
        <T size="sm" tone="inherit">{cb.repoFullName}</T>
      </Link>
    )),
    view === 'runs'
      ? `${runsError ? 'at least ' : ''}${usd(table.spendUsd)} agent spend over ${table.rows.length} run${table.rows.length === 1 ? '' : 's'} in the last ${days} days`
      : null,
  ];

  // The Agents tab names this section (the user, 2026-11-02: a tab should not
  // repeat its title as a heading inside it), so the panel opens on one row:
  // the view and window switches, with the spend/repo meta and the bots
  // action at the far end, then the one table.
  return (
    <Stack gap="sm" data-testid="initiative-agents">
      <Inline gap="sm" justify="between" align="center" wrap data-testid="initiative-agents-controls">
        <Inline gap="sm" align="center" wrap>
          <SegmentedControl aria-label="Runs, bots or compute" options={VIEW_OPTIONS}
            value={view} onChange={setView} data-testid="initiative-agents-view" />
          {view === 'runs' && (
            <SegmentedControl aria-label="Time window" options={RANGE_OPTIONS}
              value={String(days)} onChange={(v) => setDays(Number(v))} data-testid="initiative-agents-range" />
          )}
        </Inline>
        <Inline gap="sm" align="center" wrap className="min-w-0">
          {meta.some(Boolean) && <MetaLine size="sm" tone="secondary" items={meta} data-testid="initiative-agents-meta" />}
          {view === 'runs' && onOpenLearning && <Button variant="link" onClick={onOpenLearning} data-testid="initiative-learning-link">What these runs learned</Button>}
          {view === 'runs' && initiativeId && <Button variant="link" onClick={() => navigate(runsListHref({ initiative: initiativeId }))} data-testid="initiative-runs-link">All runs for this initiative</Button>}
        </Inline>
      </Inline>

        {view === 'runs' && (
          <>
            {runsError && (
              <InlineAlert tone="warning">
                A run history could not be read ({runsError}) — the runs and spend are a floor, not a total.
              </InlineAlert>
            )}
            <DataTable
              data={table.rows}
              columns={columns}
              keyField={(r) => r.run.id}
              loading={isLoading && !data}
              emptyMessage={`No agent runs in the last ${plural(days, 'day')} — authorize one from an open story or bug.`}
              data-testid="initiative-agents-runs"
            />
          </>
        )}

        {view === 'bots' && canManageBots && initiativeId && !botsError && (
          // The roster is one page now (Bots); this is its link, narrowed to this initiative.
          <Inline gap="sm" align="center" wrap data-testid="initiative-agents-bots">
            <T size="sm">{botsLoading ? 'Loading bots…' : `${bots.length === 1 ? '1 bot serves' : `${bots.length} bots serve`} this initiative.`}</T>
            <Button variant="link" onClick={() => navigate(`/admin/bots?initiative=${encodeURIComponent(initiativeId)}`)} data-testid="initiative-bots-link">
              Open them in Bots
            </Button>
          </Inline>
        )}

        {view === 'bots' && !(canManageBots && initiativeId && !botsError) && (
          <ActionRowList
            aria-label="Bots pointed at this initiative"
            columns={rosterDenied ? [] : BOT_COLUMNS}
            items={rosterDenied
              // The roster's configuration is not this role's to read; the
              // bots' names are, from the runs they made.
              ? (data?.bots ?? []).map((b) => ({ id: b.id, title: b.name, description: 'Configuration is visible to bot managers.' }))
              : bots.map((bot) => {
                  const chip = botStatusChip(bot);
                  return {
                    id: bot.id,
                    title: bot.name,
                    leading: <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>,
                    description: triggerSummary(bot),
                    cells: {
                      status: <StatusPill variant="text" tone={pillTone(chip.tone)} label={chip.label} />,
                      spend: <T size="sm">{usd(bot.todaySpendUsd)}</T>,
                    },
                  };
                })}
            onOpen={(item) => { if (canManageBots) navigate(`/admin/bots/${item.id}`); }}
            emptyLabel={botsLoading && !botsError ? 'Loading bots…' : 'No bots target this initiative — point a standing mission here from the Bots page.'}
            data-testid="initiative-agents-bots"
          />
        )}

        {view === 'compute' && (
          <Stack gap="sm">
            <ComputersRailCard initiativeId={initiativeId} />
            <EnvironmentsRailCard initiativeId={initiativeId} />
          </Stack>
        )}
    </Stack>
  );
}
