// Bot detail — where you live with a bot: watch the current run live, read the
// mission, tune the guardrails, and audit every firing with its cost and
// outcome. Controls are deliberately few — Run now, Pause/Resume, Delete —
// because the interesting decisions (approve, deliver) stay where governance
// already lives, in the Changes queue.

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  PageSection,
  Card,
  Chip,
  ProgressBar,
  ConfirmDialog,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { CostVsEstimate, runEstimate } from '../../components/marketplace/EstimateDrawer';
import { RunTimeline } from '../../components/runs/RunTimeline';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import { TEMPLATE_TONE, triggerSummary, when, type Bot, type BotRun } from './BotsPage';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RUN_STATUS_TONE: Record<BotRun['status'], 'warning' | 'success' | 'danger' | 'neutral'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

function parseTs(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
}

function runDuration(r: BotRun): string {
  if (!r.finishedAt) return r.status === 'running' ? '…' : '—';
  const ms = parseTs(r.finishedAt) - parseTs(r.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

function modelLabel(id: string): string {
  return DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BotDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  const { data: botData, error: botError, refresh: refreshBot } =
    useFetch<{ bot: Bot }>(id ? `/api/bots/${id}` : null, 15_000);
  const bot = botData?.bot ?? null;

  // Runs poll fast while one is in flight, lazily otherwise.
  const [anyRunning, setAnyRunning] = useState(false);
  const { data: runsData, refresh: refreshRuns } =
    useFetch<{ runs: BotRun[] }>(id ? `/api/bots/${id}/runs` : null, anyRunning ? 5_000 : 15_000);
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
          <div className="text-[12px] text-danger">Failed to load bot: {botError}</div>
          <Link to="/admin/bots" className="text-[12px] text-primary no-underline hover:underline">← Bots</Link>
        </Card>
      </PageSection>
    );
  }
  if (!bot) {
    return (
      <PageSection title="Bot">
        <div className="text-[12px] text-text-tertiary">Loading…</div>
      </PageSection>
    );
  }

  const paused = !bot.enabled || bot.pausedReason != null;

  return (
    <PageSection title={bot.name}>
      {/* ── Header: identity + state + controls ── */}
      <Card padding="sm" className="mb-4">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Link to="/admin/bots" className="text-[12px] text-primary no-underline hover:underline shrink-0">← Bots</Link>
          <Chip tone={TEMPLATE_TONE[bot.template]} size="xs">{bot.template}</Chip>
          {paused ? (
            <Chip tone="warning" size="xs" dot="static" title={bot.pausedReason ?? undefined}>paused</Chip>
          ) : (
            <Chip tone="success" size="xs" dot="static">enabled</Chip>
          )}
          <span className="text-[11px] text-text-tertiary">{triggerSummary(bot)} · last ran {when(bot.lastRunAt)}</span>
          <div className="flex-1" />
          {canManage && (
            <>
              <button
                onClick={() => setRunOpen((v) => !v)}
                className="px-2.5 py-1 rounded-md border-none bg-primary text-white text-[11px] font-semibold cursor-pointer"
              >
                {runOpen ? 'Cancel' : '▶ Run now'}
              </button>
              <button
                onClick={() => void pauseOrResume()}
                disabled={busy === 'pause' || busy === 'resume'}
                className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
              >
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:text-danger hover:border-danger/50 transition-colors"
              >
                Delete
              </button>
            </>
          )}
        </div>
        {paused && bot.pausedReason && (
          <div className="mt-2 px-3 py-1.5 rounded bg-warning-bg/40 text-[11px] text-warning">{bot.pausedReason}</div>
        )}
        {runOpen && (
          <div className="mt-2.5 border-t border-border pt-2.5">
            <textarea
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runNow(); }}
              rows={2}
              placeholder="Optional one-shot instruction for this run — e.g. 'focus on the auth module'. Leave empty to run the mission as written."
              className="w-full px-2.5 py-2 rounded-md border border-border bg-surface text-[12px] text-text-primary resize-y box-border"
            />
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[11px] text-text-tertiary flex-1">⌘⏎ to run</span>
              <button
                onClick={() => void runNow()}
                disabled={busy === 'run'}
                className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
              >
                {busy === 'run' ? 'starting…' : 'Run'}
              </button>
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4 items-start">
        {/* ── THE MISSION ── */}
        <Card padding="none" className="overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
            <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">THE MISSION</span>
            <div className="flex-1" />
            {canManage && (
              <button
                onClick={() => { setMissionText(bot.prompt); setEditMission((v) => !v); }}
                className="text-[11px] px-2 py-0.5 rounded border border-border bg-surface text-text-secondary cursor-pointer hover:text-primary"
              >
                {editMission ? 'cancel' : 'edit'}
              </button>
            )}
          </div>
          {editMission ? (
            <div className="p-3.5">
              <textarea
                value={missionText}
                onChange={(e) => setMissionText(e.target.value)}
                rows={6}
                className="w-full px-2.5 py-2 rounded-md border border-border bg-surface text-[12px] text-text-primary resize-y box-border"
              />
              <div className="flex justify-end mt-1.5">
                <button
                  onClick={() => void saveMission()}
                  disabled={busy === 'mission' || !missionText.trim()}
                  className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
                >
                  {busy === 'mission' ? 'saving…' : 'Save mission'}
                </button>
              </div>
            </div>
          ) : (
            <div className="px-3.5 py-3 text-[12.5px] text-text-primary leading-relaxed whitespace-pre-wrap">
              {bot.prompt}
            </div>
          )}
        </Card>

        {/* ── GUARDRAILS ── */}
        <Card padding="none" className="overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
            <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">GUARDRAILS</span>
            <div className="flex-1" />
            {canManage && (
              <button
                onClick={() => (editGuards ? setEditGuards(false) : beginEditGuards())}
                className="text-[11px] px-2 py-0.5 rounded border border-border bg-surface text-text-secondary cursor-pointer hover:text-primary"
              >
                {editGuards ? 'cancel' : 'edit'}
              </button>
            )}
          </div>
          {editGuards ? (
            <div className="p-3.5 flex flex-col gap-2.5">
              <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                <span className="w-32 shrink-0">Model</span>
                <select
                  value={gModel}
                  onChange={(e) => setGModel(e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
                >
                  {DEVBOX_MODELS.map((m) => <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>)}
                  {!DEVBOX_MODELS.some((m) => m.id === gModel) && gModel && (
                    <option value={gModel}>{gModel}</option>
                  )}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                <span className="w-32 shrink-0">Budget / run ($)</span>
                <input
                  type="number" min={0} step="0.01" value={gPerRun} placeholder="none"
                  onChange={(e) => setGPerRun(e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
                />
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                <span className="w-32 shrink-0">Budget / day ($)</span>
                <input
                  type="number" min={0} step="0.01" value={gPerDay} placeholder="none"
                  onChange={(e) => setGPerDay(e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
                />
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                <span className="w-32 shrink-0">Max runs / day</span>
                <input
                  type="number" min={1} value={gMaxRuns}
                  onChange={(e) => setGMaxRuns(Math.max(1, Number(e.target.value)))}
                  className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
                />
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer select-none">
                <span className="w-32 shrink-0">Requires review</span>
                <input type="checkbox" checked={gReview} onChange={(e) => setGReview(e.target.checked)} />
              </label>
              <div className="flex justify-end">
                <button
                  onClick={() => void saveGuards()}
                  disabled={busy === 'guards'}
                  className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
                >
                  {busy === 'guards' ? 'saving…' : 'Save guardrails'}
                </button>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border text-[12px]">
              <div className="px-3.5 py-2 flex items-center gap-2">
                <span className="text-text-tertiary w-32 shrink-0">Model</span>
                <span className="text-text-primary" title={bot.model}>{modelLabel(bot.model)}</span>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-2">
                <span className="text-text-tertiary w-32 shrink-0">Budget / run</span>
                <span className="text-text-primary">{bot.budgetPerRunUsd != null ? `$${bot.budgetPerRunUsd.toFixed(2)}` : 'none (soft cap unset)'}</span>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-2">
                <span className="text-text-tertiary w-32 shrink-0">Budget / day</span>
                <span className="text-text-primary">{bot.budgetPerDayUsd != null ? `$${bot.budgetPerDayUsd.toFixed(2)}` : 'none (hard cap unset)'}</span>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-2">
                <span className="text-text-tertiary w-32 shrink-0">Max runs / day</span>
                <span className="text-text-primary">{bot.maxRunsPerDay}</span>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-2">
                <span className="text-text-tertiary w-32 shrink-0">Requires review</span>
                <span className="text-text-primary">{bot.requiresReview ? 'yes' : 'no'}</span>
              </div>
              <div className="px-3.5 py-2.5">
                <div className="text-[11px] text-text-tertiary mb-1">
                  today: {bot.todayRunCount}/{bot.maxRunsPerDay} {bot.todayRunCount === 1 ? 'run' : 'runs'}
                  {' · '}${bot.todaySpendUsd.toFixed(2)}
                  {bot.budgetPerDayUsd != null ? ` of $${bot.budgetPerDayUsd.toFixed(2)}` : ' spent'}
                </div>
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
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ── LIVE ACTIVITY — the current run's execution timeline ── */}
      {liveBoxId && (
        <div className="mb-4">
          <RunTimeline
            boxId={liveBoxId}
            title="LIVE ACTIVITY"
            maxHeightClass="max-h-[420px]"
            emptyHint="The run just started — Claude Code's tool calls stream here as it works."
            headerExtra={
              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-primary ml-auto">
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-primary" style={{ animation: 'runtl-pulse 1s ease-in-out infinite' }} />
                live
              </span>
            }
          />
        </div>
      )}

      {/* ── Runs ── */}
      <Card padding="md">
        <div className="text-xs font-semibold text-text-secondary tracking-wide select-none mb-2">RUNS</div>
        {runs.length === 0 ? (
          <div className="text-[12px] text-text-tertiary py-2">
            This bot has never fired. Use ▶ Run now, or wait for its trigger.
          </div>
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
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{r.trigger}</TableTd>
                  <TableTd>
                    <Chip tone={RUN_STATUS_TONE[r.status]} size="xs" dot={r.status === 'running' ? 'pulse' : undefined}>
                      {r.status}
                    </Chip>
                  </TableTd>
                  <TableTd style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    <CostVsEstimate costUsd={r.costUsd} estimate={runEstimate(r)} />
                  </TableTd>
                  <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{runDuration(r)}</TableTd>
                  <TableTd style={{ fontSize: 12, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }} title={r.startedAt}>
                    {when(r.startedAt)}
                  </TableTd>
                  <TableTd>
                    <div className="flex items-center gap-2 flex-wrap text-[12px]" title={r.outcome?.summary}>
                      {r.status === 'skipped' && r.outcome?.reason && (
                        <span className="text-text-tertiary">{r.outcome.reason}</span>
                      )}
                      {r.outcome?.changeId && (
                        <Link to="/admin/changes" className="text-primary no-underline hover:underline">
                          change {r.outcome.changeId.slice(0, 8)}
                        </Link>
                      )}
                      {r.outcome?.prUrl && (
                        <a
                          href={r.outcome.prUrl} target="_blank" rel="noopener noreferrer"
                          className="text-primary no-underline hover:underline inline-flex items-center gap-1"
                        >
                          PR <span aria-hidden="true" className="text-[10px]">↗</span>
                        </a>
                      )}
                      {r.runId && bot.agentProjectId && (
                        <Link
                          to={`/admin/projects?project=${bot.agentProjectId}&run=${r.runId}`}
                          className="text-text-secondary no-underline hover:text-primary hover:underline font-mono text-[11px]"
                        >
                          run {r.runId.slice(0, 8)}
                        </Link>
                      )}
                      {r.outcome?.filesChanged != null && (
                        <span className="text-text-tertiary text-[11px]">
                          {r.outcome.filesChanged} {r.outcome.filesChanged === 1 ? 'file' : 'files'}
                        </span>
                      )}
                    </div>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

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
