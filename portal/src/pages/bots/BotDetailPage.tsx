// Bot detail — where you live with a bot: watch the current run live, read the
// mission, tune the guardrails, and audit every firing with its cost and
// outcome. Controls are deliberately few — Run now, Pause/Resume, Delete —
// because the interesting decisions (approve, deliver) stay where governance
// already lives, in the Changes queue.

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Banner,
  Button,
  Card,
  CardHeader,
  CatalogGrid,
  Checkbox,
  Chip,
  ConfirmDialog,
  FormField,
  Inline,
  Input,
  Link as ExternalLink,
  MetaLine,
  PageSection,
  ProgressBar,
  Select,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { CostVsEstimate, runEstimate } from '../../components/marketplace/EstimateDrawer';
import { RunTimeline } from '../../components/runs/RunTimeline';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp';
import { botRunSummary, inputWiring, lastRanText } from './botsFormat';
import { TEMPLATE_TONE, triggerSummary, when, type Bot, type BotRun } from './BotsPage';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RUN_STATUS_TONE: Record<BotRun['status'], 'warning' | 'success' | 'danger' | 'neutral'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

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
  const running = runs.some((r) => r.status === 'running');
  if (running !== anyRunning) setAnyRunning(running);

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

  async function patchBot(patch: Record<string, unknown>): Promise<boolean> {
    if (!bot) return false;
    try {
      const res = await fetch(`/api/bots/${bot.id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      refreshBot();
      return true;
    } catch (err) {
      toastError(null, 'Update failed', (err as Error).message);
      return false;
    }
  }

  async function runNow() {
    if (!bot || busy) return;
    setBusy('run');
    try {
      const res = await fetch(`/api/bots/${bot.id}/run`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (res.status === 409) {
        toastError(null, 'Not run', body.error ?? 'The bot refused this run (budget or run cap reached).');
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(null, 'Run started', 'It streams below as it works.');
      setRunOpen(false); setInstruction('');
      refreshRuns(); refreshBot();
    } catch (err) {
      toastError(null, 'Could not start', (err as Error).message);
    } finally { setBusy(null); }
  }

  async function pauseOrResume() {
    if (!bot || busy) return;
    // Mirror the roster's definition of paused: operator-disabled OR
    // self-paused. Resume clears both server-side.
    const isPaused = !bot.enabled || bot.pausedReason != null;
    const action = isPaused ? 'resume' : 'pause';
    setBusy(action);
    try {
      const res = await fetch(`/api/bots/${bot.id}/${action}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(null, action === 'pause' ? 'Paused' : 'Resumed');
      refreshBot();
    } catch (err) {
      toastError(null, `Could not ${action}`, (err as Error).message);
    } finally { setBusy(null); }
  }

  async function deleteBot() {
    if (!bot || busy) return;
    setBusy('delete');
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'DELETE', credentials: 'include' });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(null, 'Bot deleted', `${bot.name} and its run history are gone.`);
      navigate('/admin/bots');
    } catch (err) {
      toastError(null, 'Could not delete', (err as Error).message);
      setConfirmDelete(false);
    } finally { setBusy(null); }
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
    });
    setBusy(null);
    if (ok) setEditGuards(false);
  }

  async function saveMission() {
    if (!missionText.trim()) return;
    setBusy('mission');
    const ok = await patchBot({ prompt: missionText.trim() });
    setBusy(null);
    if (ok) setEditMission(false);
  }

  if (botError) {
    return (
      <PageSection title="Bot">
        <Card padding="md">
          <Stack gap="xs">
            <Banner variant="error">Failed to load bot: {botError}</Banner>
            <Link to="/admin/bots" className="text-[12px] text-primary no-underline hover:underline">← Bots</Link>
          </Stack>
        </Card>
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
  // Derived from the SAME `runs` array the RUNS table below renders, so the
  // header and the table can never disagree about whether this bot has ever
  // fired (DEFECTS.md program-owner #9) — `bot.lastRunAt`/`todayRunCount` are
  // a separate summary that can drift from (or, in dev:mock, never match)
  // the actual run history.
  const runSummary = botRunSummary(runs);
  const modelOptions = [
    ...DEVBOX_MODELS.map((m) => ({ value: m.id, label: m.label })),
    ...(!DEVBOX_MODELS.some((m) => m.id === gModel) && gModel ? [{ value: gModel, label: gModel }] : []),
  ];

  return (
    <PageSection title={bot.name}>
      {/* ── Header: identity + state + controls ── */}
      <Card padding="sm" className="mb-4">
        <Inline gap="sm" wrap align="center" justify="between">
          <Inline gap="sm" wrap align="center">
            <Link to="/admin/bots" className="text-[12px] text-primary no-underline hover:underline shrink-0">← Bots</Link>
            <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>
            {paused ? (
              <Chip tone="warning" size="xs" dot="static" title={bot.pausedReason ?? undefined}>paused</Chip>
            ) : (
              <Chip tone="success" size="xs" dot="static">enabled</Chip>
            )}
            <MetaLine
              size="xs" tone="tertiary"
              items={[
                triggerSummary(bot),
                lastRanText(runs, when),
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

      {/* ── LIVE ACTIVITY — the current run's execution timeline ── */}
      {liveBoxId && (
        <Stack gap="none" className="mb-4">
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

      {/* ── Runs — first, because "what did this bot do lately" is the
          question this page exists to answer; the mission and guardrails
          that shaped those runs follow. ── */}
      <Card padding="none" className="mb-4 overflow-hidden">
        <CardHeader inset title="Runs" />
        <Stack gap="none" className="p-3.5">
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
              {runs.map((r) => {
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
                  <TableTd className="text-[12px] text-text-secondary">{r.trigger}</TableTd>
                  <TableTd>
                    <Chip tone={RUN_STATUS_TONE[r.status]} size="xs" dot={r.status === 'running' ? 'pulse' : undefined}>
                      {r.status}
                    </Chip>
                  </TableTd>
                  <TableTd className="text-[12px] whitespace-nowrap">
                    <CostVsEstimate costUsd={r.costUsd} estimate={runEstimate(r)} />
                  </TableTd>
                  <TableTd
                    className="text-[12px] text-text-secondary whitespace-nowrap"
                    title={dur.title}
                  >
                    {dur.text}
                  </TableTd>
                  <TableTd className="text-[12px] text-text-tertiary whitespace-nowrap" title={r.startedAt}>
                    {when(r.startedAt)}
                  </TableTd>
                  <TableTd>
                    <Inline gap="sm" wrap className="text-[12px]" title={o.summary}>
                      {o.reason && (
                        r.status === 'failed'
                          ? <Chip tone="danger" size="xs">{o.reason}</Chip>
                          : o.reason
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
                          className="text-text-secondary no-underline hover:text-primary hover:underline font-mono text-[11px]"
                        >
                          run {r.runId!.slice(0, 8)}
                        </Link>
                      )}
                      {!canLinkRun && r.jobId && (
                        <Link
                          to={`/iq/work/${encodeURIComponent(r.jobId)}`}
                          title="Open the queued job this firing produced"
                          className="text-text-secondary no-underline hover:text-primary hover:underline font-mono text-[11px]"
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
        </Stack>
      </Card>

      <CatalogGrid columns={2} className="mb-4 items-start">
        {/* ── THE MISSION ── */}
        <Card padding="none" className="overflow-hidden">
          <CardHeader
            inset
            title="The mission"
            action={canManage && (
              <Button variant="ghost" size="sm" onClick={() => { setMissionText(bot.prompt); setEditMission((v) => !v); }}>
                {editMission ? 'cancel' : 'edit'}
              </Button>
            )}
          />
          {editMission ? (
            <Stack gap="xs" className="p-3.5">
              <Textarea value={missionText} onChange={(e) => setMissionText(e.target.value)} minRows={6} />
              <Inline justify="end">
                <Button variant="primary" size="sm" disabled={busy === 'mission' || !missionText.trim()} onClick={() => void saveMission()}>
                  {busy === 'mission' ? 'saving…' : 'Save mission'}
                </Button>
              </Inline>
            </Stack>
          ) : (
            <Stack gap="none" className="px-3.5 py-3 text-[12.5px] text-text-primary leading-relaxed whitespace-pre-wrap">
              {bot.prompt}
            </Stack>
          )}
        </Card>

        {/* ── GUARDRAILS ── */}
        <Card padding="none" className="overflow-hidden">
          <CardHeader
            inset
            title="Guardrails"
            action={canManage && (
              <Button variant="ghost" size="sm" onClick={() => (editGuards ? setEditGuards(false) : beginEditGuards())}>
                {editGuards ? 'cancel' : 'edit'}
              </Button>
            )}
          />
          {editGuards ? (
            <Stack gap="sm" className="p-3.5">
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
            <Stack gap="none">
              <Table>
                <TableBody>
                  <TableRow>
                    <TableTd className="text-text-tertiary w-32">Model</TableTd>
                    <TableTd title={bot.model}>{modelLabel(bot.model)}</TableTd>
                  </TableRow>
                  <TableRow>
                    <TableTd className="text-text-tertiary">Budget / run</TableTd>
                    <TableTd>{bot.budgetPerRunUsd != null ? `$${bot.budgetPerRunUsd.toFixed(2)}` : 'none (soft cap unset)'}</TableTd>
                  </TableRow>
                  <TableRow>
                    <TableTd className="text-text-tertiary">Budget / day</TableTd>
                    <TableTd>{bot.budgetPerDayUsd != null ? `$${bot.budgetPerDayUsd.toFixed(2)}` : 'none (hard cap unset)'}</TableTd>
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
              <Stack gap="xs" className="px-3.5 py-2.5">
                <MetaLine
                  size="xs" tone="tertiary"
                  items={[
                    `today: ${runSummary.todayRunCount}/${bot.maxRunsPerDay} ${runSummary.todayRunCount === 1 ? 'run' : 'runs'}`,
                    `$${bot.todaySpendUsd.toFixed(2)}${bot.budgetPerDayUsd != null ? ` of $${bot.budgetPerDayUsd.toFixed(2)}` : ' spent'}`,
                  ]}
                />
                {bot.budgetPerDayUsd != null && bot.budgetPerDayUsd > 0 && (
                  <ProgressBar
                    value={Math.min(bot.todaySpendUsd, bot.budgetPerDayUsd)}
                    max={bot.budgetPerDayUsd}
                    size="sm"
                    showRatio={false}
                    color={bot.todaySpendUsd >= bot.budgetPerDayUsd * 0.8 ? 'var(--color-warning)' : undefined}
                    aria-label="Today's spend vs daily budget"
                  />
                )}
              </Stack>
            </Stack>
          )}
        </Card>
      </CatalogGrid>

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
