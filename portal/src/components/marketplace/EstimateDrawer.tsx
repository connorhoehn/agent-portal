// EstimateDrawer — the work marketplace's estimate → authorize flow.
//
// Opens from an "Estimate" chip on an open, pointed story or bug. Shows a cost
// and duration *range* (never a fake-precise single number) with the basis
// stated plainly, re-computes live as the model changes, and turns
// authorization into a ConfirmDialog that restates exactly what was estimated.
// Dispatch is the governed path: POST /api/bots/dispatch-work binds a run to
// the work item; a 409 with options means the initiative has several codebases
// and the server wants us to pick one.
//
// ── Four different 409s ──────────────────────────────────────────────────────
// The server can refuse a dispatch four ways, and each is a different question
// for the operator, so each gets its own affordance rather than a shared error
// toast. They are told apart by `gate` on the body (with `options` for the
// codebase pick, which predates the discriminator):
//
//   options       several codebases deliver this initiative — pick one.
//   run-budget    the operator's OWN cap on this run, set in this drawer.
//   allocation    the initiative's monthly allocation, set by a release manager.
//   envelope      the operator's sprint envelope, granted to them.
//
// Each carries its own confirm flag and this drawer sends only that flag —
// confirming your own cap must never quietly confirm somebody else's fence.
// Confirmations ACCUMULATE across a chain (cap → allocation → envelope): a
// retry that dropped an earlier confirmation would trip the same gate again and
// loop the operator through the same dialog forever.

import { useEffect, useRef, useState } from 'react';
import {
  Drawer,
  ConfirmDialog,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { DEVBOX_MODELS, DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import type { BotRun } from '../../pages/bots/BotsPage';

// ─── Types (the /api/bots/estimate contract) ─────────────────────────────────

/** How much a forecast is entitled to claim. 'scaled' is per-point history ×
    points; 'run-history' is real runs but not sized to this item; 'prior' is a
    static per-tier bracket. Optional because estimates echoed onto older runs
    predate the field. */
export type ForecastConfidence = 'scaled' | 'run-history' | 'prior';

export interface WorkEstimate {
  basis: 'repo' | 'model' | 'prior';
  sampleCount: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
  points: number | null;
  /** true → the range is per-point history × points; false → run-level history. */
  scaled: boolean;
  confidence?: ForecastConfidence;
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

export interface OverAllocation {
  reason: string;
  confidence?: ForecastConfidence;
  estimate?: WorkEstimate;
  allocatedUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

/** What the allocation brake stopped, in the operator's terms: the money
    first, because that is the decision — then how much the forecast behind the
    refusal is actually worth. The brake now fires on weak forecasts too (it
    could not fire at all before, on any initiative without sized run history),
    so a refusal built on a wide prior must not be dressed as a measurement.
    Say "wide prior" and the next refusal still gets read. */
export function overAllocationBody(over: OverAllocation): string {
  const ledger = `${money(over.spentUsd)} of ${money(over.allocatedUsd)} is already spent this month, leaving ${money(over.remainingUsd)}.`;
  const est = over.estimate;
  if (!est) {
    // No forecast on the wire: use the server's claim, minus the remedy half,
    // which names an API flag rather than anything reachable from here.
    return `${ledger} ${over.reason.split(' — ')[0]}. Dispatching anyway spends over the allocation.`;
  }
  const range = `${money(est.costUsdP25)}–${money(est.costUsdP75)}`;
  const forecast =
    over.confidence === 'prior'
      ? `This run is forecast at ${range}, but nothing has run on this model here yet — that range is a deliberately wide prior, not a measurement.`
      : over.confidence === 'run-history'
        ? `This run is forecast at ${range} from ${est.sampleCount} run${est.sampleCount === 1 ? '' : 's'} of run-level history — a bracket, not a figure scaled to this item's size.`
        : `This run is forecast at ${range}${est.points != null ? ` for ${est.points} points` : ''}, from ${est.sampleCount} comparable pointed runs.`;
  return `${ledger} ${forecast} Dispatching anyway spends over the allocation.`;
}

export interface OverRunBudget {
  reason: string;
  budgetPerRunUsd: number;
  costUsdP25?: number;
  costUsdP75?: number;
}

/** The per-run cap refused this dispatch. Deliberately says whose limit it is:
    this one is the operator's own, set two fields up in this very drawer, and
    confusing it with the initiative's allocation would make "dispatch anyway"
    look like overspending someone else's money. */
export function overRunBudgetBody(over: OverRunBudget): string {
  const forecast = over.costUsdP25 != null && over.costUsdP75 != null
    ? `This run is forecast at ${money(over.costUsdP25)}–${money(over.costUsdP75)}`
    : over.reason.split(' — ')[0];
  return `${forecast}, over the ${money(over.budgetPerRunUsd)} cap you set for it. `
    + 'The cap is yours alone — nothing about the initiative\'s allocation or your sprint '
    + 'envelope is being waived here.';
}

export interface OverEnvelope {
  reason: string;
  confidence?: ForecastConfidence;
  estimate?: WorkEstimate;
  allocatedUsd: number;
  attributedSpentUsd: number;
  remainingUsd: number;
  attributionAvailable: boolean;
  sprintName?: string | null;
}

/** The sprint envelope refused this dispatch — and the honest part is what the
    burn is NOT. Only runs recorded as dispatched by this person count, and
    nothing counted before attribution was turned on, so the figure is small by
    construction. Saying "$2 of your $30" without that caveat would read as
    "you have barely spent", which is not something this data supports. */
export function overEnvelopeBody(over: OverEnvelope): string {
  const envelope = over.sprintName
    ? `your ${money(over.allocatedUsd)} envelope on ${over.sprintName}`
    : `your ${money(over.allocatedUsd)} sprint envelope`;
  if (!over.attributionAvailable) {
    return `This run's forecast does not fit ${envelope} at all. No run here is recorded as `
      + 'dispatched by anyone yet, so nothing has been counted against the envelope — the '
      + 'only thing being compared is the forecast against the envelope\'s full size.';
  }
  const ledger = `${money(over.attributedSpentUsd)} of ${envelope} is recorded as spent by you, `
    + `leaving ${money(over.remainingUsd)}.`;
  const caveat = 'That counts only runs recorded as dispatched by you — runs from before '
    + 'attribution was turned on, and everyone else\'s, count against nobody.';
  const est = over.estimate;
  if (!est) return `${ledger} ${caveat}`;
  const range = `${money(est.costUsdP25)}–${money(est.costUsdP75)}`;
  const forecast = over.confidence === 'prior'
    ? `This run is forecast at ${range}, from a deliberately wide prior — nothing has run on this model here yet.`
    : `This run is forecast at ${range}.`;
  return `${ledger} ${forecast} ${caveat}`;
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
  const { can, ready } = useCapabilities();
  const canDispatch = ready && can('DispatchAgentRun');
  const [model, setModel] = useState<string>(DEFAULT_DEVBOX_MODEL);
  const [instruction, setInstruction] = useState('');
  const [agentProjectId, setAgentProjectId] = useState<string | null>(null);
  // The operator's own ceiling on this one run: "don't start it if it is
  // forecast over $X". Held as the raw text so a half-typed "0." is not
  // rewritten under the cursor; parsed into `capUsd` for the wire.
  const [capText, setCapText] = useState('');

  const [estimate, setEstimate] = useState<WorkEstimate | null>(null);
  const [estLoading, setEstLoading] = useState(false);
  const [estError, setEstError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  /** Set from a 409 — the server wants a codebase picked before it will run. */
  const [pickerOptions, setPickerOptions] = useState<CodebaseOption[] | null>(null);
  /** Set from a 429 — the platform's agent-run concurrency ceiling is full. */
  const [concurrencyMsg, setConcurrencyMsg] = useState<string | null>(null);
  // Set from a 403 — the SME holds no active sprint grant on this initiative
  // (grant-scoped dispatch). Unlike the four money gates this is NOT confirmable:
  // there is no flag that waves a missing grant through, so it gets a calm
  // authorization panel that shows the server's guidance verbatim, never the
  // "Dispatch failed" error toast that reads as infra breakage.
  const [grantGapMsg, setGrantGapMsg] = useState<string | null>(null);
  // The initiative's allocation refused this dispatch. Soft brake: we show
  // what is left and offer to proceed anyway, rather than dead-ending on an
  // error toast that merely names an API flag the operator cannot reach.
  // The forecast comes with it, because the brake now fires on weak forecasts
  // too (a run-level range, or a bare prior on an initiative with no history)
  // and the operator has to be told which kind they are being stopped by.
  const [overAllocation, setOverAllocation] = useState<
    {
      reason: string;
      confidence?: ForecastConfidence;
      estimate?: WorkEstimate;
      allocatedUsd: number; spentUsd: number; remainingUsd: number;
    } | null
  >(null);
  // The operator's own cap refused this run. Its own state and its own confirm,
  // because it is a different limit from the allocation and set by a different
  // person — the one clicking.
  const [overRunBudget, setOverRunBudget] = useState<OverRunBudget | null>(null);
  // Their sprint envelope refused it. Third dialog, third flag.
  const [overEnvelope, setOverEnvelope] = useState<OverEnvelope | null>(null);

  // What the operator has already confirmed on THIS authorize attempt. A ref,
  // not state: a chained retry reads it in the same tick it is written, and a
  // dropped confirmation would re-trip the gate the operator just cleared and
  // loop them through the same dialog.
  const confirmsRef = useRef<{ runBudget?: boolean; allocation?: boolean; envelope?: boolean }>({});

  // Reset per item — a fresh drawer for each estimate.
  const itemId = item?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setModel(DEFAULT_DEVBOX_MODEL);
    setInstruction('');
    setCapText('');
    setPickerOptions(null);
    setConcurrencyMsg(null);
    setGrantGapMsg(null);
    setConfirmOpen(false);
    setOverAllocation(null);
    setOverRunBudget(null);
    setOverEnvelope(null);
    confirmsRef.current = {};
    setAgentProjectId(codebases.length === 1 ? codebases[0]!.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  // The cap on the wire. Blank, malformed or negative means "no cap" — a cap
  // is an opt-in, so anything unreadable must not become an accidental $0
  // ceiling that refuses every run.
  const capParsed = capText.trim() === '' ? null : Number(capText);
  const capUsd = capParsed != null && Number.isFinite(capParsed) && capParsed >= 0 ? capParsed : null;
  const capBelowForecast = capUsd != null && estimate != null && estimate.costUsdP75 > capUsd;

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
    setGrantGapMsg(null);
    try {
      const target = overrideAgentProjectId ?? agentProjectId;
      const body: Record<string, unknown> = { workItemId: item.id, model };
      if (target) body['agentProjectId'] = target;
      if (instruction.trim()) body['instruction'] = instruction.trim();
      if (capUsd != null) body['budgetPerRunUsd'] = capUsd;
      // One flag per fence, and only the ones actually confirmed. The retired
      // `confirmOverBudget` answered several limits at once, which is precisely
      // why the per-run cap above could never be offered here before.
      const confirms = confirmsRef.current;
      if (confirms.runBudget) body['confirmOverRunBudget'] = true;
      if (confirms.allocation) body['confirmOverAllocation'] = true;
      if (confirms.envelope) body['confirmOverEnvelope'] = true;
      const res = await fetch('/api/bots/dispatch-work', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({})) as {
        run?: BotRun; error?: string; options?: CodebaseOption[];
        gate?: 'run-budget' | 'allocation' | 'envelope';
        confidence?: ForecastConfidence; estimate?: WorkEstimate;
        runBudget?: { budgetPerRunUsd: number; costUsdP25?: number; costUsdP75?: number };
        allocation?: { allocatedUsd: number; spentUsd: number; remainingUsd: number };
        envelope?: {
          sprintName: string | null; allocatedUsd: number; attributedSpentUsd: number;
          remainingUsd: number; attributionAvailable: boolean;
        };
      };
      if (res.status === 409 && payload.options && payload.options.length > 0) {
        // Multiple codebases deliver this initiative — pick one and retry.
        setPickerOptions(payload.options);
        setConfirmOpen(false);
        return;
      }
      if (res.status === 409 && payload.gate === 'run-budget' && payload.runBudget) {
        // Over the operator's OWN cap. Separate path from the allocation
        // dialog below, and separate flag: the two are different limits and a
        // single confirmation must never answer both.
        setOverRunBudget({
          reason: payload.error ?? 'over the per-run cap',
          ...payload.runBudget,
        });
        setConfirmOpen(false);
        return;
      }
      if (res.status === 409 && payload.allocation) {
        // Over the initiative's allocation. Show the money and let the
        // operator decide — the brake is soft by design.
        setOverAllocation({
          reason: payload.error ?? 'over the allocation',
          ...(payload.confidence ? { confidence: payload.confidence } : {}),
          ...(payload.estimate ? { estimate: payload.estimate } : {}),
          ...payload.allocation,
        });
        setConfirmOpen(false);
        return;
      }
      if (res.status === 409 && payload.envelope) {
        // Over the operator's own sprint envelope.
        setOverEnvelope({
          reason: payload.error ?? 'over your sprint envelope',
          ...(payload.confidence ? { confidence: payload.confidence } : {}),
          ...(payload.estimate ? { estimate: payload.estimate } : {}),
          ...payload.envelope,
        });
        setConfirmOpen(false);
        return;
      }
      if (res.status === 429) {
        // Concurrency ceiling — no picker, just say so plainly inline.
        setConcurrencyMsg(payload.error ?? 'Agent runs already in flight are at the concurrency ceiling');
        setConfirmOpen(false);
        return;
      }
      if (res.status === 403) {
        // Grant-scoped dispatch: the SME holds no active sprint grant on this
        // initiative. This is not a failed run and it is not confirmable —
        // there is no flag to wave a missing grant through — so it gets a calm
        // authorization panel, not the "Dispatch failed" error toast, and no
        // retry affordance. Show the server's guidance verbatim.
        setGrantGapMsg(payload.error ?? 'You hold no active sprint grant on this initiative.');
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
            {canDispatch && (
              <button
                onClick={() => {
                  // A fresh authorize attempt confirms nothing yet — a stale
                  // confirmation from an abandoned attempt must not carry over.
                  confirmsRef.current = {};
                  setConfirmOpen(true);
                }}
                disabled={estLoading || estimate == null || dispatching}
                className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
              >
                {dispatching ? 'dispatching…' : 'Authorize'}
              </button>
            )}
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

          {/* The operator's own ceiling on this run. Optional, and soft: the
              server answers a 409 the operator can still confirm, which is why
              it is a cap rather than a refusal. Its own confirmation flag, so
              waving it through says nothing about the initiative's allocation
              or the sprint envelope. */}
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            <span className="font-semibold">
              Cap this run <span className="font-normal text-text-tertiary">(optional)</span>
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-text-tertiary">$</span>
              <input
                type="number"
                min="0"
                step="0.25"
                inputMode="decimal"
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
                placeholder={estimate ? estimate.costUsdP75.toFixed(2) : 'no cap'}
                className="w-28 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              />
              <span className="text-[11px] text-text-tertiary">
                don't start it if it's forecast over this
              </span>
            </div>
            {capBelowForecast && (
              <span className="text-[11px] text-warning">
                The high end of the current forecast is over this cap — you'll be asked to confirm.
              </span>
            )}
          </label>

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

          {/* 403 — grant-scoped dispatch: no active sprint grant on this
              initiative. A calm authorization gap, not a run failure and not a
              money gate: nothing to confirm or retry here, so no button —
              just the server's guidance and who to ask. */}
          {grantGapMsg && (
            <div className="px-3 py-2.5 rounded-md border border-warning/50 bg-warning-bg/40">
              <div className="text-[12px] font-semibold text-text-primary mb-0.5">No sprint grant on this initiative</div>
              <div className="text-[12px] text-text-primary leading-relaxed">
                {grantGapMsg}
              </div>
              <div className="mt-1.5 text-[11px] text-text-tertiary">
                This isn't a failed run — the run was never started. Ask the release
                manager for a sprint grant on this initiative, then authorize again.
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

      {/* The allocation brake. Naming the remaining money is the whole point:
          "over budget" is a shrug, "$2.40 left of $30" is a decision. */}
      <ConfirmDialog
        open={overAllocation != null}
        // A refusal built on a prior is a warning, not a verdict — reserve the
        // loudest tone for a spent-out allocation or a size-scaled forecast,
        // which are the two cases we can actually stand behind.
        tone={
          overAllocation && overAllocation.remainingUsd > 0
            && overAllocation.confidence != null && overAllocation.confidence !== 'scaled'
            ? 'caution'
            : 'destructive'
        }
        title="Over this initiative's budget"
        body={overAllocation ? overAllocationBody(overAllocation) : ''}
        confirmLabel={dispatching ? 'Dispatching…' : 'Dispatch anyway'}
        confirmDisabled={dispatching}
        onConfirm={() => {
          const target = agentProjectId ?? undefined;
          setOverAllocation(null);
          // Only the allocation flag. The cap the operator set on this run, and
          // their sprint envelope, are separate fences and stay shut.
          confirmsRef.current = { ...confirmsRef.current, allocation: true };
          void dispatch(target);
        }}
        onCancel={() => setOverAllocation(null)}
      />

      {/* The operator's own cap. Caution, never destructive: they set this
          number themselves a moment ago, and going over it spends nobody
          else's money. */}
      <ConfirmDialog
        open={overRunBudget != null}
        tone="caution"
        title="Over the cap you set for this run"
        body={overRunBudget ? overRunBudgetBody(overRunBudget) : ''}
        confirmLabel={dispatching ? 'Dispatching…' : 'Dispatch anyway'}
        confirmDisabled={dispatching}
        onConfirm={() => {
          const target = agentProjectId ?? undefined;
          setOverRunBudget(null);
          confirmsRef.current = { ...confirmsRef.current, runBudget: true };
          void dispatch(target);
        }}
        onCancel={() => setOverRunBudget(null)}
      />

      {/* The sprint envelope a release manager granted. Softest tone while the
          burn is unknown — with no attribution recorded there is no ledger
          behind the refusal, only the envelope's size. */}
      <ConfirmDialog
        open={overEnvelope != null}
        tone={overEnvelope && !overEnvelope.attributionAvailable ? 'caution' : 'destructive'}
        title="Over your sprint envelope"
        body={overEnvelope ? overEnvelopeBody(overEnvelope) : ''}
        confirmLabel={dispatching ? 'Dispatching…' : 'Dispatch anyway'}
        confirmDisabled={dispatching}
        onConfirm={() => {
          const target = agentProjectId ?? undefined;
          setOverEnvelope(null);
          confirmsRef.current = { ...confirmsRef.current, envelope: true };
          void dispatch(target);
        }}
        onCancel={() => setOverEnvelope(null)}
      />
    </>
  );
}

export default EstimateDrawer;
