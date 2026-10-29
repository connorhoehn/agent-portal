// Bot detail — where you live with a bot: watch the current run live, read the
// mission, tune the guardrails, and audit every firing with its cost and
// outcome. Controls are deliberately few — Run now, Pause/Resume, Delete —
// because the interesting decisions (approve, deliver) stay where governance
// already lives, in the Changes queue.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  DetailSection,
  FormField,
  Inline,
  Input,
  Link as ExternalLink,
  MetaLine,
  PageSection,
  Select,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  Tabs,
  Textarea,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { CostVsEstimate, runEstimate } from '../../components/marketplace/EstimateDrawer';
import { RunTimeline } from '../../components/runs/RunTimeline';
import {
  PipelineRunArtifacts, PipelineRunEvents, PipelineRunSteps, PipelineRunSummary, usePipelineRun,
} from '../../components/runs/PipelineRunParts';
import type { RunListResponse } from '../../lib/pipelineRuns';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp';
import { relativeTime } from '../../lib/relativeTime';
import { botStatusChip, runStateChip } from '../../lib/statusTone';
import { usd, showingLabel } from '../../lib/format';
import { inputWiring, lastRanText } from './botsFormat';
import { TEMPLATE_TONE, triggerSummary, type Bot, type BotRun } from './BotsPage';
import { botRunRefusalMessage, type BotRunRefusal } from '../../lib/dispatchGates';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run-history reveal batch — see the `runsLimit` state below. */
const BOT_RUNS_PAGE_SIZE = 25;

/** Aurora stamps carry a `+00` offset ISO 8601 does not allow — shared parser. */
function parseTs(iso: string): number {
  return parsePgTimestampAsUtc(iso)?.getTime() ?? Number.NaN;
}

/** How long the run took, or why we can't say.
 *
 *  A finish stamp identical to the start stamp is not a run that took no time
 *  — it is a run whose duration was never recorded (every seeded history row
 *  is written that way). Rendering "0ms" for it states a measurement that was
 *  never taken, so an unrecorded duration reads as an em dash and says why on
 *  hover. */
function runDuration(r: BotRun): { text: string; title?: string } {
  if (!r.finishedAt) {
    return r.status === 'running'
      ? { text: '…', title: 'Still running' }
      : { text: '—', title: 'This run never recorded a finish time' };
  }
  const ms = parseTs(r.finishedAt) - parseTs(r.startedAt);
  if (!Number.isFinite(ms) || ms <= 0) {
    return { text: '—', title: 'Duration not recorded — this run’s start and finish stamps are identical' };
  }
  return {
    text: ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`,
  };
}

function modelLabel(id: string): string {
  return DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Opt-in bot-fire allocation brake, read defensively: the field is carried on
 *  the wire (providers/bots.ts) but the shared Bot type may predate it, and a
 *  bot from a cluster without the column reports it absent — either way the
 *  brake is off unless it is explicitly true. */
function botEnforceAllocation(b: Bot): boolean {
  return (b as { enforceAllocation?: boolean }).enforceAllocation === true;
}

/** The four views of one bot — Runs is first, because "what did this bot do
 *  lately" is the question this page exists to answer; the mission and
 *  guardrails that shaped those runs follow. "Live activity" only exists as a
 *  tab while a run is actually in flight (see `liveBoxId` below) — same
 *  pattern as local-compute's conditional "Assign work" tab. */
type BotTab = 'runs' | 'mission' | 'guardrails' | 'activity';

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BotDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  // The controls on this page (Run now, Pause/Resume, Delete, mission/guardrail
  // edits) all PATCH/POST /api/bots/:id* routes gated server-side on ManageBots
  // (middleware/src/routes/bots.ts `manageGate`) — a different capability from
  // Computer Lab's ManageDevbox. Gating on ManageDevbox here hid every control
  // from a role (program-owner) that holds ManageBots but not ManageDevbox,
  // even though the server would have accepted the request. DEFECTS.md
  // program-owner #9.
  const canManage = ready && can('ManageBots');

  const { data: botData, error: botError, refresh: refreshBot } =
    useFetch<{ bot: Bot }>(id ? `/api/bots/${id}` : null, 15_000);
  const bot = botData?.bot ?? null;
  // The trail reads the bot's name once it loads, not "Bot 32970d0a…".
  useCrumbLabel(id, bot?.name);

  // Runs poll fast while one is in flight, lazily otherwise.
  const [anyRunning, setAnyRunning] = useState(false);
  // "This bot has never fired" is a claim about the bot. When the run-history
  // read fails the route says so (`degraded`), and repeating the claim would
  // send someone to press ▶ Run now on a bot that may be running already.
  const { data: runsData, error: runsError, degraded: runsDegraded, refresh: refreshRuns } =
    useFetch<{ runs: BotRun[] }>(id ? `/api/bots/${id}/runs` : null, anyRunning ? 5_000 : 15_000);
  const runsFailure = runsError ?? runsDegraded;
  const runs = [...(runsData?.runs ?? [])].sort((a, b) => parseTs(b.startedAt) - parseTs(a.startedAt));
  // `/api/bots/:id/runs` returns the whole history with no server-side
  // limit — a cron bot that's been firing for months hands this hand-rolled
  // Table (no DataTable, no windowing) hundreds of rows in one unbounded
  // body. Cap it client-side and reveal more a batch at a time.
  const [runsLimit, setRunsLimit] = useState(BOT_RUNS_PAGE_SIZE);
  const visibleRuns = runs.slice(0, runsLimit);
  const hasMoreRuns = runs.length > runsLimit;
  const running = runs.some((r) => r.status === 'running');
  if (running !== anyRunning) setAnyRunning(running);

  // The same firings read as pipeline Runs (docs/pipelines-tenant-goal.md
  // §"The vertical slice"): each cron firing is the trigger of the queue job
  // it enqueued, rendered Run → Steps → Artifacts → Events through the orgiq
  // façade /api/runs — never /api/pipelines/*, which is another tenant's door.
  const { data: pipelineData, error: pipelineError, refresh: refreshPipeline } =
    useFetch<RunListResponse>(id ? `/api/runs?botId=${encodeURIComponent(id)}&limit=50` : null, anyRunning ? 5_000 : 30_000);
  const pipelineRuns = pipelineData?.runs ?? [];
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const pipelineRunId = pickedRunId ?? pipelineRuns[0]?.id ?? null;
  const pipelineRun = usePipelineRun('/api/runs', pipelineRunId);

  const newest = runs[0] ?? null;
  const liveBoxId = newest?.status === 'running' && newest.outcome?.boxId ? newest.outcome.boxId : null;

  const [busy, setBusy] = useState<string | null>(null);

  // Run now — a small prompt-for-instruction box, the steering wheel without
  // editing the mission.
  const [runOpen, setRunOpen] = useState(false);
  const [instruction, setInstruction] = useState('');

  // Delete
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Guardrails edit
  const [editGuards, setEditGuards] = useState(false);
  const [gModel, setGModel] = useState('');
  const [gPerRun, setGPerRun] = useState('');
  const [gPerDay, setGPerDay] = useState('');
  const [gMaxRuns, setGMaxRuns] = useState(4);
  const [gReview, setGReview] = useState(true);
  const [gEnforceAlloc, setGEnforceAlloc] = useState(false);

  // Mission edit
  const [editMission, setEditMission] = useState(false);
  const [missionText, setMissionText] = useState('');

  // The one tabbed area below the header — Runs / Mission / Guardrails /
  // (while live) Live activity, replacing four stacked cards.
  const [tab, setTab] = useState<BotTab>('runs');
  // If the run this tab was watching finishes while it's open, the "Live
  // activity" item drops out of the tab list (it only exists while
  // `liveBoxId` is set) — fall back to Runs rather than leaving the panel on
  // a tab that no longer has a trigger to select it.
  useEffect(() => {
    if (tab === 'activity' && !liveBoxId) setTab('runs');
  }, [tab, liveBoxId]);

  async function patchBot(patch: Record<string, unknown>, successLabel?: string): Promise<boolean> {
    if (!bot) return false;
    const res = await writeJson(`/api/bots/${bot.id}`, 'PATCH', patch);
    if (!res.ok) {
      toastError(null, 'Update failed', res.error ?? `HTTP ${res.status}`);
      return false;
    }
    refreshBot();
    if (successLabel) toastSuccess(null, successLabel, bot.name);
    return true;
  }

  async function runNow() {
    if (!bot || busy) return;
    setBusy('run');
    const res = await writeJson<BotRunRefusal>(
      `/api/bots/${bot.id}/run`, 'POST',
      instruction.trim() ? { instruction: instruction.trim() } : {},
    );
    if (res.status === 409) {
      toastError(null, 'Not run', botRunRefusalMessage(res.data, 'The bot refused this run (budget or run cap reached).'));
      setBusy(null);
      return;
    }
    if (!res.ok) {
      toastError(null, 'Could not start', res.error ?? `HTTP ${res.status}`);
      setBusy(null);
      return;
    }
    toastSuccess(null, 'Run started', 'It streams below as it works.');
    setRunOpen(false); setInstruction('');
    refreshRuns(); refreshBot();
    setBusy(null);
  }

  async function pauseOrResume() {
    if (!bot || busy) return;
    // Mirror the roster's definition of paused: operator-disabled OR
    // self-paused. Resume clears both server-side.
    const isPaused = !bot.enabled || bot.pausedReason != null;
    const action = isPaused ? 'resume' : 'pause';
    setBusy(action);
    const res = await writeJson(`/api/bots/${bot.id}/${action}`, 'POST', {});
    if (!res.ok) {
      toastError(null, `Could not ${action}`, res.error ?? `HTTP ${res.status}`);
      setBusy(null);
      return;
    }
    toastSuccess(null, action === 'pause' ? 'Paused' : 'Resumed');
    refreshBot();
    setBusy(null);
  }

  async function deleteBot() {
    if (!bot || busy) return;
    setBusy('delete');
    const res = await writeJson(`/api/bots/${bot.id}`, 'DELETE');
    if (!res.ok) {
      toastError(null, 'Could not delete', res.error ?? `HTTP ${res.status}`);
      setConfirmDelete(false);
      setBusy(null);
      return;
    }
    toastSuccess(null, 'Bot deleted', `${bot.name} and its run history are gone.`);
    navigate('/admin/bots');
    setBusy(null);
  }

  function beginEditGuards() {
    if (!bot) return;
    setGModel(bot.model);
    setGPerRun(bot.budgetPerRunUsd != null ? String(bot.budgetPerRunUsd) : '');
    setGPerDay(bot.budgetPerDayUsd != null ? String(bot.budgetPerDayUsd) : '');
    setGMaxRuns(bot.maxRunsPerDay);
    setGReview(bot.requiresReview);
    setGEnforceAlloc(botEnforceAllocation(bot));
    setEditGuards(true);
  }

  async function saveGuards() {
    setBusy('guards');
    const ok = await patchBot({
      model: gModel,
      budgetPerRunUsd: gPerRun.trim() === '' ? null : Number(gPerRun),
      budgetPerDayUsd: gPerDay.trim() === '' ? null : Number(gPerDay),
      maxRunsPerDay: gMaxRuns,
      requiresReview: gReview,
      enforceAllocation: gEnforceAlloc,
    }, 'Guardrails updated');
    setBusy(null);
    if (ok) setEditGuards(false);
  }

  async function saveMission() {
    if (!missionText.trim()) return;
    setBusy('mission');
    const ok = await patchBot({ prompt: missionText.trim() }, 'Mission updated');
    setBusy(null);
    if (ok) setEditMission(false);
  }

  if (botError) {
    return (
      <PageSection title="Bot">
        <Stack gap="xs">
          <UnavailableNotice
            error={botError}
            what="this bot"
            source="Bots are read from Aurora"
            onRetry={refreshBot}
          />
          <Link to="/admin/bots" className="text-xs text-primary no-underline hover:underline">← Bots</Link>
        </Stack>
      </PageSection>
    );
  }
  if (!bot) {
    return (
      <PageSection title="Bot">
        <MetaLine size="sm" tone="tertiary" items={['Loading…']} />
      </PageSection>
    );
  }

  const paused = !bot.enabled || bot.pausedReason != null;
  const modelOptions = [
    ...DEVBOX_MODELS.map((m) => ({ value: m.id, label: m.label })),
    ...(!DEVBOX_MODELS.some((m) => m.id === gModel) && gModel ? [{ value: gModel, label: gModel }] : []),
  ];

  return (
    <PageSection title={bot.name} data-testid="bot-detail-page">
      {/* ── Header: identity + state + controls ── */}
      <Card padding="sm" className="mb-4">
        <Inline gap="sm" wrap align="center" justify="between">
          <Inline gap="sm" wrap align="center">
            <Link to="/admin/bots" className="text-xs text-primary no-underline hover:underline shrink-0">← Bots</Link>
            <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>
            {(() => {
              const c = botStatusChip(bot);
              return <Chip tone={c.tone} size="xs" dot="static" title={c.title}>{c.label}</Chip>;
            })()}
            <MetaLine
              size="xs" tone="tertiary"
              items={[
                triggerSummary(bot),
                lastRanText(runs, relativeTime),
              ]}
            />
          </Inline>
          {canManage && (
            <Inline gap="xs">
              <Button variant="primary" size="sm" onClick={() => setRunOpen((v) => !v)}>
                {runOpen ? 'Cancel' : '▶ Run now'}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy === 'pause' || busy === 'resume'} onClick={() => void pauseOrResume()}>
                {paused ? 'Resume' : 'Pause'}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </Inline>
          )}
        </Inline>

        {paused && bot.pausedReason && (
          <Banner variant="warning" className="mt-2">{bot.pausedReason}</Banner>
        )}

        {runOpen && (
          <Stack gap="xs" className="mt-2.5 pt-2.5 border-t border-border">
            <Textarea
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runNow(); }}
              minRows={2}
              placeholder="Optional one-shot instruction for this run — e.g. 'focus on the auth module'. Leave empty to run the mission as written."
            />
            <Inline gap="sm" align="center" justify="between">
              <MetaLine size="xs" tone="tertiary" items={['⌘⏎ to run']} />
              <Button variant="primary" size="sm" disabled={busy === 'run'} onClick={() => void runNow()}>
                {busy === 'run' ? 'starting…' : 'Run'}
              </Button>
            </Inline>
          </Stack>
        )}
      </Card>

      {/* ── One tabbed area instead of four stacked cards (Live activity,
          Runs, Mission, Guardrails each used to carry their own heading and
          rule). These are four views of one bot, not four topics. Nothing
          here repeats what the roster row above already shows — pause state,
          last-ran time, today's run count and today's spend all live there
          now (BotsPage.tsx's Status / Last ran / Today / Budget columns), so
          the guardrails view keeps only the standing config, not a second
          rendering of today's usage. ── */}
      <DetailSection first title="Bot details" hint={triggerSummary(bot)}>
        <Tabs
          idPrefix="bot"
          aria-label={`${bot.name} detail`}
          value={tab}
          onValueChange={(id) => setTab(id as BotTab)}
          items={[
            { id: 'runs', label: runs.length > 0 ? `Runs · ${runs.length}` : 'Runs' },
            { id: 'mission', label: 'Mission' },
            { id: 'guardrails', label: 'Guardrails' },
            ...(liveBoxId ? [{ id: 'activity', label: 'Live activity' }] : []),
          ]}
        />

        {/* ── Runs — first, because "what did this bot do lately" is the
            question this page exists to answer. ── */}
        <Stack hidden={tab !== 'runs'} gap="sm">
          <MetaLine
            size="xs" tone="tertiary"
            items={[runs.length > 0
              ? `${showingLabel(visibleRuns.length, runs.length, 'firings')} — what it did each time it fired.`
              : "This bot's dispatch history — what it did each time it fired."]}
          />
          {runsFailure ? (
            <UnavailableNotice
              error={runsFailure}
              what="this bot's run history"
              source="Runs are read from Aurora"
              onRetry={refreshRuns}
            />
          ) : runs.length === 0 ? (
            <MetaLine size="sm" tone="tertiary" items={['This bot has never fired. Use ▶ Run now, or wait for its trigger.']} />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Trigger</TableTh>
                  <TableTh>Status</TableTh>
                  <TableTh>Cost</TableTh>
                  <TableTh>Duration</TableTh>
                  <TableTh>Started</TableTh>
                  <TableTh>Outcome</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleRuns.map((r) => {
                  const dur = runDuration(r);
                  // What this run left behind. The reason is rendered for every
                  // status, not just skipped: a `done` run whose only record is
                  // "scheduled maintenance" has an outcome, and gating on
                  // status === 'skipped' hid it — the whole column rendered
                  // blank for a bot with a full history of completed runs.
                  const o = r.outcome ?? {};
                  const canLinkRun = r.runId != null && bot.agentProjectId != null;
                  const hasOutcome = Boolean(
                    o.reason || o.changeId || o.prUrl || o.filesChanged != null || r.jobId || canLinkRun,
                  );
                  return (
                  <TableRow key={r.id}>
                    <TableTd className="text-text-secondary">{r.trigger}</TableTd>
                    <TableTd>
                      <Chip tone={runStateChip(r.status).tone} size="xs" dot={r.status === 'running' ? 'pulse' : undefined}>
                        {runStateChip(r.status).label}
                      </Chip>
                    </TableTd>
                    <TableTd className="whitespace-nowrap">
                      <CostVsEstimate costUsd={r.costUsd} estimate={runEstimate(r)} />
                    </TableTd>
                    <TableTd
                      className="text-text-secondary whitespace-nowrap"
                      title={dur.title}
                    >
                      {dur.text}
                    </TableTd>
                    <TableTd className="text-text-tertiary whitespace-nowrap" title={new Date(r.startedAt).toLocaleString()}>
                      {relativeTime(r.startedAt)}
                    </TableTd>
                    <TableTd className="max-w-[22rem]">
                      <Inline gap="sm" wrap={false} title={o.summary}>
                        {o.reason && (
                          r.status === 'failed'
                            ? <Chip tone="danger" size="xs">{o.reason}</Chip>
                            : <T as="span" tone="inherit" className="min-w-0 truncate">{o.reason}</T>
                        )}
                        {o.changeId && (
                          <Link to="/admin/changes" className="text-primary no-underline hover:underline">
                            change {o.changeId.slice(0, 8)}
                          </Link>
                        )}
                        {o.prUrl && (
                          <ExternalLink external href={o.prUrl} className="text-primary no-underline hover:underline">
                            PR ↗
                          </ExternalLink>
                        )}
                        {/* The run row carries no summary — that lives on the job
                            this firing enqueued. When there is no devbox run to
                            open, the job is the only place the detail exists, so
                            link it rather than leaving the cell a dead end. */}
                        {canLinkRun && (
                          <Link
                            to={`/admin/projects?project=${bot.agentProjectId}&run=${r.runId}`}
                            className="text-xs text-text-secondary no-underline hover:text-primary hover:underline font-mono"
                          >
                            run {r.runId!.slice(0, 8)}
                          </Link>
                        )}
                        {!canLinkRun && r.jobId && (
                          <Link
                            to={`/iq/work/${encodeURIComponent(r.jobId)}`}
                            title="Open the queued job this firing produced"
                            className="text-xs text-text-secondary no-underline hover:text-primary hover:underline font-mono"
                          >
                            job →
                          </Link>
                        )}
                        {o.filesChanged != null && (
                          <MetaLine size="xs" tone="tertiary" items={[`${o.filesChanged} ${o.filesChanged === 1 ? 'file' : 'files'}`]} />
                        )}
                        {!hasOutcome && (
                          <MetaLine size="xs" tone="tertiary" items={['—']} />
                        )}
                      </Inline>
                    </TableTd>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {hasMoreRuns && (
            <Inline justify="center" className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => setRunsLimit((l) => l + BOT_RUNS_PAGE_SIZE)}>
                Show {Math.min(BOT_RUNS_PAGE_SIZE, runs.length - visibleRuns.length)} more
              </Button>
            </Inline>
          )}

          {/* ── One firing as a pipeline Run: the trigger record, the queue
              job it became, its steps, what it left behind, its events. ── */}
          {pipelineError ? (
            <UnavailableNotice
              error={pipelineError}
              what="this bot's runs as pipeline runs"
              source="Runs are projected from bot_runs and agent_jobs"
              onRetry={refreshPipeline}
            />
          ) : pipelineRuns.length > 0 && (
            <Stack gap="sm">
              <DetailSection
                title="Run"
                hint="one firing, as a pipeline run"
                actions={(
                  <Select
                    aria-label="Pipeline run"
                    size="sm"
                    className="max-w-[280px]"
                    value={pipelineRunId ?? ''}
                    onChange={(e) => setPickedRunId(e.target.value)}
                    options={pipelineRuns.map((r) => ({
                      value: r.id,
                      label: `${r.context.id} · ${r.startedAt ? relativeTime(r.startedAt) : 'not started'}`,
                    }))}
                  />
                )}
                data-testid="pipeline-run"
              >
                {pipelineRun.run
                  ? <PipelineRunSummary run={pipelineRun.run} />
                  : <MetaLine size="sm" tone="tertiary" items={[pipelineRun.error ? `Could not load this run: ${pipelineRun.error}` : 'Loading run…']} />}
              </DetailSection>
              <DetailSection title="Steps" hint={`${pipelineRun.steps.length}`} data-testid="pipeline-steps">
                <PipelineRunSteps steps={pipelineRun.steps} />
              </DetailSection>
              <DetailSection title="Artifacts" hint={`${pipelineRun.artifacts.length}`} data-testid="pipeline-artifacts">
                <PipelineRunArtifacts artifacts={pipelineRun.artifacts} />
              </DetailSection>
              <DetailSection title="Events" data-testid="pipeline-events">
                <PipelineRunEvents eventsUrl={pipelineRun.eventsUrl} />
              </DetailSection>
            </Stack>
          )}
        </Stack>

        {/* ── THE MISSION ── */}
        <Stack hidden={tab !== 'mission'} gap="sm">
          {canManage && (
            <Inline justify="end">
              <Button variant="ghost" size="sm" onClick={() => { setMissionText(bot.prompt); setEditMission((v) => !v); }}>
                {editMission ? 'cancel' : 'edit'}
              </Button>
            </Inline>
          )}
          {editMission ? (
            <Stack gap="xs">
              <Textarea value={missionText} onChange={(e) => setMissionText(e.target.value)} minRows={6} />
              <Inline justify="end">
                <Button variant="primary" size="sm" disabled={busy === 'mission' || !missionText.trim()} onClick={() => void saveMission()}>
                  {busy === 'mission' ? 'saving…' : 'Save mission'}
                </Button>
              </Inline>
            </Stack>
          ) : (
            <Stack gap="none" className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
              {bot.prompt}
            </Stack>
          )}
        </Stack>

        {/* ── GUARDRAILS — standing configuration only. Today's run count and
            spend vs. budget are the roster row's job (Today / Budget
            columns); repeating them here was the exact duplication caught on
            local-compute's machine row vs. its connection panel. ── */}
        <Stack hidden={tab !== 'guardrails'} gap="sm">
          {canManage && (
            <Inline justify="end">
              <Button variant="ghost" size="sm" onClick={() => (editGuards ? setEditGuards(false) : beginEditGuards())}>
                {editGuards ? 'cancel' : 'edit'}
              </Button>
            </Inline>
          )}
          {editGuards ? (
            <Stack gap="sm">
              <FormField label="Model" layout="inline">
                {(wiring) => (
                  <Select {...inputWiring(wiring)} value={gModel} onChange={(e) => setGModel(e.target.value)} options={modelOptions} />
                )}
              </FormField>
              <FormField label="Budget / run ($)" layout="inline">
                {(wiring) => (
                  <Input {...inputWiring(wiring)} type="number" min={0} step="0.01" value={gPerRun} placeholder="none" onChange={(e) => setGPerRun(e.target.value)} />
                )}
              </FormField>
              <FormField label="Budget / day ($)" layout="inline">
                {(wiring) => (
                  <Input {...inputWiring(wiring)} type="number" min={0} step="0.01" value={gPerDay} placeholder="none" onChange={(e) => setGPerDay(e.target.value)} />
                )}
              </FormField>
              <FormField label="Max runs / day" layout="inline">
                {(wiring) => (
                  <Input {...inputWiring(wiring)} type="number" min={1} value={gMaxRuns} onChange={(e) => setGMaxRuns(Math.max(1, Number(e.target.value)))} />
                )}
              </FormField>
              <FormField label="Requires review" layout="inline">
                {(wiring) => (
                  <Checkbox {...inputWiring(wiring)} aria-labelledby={wiring.labelId} checked={gReview} onChange={setGReview} />
                )}
              </FormField>
              <FormField
                label="Enforce initiative allocation"
                layout="inline"
                hint="A cron fire that would push this initiative past its monthly allocation is skipped and retried next cycle. Off by default — a bot is the maintenance floor."
              >
                {(wiring) => (
                  <Checkbox {...inputWiring(wiring)} aria-labelledby={wiring.labelId} checked={gEnforceAlloc} onChange={setGEnforceAlloc} />
                )}
              </FormField>
              <Inline justify="end">
                <Button variant="primary" size="sm" disabled={busy === 'guards'} onClick={() => void saveGuards()}>
                  {busy === 'guards' ? 'saving…' : 'Save guardrails'}
                </Button>
              </Inline>
            </Stack>
          ) : (
            <Table>
              <TableBody>
                <TableRow>
                  <TableTd className="text-text-tertiary w-32">Model</TableTd>
                  <TableTd title={bot.model}>{modelLabel(bot.model)}</TableTd>
                </TableRow>
                <TableRow>
                  <TableTd className="text-text-tertiary">Budget / run</TableTd>
                  <TableTd>{bot.budgetPerRunUsd != null ? usd(bot.budgetPerRunUsd) : 'none (soft cap unset)'}</TableTd>
                </TableRow>
                <TableRow>
                  <TableTd className="text-text-tertiary">Budget / day</TableTd>
                  <TableTd>{bot.budgetPerDayUsd != null ? usd(bot.budgetPerDayUsd) : 'none (hard cap unset)'}</TableTd>
                </TableRow>
                <TableRow>
                  <TableTd className="text-text-tertiary">Max runs / day</TableTd>
                  <TableTd>{bot.maxRunsPerDay}</TableTd>
                </TableRow>
                <TableRow>
                  <TableTd className="text-text-tertiary">Requires review</TableTd>
                  <TableTd>{bot.requiresReview ? 'yes' : 'no'}</TableTd>
                </TableRow>
                <TableRow>
                  <TableTd className="text-text-tertiary">Enforce allocation</TableTd>
                  <TableTd title="When on, a cron fire that would push this initiative past its monthly allocation is skipped and retried next cycle.">
                    {botEnforceAllocation(bot) ? 'on — cron fires braked by allocation' : 'off (bot spend is the maintenance floor)'}
                  </TableTd>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </Stack>

        {/* ── LIVE ACTIVITY — the current run's execution timeline. Only a
            tab at all while a run is actually in flight; see the effect
            above that falls back to Runs once it finishes. ── */}
        {liveBoxId && (
          <Stack hidden={tab !== 'activity'} gap="none">
            <RunTimeline
              boxId={liveBoxId}
              title="LIVE ACTIVITY"
              maxHeightClass="max-h-[420px]"
              emptyHint="The run just started — Claude Code's tool calls stream here as it works."
              headerExtra={
                <Chip size="xs" tone="accent" dot="pulse" className="ml-auto">live</Chip>
              }
            />
          </Stack>
        )}
      </DetailSection>

      <ConfirmDialog
        open={confirmDelete}
        tone="destructive"
        title={`Delete ${bot.name}?`}
        body="The bot, its schedule, and its run history are removed. Changes it already shipped stay in the Changes queue and on GitHub."
        confirmLabel={busy === 'delete' ? 'Deleting…' : 'Delete bot'}
        confirmDisabled={busy === 'delete'}
        onConfirm={() => void deleteBot()}
        onCancel={() => setConfirmDelete(false)}
      />
    </PageSection>
  );
}
