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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Drawer,
  EntityCell,
  FormField,
  Inline,
  InlineAlert,
  Input,
  MetaLine,
  SectionLabel,
  Select,
  Stack,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { DEVBOX_MODELS, DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { preflightEnvelope } from '../../lib/envelopeFormat';
import type { EnvelopesResponse } from '../../lib/envelopeFormat';
import { usd as money } from '../../lib/format';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
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

/** The provenance fields the save route echoes back, and all the row reads. */
export interface EstimateProvenance {
  estimatedBy?: string | null;
  estimatedByName?: string | null;
  estimatedAt?: string | null;
  estimateModel?: string | null;
  estimateForecast?: Record<string, unknown> | null;
  estimatedCostUsd?: number | null;
  // The review route echoes the same item shape, so these ride along and a
  // sign-off updates the row without a refetch.
  estimateReviewedBy?: string | null;
  estimateReviewedByName?: string | null;
  estimateReviewedAt?: string | null;
}

export interface EstimateItem {
  id: string;
  title: string;
  type: string;
  storyPoints: number | null;
  /**
   * The estimate somebody already stood behind, if any
   * (schema/work_item_estimate_schema.sql). Null on every item that predates
   * that migration and on any item nobody has dispatched — which is the
   * ordinary case, not a warning.
   *
   * `estimateModel` is what makes the stored forecast usable: it is only valid
   * for the model it was computed against. Haiku and Opus were measured 20x
   * apart on identical points, so a stored Haiku figure shown while Opus is
   * selected would be worse than showing none.
   */
  estimatedBy?: string | null;
  estimatedByName?: string | null;
  estimatedAt?: string | null;
  estimateModel?: string | null;
  estimateForecast?: Record<string, unknown> | null;
  estimateReviewedBy?: string | null;
  estimateReviewedByName?: string | null;
  estimateReviewedAt?: string | null;
}

/** "20 minutes ago" — an estimate's age is the whole point of storing when. */
function agoLabel(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Is the stored estimate usable for the model currently selected?
 *
 * The model check is the load-bearing half. Without it this would happily show
 * a Haiku forecast above an Opus run and call it "estimated by Nora" — a wrong
 * number with somebody's name lending it authority, which is worse than the
 * unattributed recompute this replaces.
 */
export function storedEstimateFor(item: EstimateItem | null, model: string): WorkEstimate | null {
  if (!item?.estimateForecast || !item.estimatedAt) return null;
  if (item.estimateModel !== model) return null;
  const f = item.estimateForecast as Partial<WorkEstimate>;
  return typeof f.costUsdP25 === 'number' && typeof f.costUsdP75 === 'number'
    ? (f as WorkEstimate)
    : null;
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
  /**
   * The initiative this run is charged to. Used to look up the caller's own
   * sprint envelope BEFORE they authorize, so the envelope brake's 409 stops
   * being the first they hear of it. Optional — a host that cannot name the
   * initiative simply gets no pre-flight, never a wrong envelope.
   */
  orgProjectId?: string | null;
  /** Called on 202 so the page can flip the item to in_progress optimistically. */
  onDispatched: (workItemId: string, run: BotRun) => void;
  /**
   * A forecast was authorized without spending. Deliberately NOT folded into
   * `onDispatched`: that callback's contract is "a run started", and it flips
   * the row to in_progress. Saving an estimate must leave the row `open` —
   * that is the entire point, since an item that is already running cannot be
   * the thing a standing estimate is read for.
   */
  onEstimateSaved?: (workItemId: string, saved: EstimateProvenance) => void;
  /**
   * What the host already chose, applied each time the drawer opens — the
   * initiative page's run-draft panel picks model, codebase and instruction
   * beside the work item and hands them over here, so authorizing still runs
   * through this drawer's gates without asking for them twice.
   */
  initialModel?: string;
  initialAgentProjectId?: string | null;
  initialInstruction?: string;
  /** The run budget chosen beside the item — prefills "Cap this run". */
  initialCapUsd?: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
//
// `money` is lib/format.ts's `usd`, aliased — this used to be a local
// `` `$${n.toFixed(2)}` `` with no thousands separator, so `$1234.56` read
// differently here than on every other money surface in the app above
// $1,000. Same bug workShared's QueuePage estimate column had.

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
  if (costUsd == null) return <Inline as="span" gap="none" className="text-text-tertiary whitespace-nowrap">—</Inline>;
  const actual = `$${costUsd.toFixed(4)}`;
  if (!estimate) return <Inline as="span" gap="none" className="text-text-tertiary whitespace-nowrap">{actual}</Inline>;
  const over = costUsd > estimate.costUsdP75;
  const under = costUsd < estimate.costUsdP25;
  const range = `${money(estimate.costUsdP25)}–${money(estimate.costUsdP75)}`;
  const title = over
    ? `Actual ${actual} ran over the authorize-time estimate (${range}, p25–p75)`
    : under
      ? `Actual ${actual} came in under the authorize-time estimate (${range}, p25–p75)`
      : `Actual ${actual} landed inside the authorize-time estimate (${range}, p25–p75)`;
  return (
    // `gap="none"` throughout: the leading space in " est " is deliberate
    // spacing between the actual and its range, and a flex gap here would
    // double it.
    <Inline as="span" gap="none" className="whitespace-nowrap" title={title}>
      <Inline as="span" gap="none" className={over ? 'text-danger' : under ? 'text-success' : 'text-text-tertiary'}>{actual}</Inline>
      <Inline as="span" gap="none" className="text-text-tertiary opacity-70"> est {range}</Inline>
    </Inline>
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

export function EstimateDrawer({
  open, onClose, item, codebases, orgProjectId = null, onDispatched, onEstimateSaved,
  initialModel, initialAgentProjectId, initialInstruction, initialCapUsd,
}: EstimateDrawerProps) {
  // The library's Drawer restores focus to whatever was document.activeElement
  // when it MOUNTED. That's wrong here: the most common trigger is the
  // WorkItemDrawer's own "⚡ Estimate & dispatch" footer button, which calls
  // onEstimate(item) and onClose() in the same click — unmounting itself in
  // the very render that mounts this drawer. The browser force-blurs a
  // removed focused element to <body> as part of that DOM mutation, which
  // happens before any effect runs, so by the time this drawer's mount effect
  // captures "previous focus" it has already lost the real trigger and saves
  // the app shell instead. Escape or Cancel then lands there.
  //
  // Fixing it means not trusting that snapshot: every place that can open
  // this drawer tags its own trigger button with `data-estimate-trigger`
  // keyed on the work item's id (Button isn't forwardRef, so a captured DOM
  // ref would go stale the moment the triggering drawer unmounts — a
  // re-queryable id survives that). On close, look it up fresh — the
  // WorkItemDrawer's own button may be long gone, but the same item's row in
  // the board/epic/list view usually still has one — and focus it if it's
  // still around; if nothing matches (the row scrolled out of a filtered
  // view, etc.) leave focus wherever the browser already put it rather than
  // force it onto something unrelated. The requestAnimationFrame runs after
  // the library's own (wrong) restore has already fired, so ours is the one
  // that sticks.
  const closingItemId = item?.id ?? null;
  const handleClose = () => {
    onClose();
    if (!closingItemId) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-estimate-trigger="${CSS.escape(closingItemId)}"]`)?.focus();
    });
  };

  const { can, ready } = useCapabilities();
  const canDispatch = ready && can('DispatchAgentRun');
  const { session } = useSession();
  const [model, setModel] = useState<string>(DEFAULT_DEVBOX_MODEL);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
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
    setModel(initialModel ?? DEFAULT_DEVBOX_MODEL);
    setInstruction(initialInstruction ?? '');
    setCapText(initialCapUsd != null ? String(initialCapUsd) : '');
    setPickerOptions(null);
    setConcurrencyMsg(null);
    setGrantGapMsg(null);
    setConfirmOpen(false);
    setOverAllocation(null);
    setOverRunBudget(null);
    setOverEnvelope(null);
    confirmsRef.current = {};
    setAgentProjectId(initialAgentProjectId ?? (codebases.length === 1 ? codebases[0]!.id : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  // The cap on the wire. Blank, malformed or negative means "no cap" — a cap
  // is an opt-in, so anything unreadable must not become an accidental $0
  // ceiling that refuses every run.
  const capParsed = capText.trim() === '' ? null : Number(capText);
  const capUsd = capParsed != null && Number.isFinite(capParsed) && capParsed >= 0 ? capParsed : null;
  const capBelowForecast = capUsd != null && estimate != null && estimate.costUsdP75 > capUsd;

  // The estimate somebody already authorized, if it is for THIS model.
  const stored = useMemo(() => storedEstimateFor(item, model), [item, model]);

  // Live estimate — on open and whenever the model or target codebase changes,
  // BUT only when there is no stored estimate for the selected model. A stored
  // one is a decision with an author; recomputing over it would quietly replace
  // that with an anonymous number and lose the only thing worth having.
  useEffect(() => {
    if (!open || !item || item.storyPoints == null) return;
    if (stored) { setEstimate(stored); setEstLoading(false); setEstError(null); return; }
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
  }, [open, item, model, agentProjectId, stored]);

  // ── The envelope, BEFORE the money is committed ────────────────────────────
  //
  // The third brake (decideEnvelope) can 409 an SME who had no way to see the
  // number it judges them on. This reads the same rows the brake resolves
  // (GET /api/sprints/envelopes → listActiveEnvelopes), keyed on the same
  // initiative, so the panel below and the refusal cannot be two figures.
  // Re-read on every open rather than polled: an envelope moves when a run
  // finishes, and a stale "what's left" is worse than none.
  const { data: envelopeData } = useFetch<EnvelopesResponse>(
    open && canDispatch ? '/api/sprints/envelopes' : null,
  );
  const envelope = useMemo(() => preflightEnvelope({
    data: envelopeData,
    orgProjectId,
    forecast: estimate
      ? { costUsdP25: estimate.costUsdP25, costUsdP75: estimate.costUsdP75 }
      : null,
    role: session?.role,
  }), [envelopeData, orgProjectId, estimate, session?.role]);

  // Advisory SME sign-off on the stored estimate.
  //
  // Separate from saving because the two are different people's acts as often
  // as not: whoever computed the forecast is not necessarily whoever is asked
  // whether it is sane. Recording them together would attribute one person's
  // opinion to the other.
  async function reviewEstimate() {
    if (!item || reviewing) return;
    setReviewing(true);
    const tid = toastPending('Recording review', item.title);
    try {
      const res = await fetch(`/api/bots/work-items/${encodeURIComponent(item.id)}/review-estimate`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({})) as { error?: string };
        toastError(tid, 'Review not recorded', detail.error ?? `HTTP ${res.status}`);
        return;
      }
      const saved = (await res.json().catch(() => ({}))) as { item?: EstimateProvenance };
      toastSuccess(tid, 'Estimate reviewed', item.title);
      if (saved.item) onEstimateSaved?.(item.id, saved.item);
      handleClose();
    } catch (err) {
      toastError(tid, 'Review not recorded', (err as Error).message);
    } finally {
      setReviewing(false);
    }
  }

  // Record the forecast on the work item without dispatching anything.
  //
  // Awaited and surfaced, unlike the dispatch path's fire-and-forget persist:
  // there the write is a label on a run that already started, so a failure must
  // not read as the run failing. Here the write IS the action, so a failure has
  // to be visible or the operator believes they signed off when they did not.
  async function saveEstimate() {
    if (!item || !estimate || saving) return;
    setSaving(true);
    const tid = toastPending('Saving estimate', item.title);
    try {
      const res = await fetch(`/api/bots/work-items/${encodeURIComponent(item.id)}/estimate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, estimate }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({})) as { error?: string };
        toastError(tid, 'Estimate not saved', detail.error ?? `HTTP ${res.status}`);
        return;
      }
      const saved = (await res.json().catch(() => ({}))) as { item?: EstimateProvenance };
      toastSuccess(tid, 'Estimate saved', `${item.title} — recorded on ${modelLabel}.`);
      if (saved.item) onEstimateSaved?.(item.id, saved.item);
      handleClose();
    } catch (err) {
      toastError(tid, 'Estimate not saved', (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

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
      handleClose();
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
        onClose={handleClose}
        title="Estimate & authorize"
        subtitle="A governed agent run, bound to this work item — its change still passes review."
        footer={
          <Inline gap="sm" wrap={false} className="w-full">
            <MetaLine size="xs" className="flex-1" items={[estimate ? `model: ${modelLabel}` : '']} />
            <Button variant="secondary" size="sm" onClick={handleClose}>Cancel</Button>
            {canDispatch && (
              // Save the forecast without spending. This is what puts a name
              // and a timestamp on the number, and what makes the work row's
              // play action appear — authorizing an estimate and spending
              // against it are separate acts, and only the second costs money.
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { void saveEstimate(); }}
                disabled={estLoading || estimate == null || dispatching || saving}
                title="Record this estimate against the work item — no agent runs"
              >
                {saving ? 'saving…' : 'Save estimate'}
              </Button>
            )}
            {canDispatch && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  // A fresh authorize attempt confirms nothing yet — a stale
                  // confirmation from an abandoned attempt must not carry over.
                  confirmsRef.current = {};
                  setConfirmOpen(true);
                }}
                disabled={estLoading || estimate == null || dispatching}
              >
                {dispatching ? 'dispatching…' : 'Authorize'}
              </Button>
            )}
          </Inline>
        }
      >
        <Stack gap="lg">
          {/* The work item under estimate */}
          <Stack gap="none">
            <Inline gap="sm" wrap>
              <Chip tone={item.type === 'bug' ? 'danger' : 'info'} size="xs">{item.type}</Chip>
              <EntityCell label={item.title} labelClassName="text-[13px] font-semibold" />
            </Inline>
            <MetaLine
              size="xs"
              className="mt-1"
              items={[item.storyPoints != null
                ? `${item.storyPoints} ${item.storyPoints === 1 ? 'point' : 'points'}`
                : 'unpointed']}
            />
          </Stack>

          {/* Model — the estimate recomputes live as this changes */}
          {/* `labelId` is dropped from each wiring bag — FormField hands it over
              but it is not a DOM prop, so spreading it makes React warn. */}
          <FormField label="Model">
            {({ labelId: _l, ...w }) => (
              <Select
                {...w}
                size="sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                options={DEVBOX_MODELS.map((m) => ({ value: m.id, label: `${m.label} — ${m.hint}` }))}
              />
            )}
          </FormField>

          {/* Target codebase — optional; the server 409s if it needs a pick */}
          {codebases.length > 1 && (
            <FormField label="Codebase">
              {({ labelId: _l, ...w }) => (
                <Select
                  {...w}
                  size="sm"
                  className="font-mono"
                  value={agentProjectId ?? ''}
                  onChange={(e) => setAgentProjectId(e.target.value || null)}
                  options={[
                    { value: '', label: 'choose at dispatch' },
                    ...codebases.map((cb) => ({ value: cb.id, label: cb.repoFullName })),
                  ]}
                />
              )}
            </FormField>
          )}

          {/* The estimate — always a range, with its basis stated plainly */}
          <Card className="px-3 py-2.5 bg-surface-inset">
            <Inline gap="sm" justify="between" wrap>
              <SectionLabel className="mb-1">Estimate</SectionLabel>
              {/* Provenance, only when the stored estimate is the one on show.
                  A recomputed forecast deliberately carries no name — nobody
                  has stood behind it yet, and labelling it would invent an
                  author. */}
              {stored && item.estimatedAt && (
                <MetaLine
                  size="xs"
                  items={[
                    `estimated by ${item.estimatedByName ?? item.estimatedBy ?? 'unknown'} · ${agoLabel(item.estimatedAt)}`,
                    ...(item.estimateReviewedBy
                      ? [`reviewed by ${item.estimateReviewedByName ?? item.estimateReviewedBy}`]
                      : []),
                  ]}
                />
              )}
              {/* Advisory sign-off. Offered only on a STORED estimate: there is
                  nothing to review about a forecast that has not been saved,
                  and reviewing one would sign off on a number that vanishes
                  when this drawer closes. Reviewing does not gate dispatch —
                  see schema/work_item_estimate_schema.sql. */}
              {stored && item.estimatedAt && canDispatch && !item.estimateReviewedBy && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={reviewing}
                  onClick={() => { void reviewEstimate(); }}
                  title="Record that you have looked at this forecast"
                >
                  {reviewing ? 'reviewing…' : 'Mark reviewed'}
                </Button>
              )}
            </Inline>
            {estLoading ? (
              <MetaLine items={['estimating…']} />
            ) : estError ? (
              // The failure is loud on purpose: an unavailable estimate must
              // never read like a cheap one.
              <InlineAlert tone="error">Estimate unavailable: {estError}</InlineAlert>
            ) : estimate ? (
              <>
                <Inline as="span" gap="none" className="text-[13px] text-text-primary leading-relaxed">
                  {estimateLine(estimate)}
                </Inline>
                {/* The stored estimate belongs to another model, so this one is
                    fresh and unattributed. Said out loud, because silently
                    swapping the number under a familiar name is the failure
                    this whole change exists to prevent. */}
                {!stored && item.estimatedAt && item.estimateModel !== model && (
                  <MetaLine
                    size="xs"
                    className="mt-1"
                    items={[`Recomputed for ${modelLabel} — the stored estimate was for a different model.`]}
                  />
                )}
                {estimate.basis === 'prior' && (
                  <MetaLine size="xs" className="mt-1" items={[`≈ ${rangeText(estimate)}`]} />
                )}
              </>
            ) : (
              <MetaLine items={['—']} />
            )}
          </Card>

          {/* What is left of the operator's own sprint envelope, read before
              they commit. Sits directly under the estimate because the only
              question it answers is "does that forecast fit what I have left" —
              and it names the state in words when the burn is unattributed,
              because a null burn is unknown, never $0.00. */}
          {envelope && (
            <InlineAlert tone={envelope.tone}>
              <strong>{envelope.title}.</strong> {envelope.body}
            </InlineAlert>
          )}

          {/* The operator's own ceiling on this run. Optional, and soft: the
              server answers a 409 the operator can still confirm, which is why
              it is a cap rather than a refusal. Its own confirmation flag, so
              waving it through says nothing about the initiative's allocation
              or the sprint envelope. */}
          <FormField label="Cap this run" hint="optional">
            {({ labelId: _l, ...w }) => (
              <Stack gap="xs">
                <Inline gap="xs" wrap={false}>
                  {/* The `$` is Input's own prefix slot rather than a sibling
                      span, so it sits inside the field's border where it
                      belongs. */}
                  <Input
                    {...w}
                    type="number"
                    size="sm"
                    prefix="$"
                    min="0"
                    step="0.25"
                    inputMode="decimal"
                    value={capText}
                    onChange={(e) => setCapText(e.target.value)}
                    placeholder={estimate ? estimate.costUsdP75.toFixed(2) : 'no cap'}
                    className="w-28"
                  />
                  <MetaLine size="xs" items={["don't start it if it's forecast over this"]} />
                </Inline>
                {capBelowForecast && (
                  <InlineAlert tone="warning">
                    The high end of the current forecast is over this cap — you'll be asked to confirm.
                  </InlineAlert>
                )}
              </Stack>
            )}
          </FormField>

          {/* Optional one-shot steering, without editing any standing mission */}
          <FormField label="Instruction" hint="optional, this run only">
            {({ labelId: _l, ...w }) => (
              <Textarea
                {...w}
                rows={3}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. 'prefer the existing retry helper — do not add a new dependency'"
                className="w-full resize-y"
              />
            )}
          </FormField>

          {/* 429 — the concurrency ceiling is full; wait or raise it */}
          {concurrencyMsg && (
            <InlineAlert tone="error">
              <strong>Concurrency ceiling reached.</strong>{' '}
              {concurrencyMsg} — raise{' '}
              <Inline as="span" gap="none" className="font-mono text-[11px]">BOT_MAX_CONCURRENT</Inline> or
              wait for a run to finish, then authorize again.
            </InlineAlert>
          )}

          {/* 403 — grant-scoped dispatch: no active sprint grant on this
              initiative. A calm authorization gap, not a run failure and not a
              money gate: nothing to confirm or retry here, so no button —
              just the server's guidance and who to ask. */}
          {grantGapMsg && (
            // warning, not error: nothing failed and nothing is retryable here
            // — it is an authorization gap with a person to ask.
            <InlineAlert tone="warning">
              <strong>No sprint grant on this initiative.</strong> {grantGapMsg}
              <MetaLine
                size="xs"
                className="mt-1.5"
                items={["This isn't a failed run — the run was never started. Ask the release "
                  + 'manager for a sprint grant on this initiative, then authorize again.']}
              />
            </InlineAlert>
          )}

          {/* 409 fallback — the server wants a codebase before it will run */}
          {pickerOptions && (
            <InlineAlert tone="warning">
              <strong>Several codebases deliver this initiative — pick where the agent works:</strong>
              <Stack gap="xs" className="mt-1.5">
                {pickerOptions.map((o) => (
                  // Each of these DISPATCHES on click — a real run against a
                  // real repo — so they stay full-width, left-aligned targets
                  // rather than becoming a compact row of chips.
                  <Button
                    key={o.id}
                    variant="secondary"
                    size="sm"
                    fullWidth
                    disabled={dispatching}
                    className="font-mono justify-start text-left"
                    onClick={() => {
                      setAgentProjectId(o.id);
                      setPickerOptions(null);
                      void dispatch(o.id);
                    }}
                  >
                    {o.repoFullName}
                  </Button>
                ))}
              </Stack>
            </InlineAlert>
          )}
        </Stack>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        tone="caution"
        title="Authorize agent run?"
        // The envelope line rides on the confirmation itself, not only on the
        // form behind it: this dialog is the last thing between the operator and
        // the spend, so what is left of their envelope belongs here rather than
        // in a 409 a second later.
        body={[
          estimate
            ? `${estimateLine(estimate)}. The run uses ${modelLabel}, is bound to "${item.title}", and every change it makes still passes the review queue.`
            : `Dispatch "${item.title}" to an agent on ${modelLabel}? Every change it makes still passes the review queue.`,
          envelope?.confirmLine,
        ].filter(Boolean).join(' ')}
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
