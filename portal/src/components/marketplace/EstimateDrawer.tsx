// EstimateDrawer — the work marketplace's estimate → authorize flow.
//
// Opens from an "Estimate" chip on an open, pointed story or bug. Shows a cost
// and duration *range* (never a fake-precise single number) with the basis
// stated plainly, re-computes live as the model changes, and turns
// authorization into a ConfirmDialog that restates exactly what was estimated.
// Dispatch is the governed path: POST /api/bots/dispatch-work binds a run to
// the work item; a 409 with options means the initiative has several codebases
// and the server wants us to pick one.

import { useEffect, useState } from 'react';
import {
  Drawer,
  ConfirmDialog,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { DEVBOX_MODELS, DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import { toastError, toastSuccess } from '../../lib/toastStore';
import type { BotRun } from '../../pages/bots/BotsPage';

// ─── Types (the /api/bots/estimate contract) ─────────────────────────────────

export interface WorkEstimate {
  basis: 'repo' | 'model' | 'prior';
  sampleCount: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
  points: number;
  /** true → the range is per-point history × points; false → run-level history. */
  scaled: boolean;
}

export interface EstimateItem {
  id: string;
  title: string;
  type: string;
  storyPoints: number | null;
}

interface CodebaseOption {
  id: string;
  repoFullName: string;
}

export interface EstimateDrawerProps {
  open: boolean;
  onClose: () => void;
  item: EstimateItem | null;
  /** The codebases delivering this initiative — estimate context + 409 fallback. */
  codebases: CodebaseOption[];
  /** Called on 202 so the page can flip the item to in_progress optimistically. */
  onDispatched: (workItemId: string, run: BotRun) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function rangeText(est: WorkEstimate): string {
  return `${money(est.costUsdP25)}–${money(est.costUsdP75)} · ${Math.round(est.minutesP25)}–${Math.round(est.minutesP75)} min`;
}

/** The estimate echoed at authorize time on a run's outcome, when present.
    BotRun.outcome doesn't declare it (the type lives in BotsPage), so read it
    through a narrow cast here — one place that knows the wire shape. */
export function runEstimate(run: Pick<BotRun, 'outcome'>): WorkEstimate | undefined {
  return (run.outcome as { estimate?: WorkEstimate } | undefined)?.estimate;
}

/** An actual cost against its authorize-time estimate: the actual tints danger
    when it ran over p75 and success when it came in under p25, with the range
    appended muted. Falls back to a plain actual (or —) without an estimate. */
export function CostVsEstimate({ costUsd, estimate }: { costUsd: number | null; estimate: WorkEstimate | undefined }) {
  if (costUsd == null) return <span className="text-text-tertiary whitespace-nowrap">—</span>;
  const actual = `$${costUsd.toFixed(4)}`;
  if (!estimate) return <span className="text-text-tertiary whitespace-nowrap">{actual}</span>;
  const over = costUsd > estimate.costUsdP75;
  const under = costUsd < estimate.costUsdP25;
  const range = `${money(estimate.costUsdP25)}–${money(estimate.costUsdP75)}`;
  const title = over
    ? `Actual ${actual} ran over the authorize-time estimate (${range}, p25–p75)`
    : under
      ? `Actual ${actual} came in under the authorize-time estimate (${range}, p25–p75)`
      : `Actual ${actual} landed inside the authorize-time estimate (${range}, p25–p75)`;
  return (
    <span className="whitespace-nowrap" title={title}>
      <span className={over ? 'text-danger' : under ? 'text-success' : 'text-text-tertiary'}>{actual}</span>
      <span className="text-text-tertiary opacity-70"> est {range}</span>
    </span>
  );
}

/** The basis, stated plainly — exact copy per the estimate contract. */
export function estimateLine(est: WorkEstimate): string {
  if (est.scaled) {
    return `≈ ${rangeText(est)} for ${est.points} points — based on ${est.sampleCount} pointed runs ${est.basis === 'repo' ? 'on this codebase' : 'with this model'}`;
  }
  if (est.basis !== 'prior') {
    return `Similar runs: ${rangeText(est)} (${est.sampleCount} runs — not point-scaled yet)`;
  }
  return 'No history yet — prior for this model tier, wide range';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function EstimateDrawer({ open, onClose, item, codebases, onDispatched }: EstimateDrawerProps) {
  const [model, setModel] = useState<string>(DEFAULT_DEVBOX_MODEL);
  const [instruction, setInstruction] = useState('');
  const [agentProjectId, setAgentProjectId] = useState<string | null>(null);

  const [estimate, setEstimate] = useState<WorkEstimate | null>(null);
  const [estLoading, setEstLoading] = useState(false);
  const [estError, setEstError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  /** Set from a 409 — the server wants a codebase picked before it will run. */
  const [pickerOptions, setPickerOptions] = useState<CodebaseOption[] | null>(null);
  /** Set from a 429 — the platform's agent-run concurrency ceiling is full. */
  const [concurrencyMsg, setConcurrencyMsg] = useState<string | null>(null);

  // Reset per item — a fresh drawer for each estimate.
  const itemId = item?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setModel(DEFAULT_DEVBOX_MODEL);
    setInstruction('');
    setPickerOptions(null);
    setConcurrencyMsg(null);
    setConfirmOpen(false);
    setAgentProjectId(codebases.length === 1 ? codebases[0]!.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  // Live estimate — on open and whenever the model or target codebase changes.
  useEffect(() => {
    if (!open || !item || item.storyPoints == null) return;
    let cancelled = false;
    setEstLoading(true);
    setEstError(null);
    const params = new URLSearchParams({ model, points: String(item.storyPoints) });
    if (agentProjectId) params.set('agentProjectId', agentProjectId);
    fetch(`/api/bots/estimate?${params.toString()}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<WorkEstimate>;
      })
      .then((est) => { if (!cancelled) { setEstimate(est); setEstLoading(false); } })
      .catch((err: Error) => {
        if (!cancelled) { setEstimate(null); setEstError(err.message); setEstLoading(false); }
      });
    return () => { cancelled = true; };
  }, [open, item, model, agentProjectId]);

  async function dispatch(overrideAgentProjectId?: string) {
    if (!item || dispatching) return;
    setDispatching(true);
    setConcurrencyMsg(null);
    try {
      const target = overrideAgentProjectId ?? agentProjectId;
      const body: Record<string, unknown> = { workItemId: item.id, model };
      if (target) body['agentProjectId'] = target;
      if (instruction.trim()) body['instruction'] = instruction.trim();
      const res = await fetch('/api/bots/dispatch-work', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({})) as {
        run?: BotRun; error?: string; options?: CodebaseOption[];
      };
      if (res.status === 409 && payload.options && payload.options.length > 0) {
        // Multiple codebases deliver this initiative — pick one and retry.
        setPickerOptions(payload.options);
        setConfirmOpen(false);
        return;
      }
      if (res.status === 429) {
        // Concurrency ceiling — no picker, just say so plainly inline.
        setConcurrencyMsg(payload.error ?? 'Agent runs already in flight are at the concurrency ceiling');
        setConfirmOpen(false);
        return;
      }
      if (!res.ok || !payload.run) throw new Error(payload.error ?? `HTTP ${res.status}`);
      toastSuccess(null, 'Agent dispatched', `"${item.title}" is in progress — watch it on its row or in Computers.`);
      setConfirmOpen(false);
      onDispatched(item.id, payload.run);
      onClose();
    } catch (err) {
      setConfirmOpen(false);
      toastError(null, 'Dispatch failed', (err as Error).message);
    } finally {
      setDispatching(false);
    }
  }

  if (!item) return null;

  const modelLabel = DEVBOX_MODELS.find((m) => m.id === model)?.label ?? model;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Estimate & authorize"
        subtitle="A governed agent run, bound to this work item — its change still passes review."
        footer={
          <div className="flex items-center gap-2 w-full">
            <span className="text-[11px] text-text-tertiary flex-1">
              {estimate ? `model: ${modelLabel}` : ''}
            </span>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-secondary cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={estLoading || estimate == null || dispatching}
              className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
            >
              {dispatching ? 'dispatching…' : 'Authorize'}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* The work item under estimate */}
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <Chip tone={item.type === 'bug' ? 'danger' : 'info'} size="xs">{item.type}</Chip>
              <span className="text-[13px] font-semibold text-text-primary">{item.title}</span>
            </div>
            <div className="mt-1 text-[11px] text-text-tertiary">
              {item.storyPoints != null ? `${item.storyPoints} ${item.storyPoints === 1 ? 'point' : 'points'}` : 'unpointed'}
            </div>
          </div>

          {/* Model — the estimate recomputes live as this changes */}
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            <span className="font-semibold">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
            >
              {DEVBOX_MODELS.map((m) => (
                <option key={m.id} value={m.id} title={m.hint}>{m.label} — {m.hint}</option>
              ))}
            </select>
          </label>

          {/* Target codebase — optional; the server 409s if it needs a pick */}
          {codebases.length > 1 && (
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              <span className="font-semibold">Codebase</span>
              <select
                value={agentProjectId ?? ''}
                onChange={(e) => setAgentProjectId(e.target.value || null)}
                className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary font-mono"
              >
                <option value="">choose at dispatch</option>
                {codebases.map((cb) => (
                  <option key={cb.id} value={cb.id}>{cb.repoFullName}</option>
                ))}
              </select>
            </label>
          )}

          {/* The estimate — always a range, with its basis stated plainly */}
          <div className="px-3 py-2.5 rounded-md border border-border bg-surface-inset">
            <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide mb-1">Estimate</div>
            {estLoading ? (
              <div className="text-[12px] text-text-tertiary">estimating…</div>
            ) : estError ? (
              <div className="text-[12px] text-danger">Estimate unavailable: {estError}</div>
            ) : estimate ? (
              <>
                <div className="text-[13px] text-text-primary leading-relaxed">{estimateLine(estimate)}</div>
                {estimate.basis === 'prior' && (
                  <div className="mt-1 text-[11px] text-text-tertiary">≈ {rangeText(estimate)}</div>
                )}
              </>
            ) : (
              <div className="text-[12px] text-text-tertiary">—</div>
            )}
          </div>

          {/* Optional one-shot steering, without editing any standing mission */}
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            <span className="font-semibold">Instruction <span className="font-normal text-text-tertiary">(optional, this run only)</span></span>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder="e.g. 'prefer the existing retry helper — do not add a new dependency'"
              className="w-full px-2.5 py-2 rounded-md border border-border bg-surface text-[12px] text-text-primary resize-y box-border"
            />
          </label>

          {/* 429 — the concurrency ceiling is full; wait or raise it */}
          {concurrencyMsg && (
            <div className="px-3 py-2.5 rounded-md border border-danger/50 bg-danger-bg/40">
              <div className="text-[12px] font-semibold text-danger mb-0.5">Concurrency ceiling reached</div>
              <div className="text-[12px] text-text-primary leading-relaxed">
                {concurrencyMsg} — raise <code className="font-mono text-[11px]">BOT_MAX_CONCURRENT</code> or
                wait for a run to finish, then authorize again.
              </div>
            </div>
          )}

          {/* 409 fallback — the server wants a codebase before it will run */}
          {pickerOptions && (
            <div className="px-3 py-2.5 rounded-md border border-warning/50 bg-warning-bg/40">
              <div className="text-[12px] text-text-primary font-semibold mb-1.5">
                Several codebases deliver this initiative — pick where the agent works:
              </div>
              <div className="flex flex-col gap-1.5">
                {pickerOptions.map((o) => (
                  <button
                    key={o.id}
                    disabled={dispatching}
                    onClick={() => {
                      setAgentProjectId(o.id);
                      setPickerOptions(null);
                      void dispatch(o.id);
                    }}
                    className="px-2.5 py-1.5 rounded-md border border-border bg-surface text-[12px] font-mono text-text-primary cursor-pointer text-left hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {o.repoFullName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        tone="caution"
        title="Authorize agent run?"
        body={
          estimate
            ? `${estimateLine(estimate)}. The run uses ${modelLabel}, is bound to "${item.title}", and every change it makes still passes the review queue.`
            : `Dispatch "${item.title}" to an agent on ${modelLabel}? Every change it makes still passes the review queue.`
        }
        confirmLabel={dispatching ? 'Dispatching…' : 'Authorize run'}
        confirmDisabled={dispatching}
        onConfirm={() => void dispatch()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export default EstimateDrawer;
