// Prepare a computer job beside its work item. Keep the instruction visible
// and the estimate separate from the unsaved plan. The docked composer asks
// the org agent; this form prepares the choices for the authorization drawer.
//
// Authorizing opens the EstimateDrawer rather than POSTing here. The drawer is
// where the four dispatch refusals (codebase pick, run cap, allocation,
// envelope) each get their own confirm, and a second copy of that chain would
// drift from the first. The choices made here are handed to it prefilled.

import { useEffect, useMemo, useState } from 'react';
import { AccessNotice, formatEstimate, type RunEstimate } from '@connorhoehnslalom/ui-components';
import { Button, FormField, FormRow, Inline, NumberInput, Select, Stack, T, Textarea } from '@connorhoehnslalom/ui-components/shared';
import {
  storedEstimateFor,
  type EstimateProvenance,
  type WorkEstimate,
} from '../../components/marketplace/EstimateDrawer';
import { DEFAULT_DEVBOX_MODEL, DEVBOX_MODELS } from '../../lib/devboxModels';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import type { BotRun } from '../bots/BotsPage';
import type { FlatWorkItem } from './projectFormat';
import type { Codebase } from './types';

export interface RunChoice {
  model: string;
  agentProjectId: string | null;
  /** The per-run cap in dollars — the dispatch route's `budgetPerRunUsd`. */
  capUsd: number | null;
  /** What the agent should do — prefilled into the authorize drawer. */
  instruction: string;
}

/** The live forecast for one item at one model — or the stored one, which is
 *  a decision with an author and is never recomputed over. */
function useWorkEstimate(item: FlatWorkItem, model: string, agentProjectId: string | null, enabled: boolean) {
  const stored = useMemo(() => storedEstimateFor(item, model), [item, model]);
  const [live, setLive] = useState<{ key: string; estimate: WorkEstimate | null; error: string | null } | null>(null);
  const key = `${item.id}|${item.storyPoints}|${model}|${agentProjectId ?? ''}`;

  useEffect(() => {
    if (!enabled || stored || item.storyPoints == null) return;
    let cancelled = false;
    const params = new URLSearchParams({ model, points: String(item.storyPoints) });
    if (agentProjectId) params.set('agentProjectId', agentProjectId);
    fetch(`/api/bots/estimate?${params.toString()}`, { credentials: 'include' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({})) as WorkEstimate & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body;
      })
      .then((estimate) => { if (!cancelled) setLive({ key, estimate, error: null }); })
      .catch((err: Error) => { if (!cancelled) setLive({ key, estimate: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [key, enabled, stored, item.storyPoints, model, agentProjectId]);

  if (stored) return { estimate: stored, error: null, loading: false, stored: true };
  // The estimate route is dispatch-gated; a role without it gets no forecast
  // rather than a request it can only lose.
  if (!enabled) return { estimate: null, error: null, loading: false, stored: false };
  if (item.storyPoints == null) return { estimate: null, error: null, loading: false, stored: false };
  const current = live?.key === key ? live : null;
  return { estimate: current?.estimate ?? null, error: current?.error ?? null, loading: current == null, stored: false };
}

function asEstimates(item: FlatWorkItem, est: ReturnType<typeof useWorkEstimate>, canDispatch: boolean): { cost: RunEstimate; duration: RunEstimate } {
  if (!canDispatch && !est.stored) {
    const none: RunEstimate = { kind: 'none', reason: 'Needs dispatch rights' };
    return { cost: none, duration: none };
  }
  if (item.storyPoints == null) {
    const none: RunEstimate = { kind: 'none', reason: 'Size this item first' };
    return { cost: none, duration: none };
  }
  if (est.loading) return { cost: { kind: 'loading' }, duration: { kind: 'loading' } };
  if (!est.estimate) {
    const none: RunEstimate = { kind: 'none', reason: est.error ?? 'No forecast available' };
    return { cost: none, duration: none };
  }
  const e = est.estimate;
  return {
    cost: { kind: 'range', low: e.costUsdP25, high: e.costUsdP75, unit: 'usd' },
    duration: { kind: 'range', low: e.minutesP25 * 60_000, high: e.minutesP75 * 60_000, unit: 'ms' },
  };
}

type RunDraftProps = {
  item: FlatWorkItem;
  codebases: Codebase[];
  /** This item's latest marketplace run, if any. */
  run: BotRun | undefined;
  canDispatch: boolean;
  /** An sme with no active sprint grant here — dispatch would 403. */
  showGrantCue: boolean;
  onEstimateSaved: (workItemId: string, saved: EstimateProvenance) => void;
  onAuthorize: (choice: RunChoice) => void;
  /** Every change to the draft — the collapsed Run setup's hint reads it. */
  onChoiceChange?: (choice: RunChoice) => void;
};

/** A different work item starts a new plan; refreshing its codebases does not. */
export function RunDraft(props: RunDraftProps) {
  return <RunDraftForItem key={props.item.id} {...props} />;
}

function RunDraftForItem({
  item,
  codebases,
  run,
  canDispatch,
  showGrantCue,
  onEstimateSaved,
  onAuthorize,
  onChoiceChange,
}: RunDraftProps) {
  const [model, setModel] = useState(DEFAULT_DEVBOX_MODEL);
  const [agentProjectId, setAgentProjectId] = useState<string | null>(null);
  // The dispatch route's per-run cap (budgetPerRunUsd): the run is refused if
  // its forecast is over it. Blank means no cap — a cap is opt-in.
  const [capUsd, setCapUsd] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [instruction, setInstruction] = useState('');
  // Reconcile only the codebase selection after an asynchronous load or poll.
  // Keep a still-readable explicit choice and never erase the plan or cap.
  const codebaseKey = JSON.stringify(codebases.map((c) => c.id));
  useEffect(() => {
    const ids = JSON.parse(codebaseKey) as string[];
    setAgentProjectId(current => current && ids.includes(current) ? current : ids.length === 1 ? ids[0]! : null);
  }, [codebaseKey]);

  useEffect(() => {
    onChoiceChange?.({ model, agentProjectId, capUsd, instruction });
  }, [onChoiceChange, model, agentProjectId, capUsd, instruction]);

  const est = useWorkEstimate(item, model, agentProjectId, canDispatch);
  const { cost, duration } = asEstimates(item, est, canDispatch);
  const modelLabel = DEVBOX_MODELS.find((m) => m.id === model)?.label ?? model;

  async function save() {
    if (!est.estimate || saving) return;
    setSaving(true);
    const tid = toastPending('Saving estimate', item.title);
    try {
      const res = await fetch(`/api/bots/work-items/${encodeURIComponent(item.id)}/estimate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, estimate: est.estimate }),
      });
      const body = await res.json().catch(() => ({})) as { item?: EstimateProvenance; error?: string };
      if (!res.ok) { toastError(tid, 'Estimate not saved', body.error ?? `HTTP ${res.status}`); return; }
      toastSuccess(tid, 'Estimate saved', `${item.title} — recorded on ${modelLabel}.`);
      if (body.item) onEstimateSaved(item.id, body.item);
    } catch (err) {
      toastError(tid, 'Estimate not saved', (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const blocked = !canDispatch ? 'Your role cannot dispatch agents'
    : item.storyPoints == null ? 'Size this item first'
    : item.status !== 'open' ? 'Only work that is up next can be dispatched'
    : undefined;
  const saveBlocked = !canDispatch ? 'Your role cannot record estimates'
    : est.stored ? `Already recorded on ${modelLabel}`
    : !est.estimate ? 'No forecast to record yet'
    : undefined;
  const capHint = capUsd != null && est.estimate && est.estimate.costUsdP75 > capUsd
    ? 'Below forecast; review will ask you to confirm.'
    : 'Optional maximum cost for this run.';

  return (
    <Stack gap="md" data-testid="run-draft-panel">
      <FormField label="Instruction" hint="What should the agent change, and how will you verify it?">
        {wiring => <Textarea {...wiring} minRows={3} autoResize value={instruction}
          onChange={event => setInstruction(event.target.value)}
          placeholder="Describe the change and what done looks like…"
          disabled={!canDispatch} data-testid="run-draft-instruction" />}
      </FormField>
      <FormRow>
        <FormField label="Codebase">
          {wiring => <Select {...wiring} size="sm" value={agentProjectId ?? ''}
            options={codebases.map(c => ({ value: c.id, label: c.repoFullName }))}
            placeholder={codebases.length ? 'Choose a codebase…' : 'No readable codebase'}
            disabled={codebases.length === 0}
            onChange={event => setAgentProjectId(event.target.value || null)} />}
        </FormField>
        <FormField label="Model">
          {wiring => <Select {...wiring} size="sm" value={model}
            options={DEVBOX_MODELS.map(m => ({ value: m.id, label: m.label }))}
            onChange={event => setModel(event.target.value)} />}
        </FormField>
      </FormRow>
      <FormRow>
        <FormField label="Run cap" hint={capHint}>
          {wiring => <NumberInput {...wiring} size="sm" min={0} step={0.05} unit="USD"
            value={capUsd ?? undefined} placeholder="No cap" disabled={!canDispatch}
            onChange={setCapUsd} onClear={() => setCapUsd(null)}
            data-testid="run-draft-budget-input" />}
        </FormField>
        <FormField label="Forecast" data-testid="run-draft-forecast" hint={est.estimate && <T tone="tertiary" wrap>
            {est.stored ? 'Recorded estimate · ' : ''}
            {est.estimate.basis === 'prior'
              ? 'Prior forecast · low confidence'
              : `${est.estimate.sampleCount} prior ${est.estimate.sampleCount === 1 ? 'run' : 'runs'}`}
          </T>}>
          {wiring => <output id={wiring.id} aria-describedby={wiring['aria-describedby']} className="block py-1 text-sm text-text-primary">
            {est.error ? 'Forecast unavailable' : formatEstimate(cost)}{cost.kind === 'range' && duration.kind === 'range' ? ` · ${formatEstimate(duration)}` : ''}
          </output>}
        </FormField>
      </FormRow>
      {!canDispatch && <AccessNotice tone="info" title="An SME or leader authorizes jobs"
        body="An SME needs a sprint grant here; a release manager can authorize directly." data-testid="run-draft-access" />}
      {canDispatch && showGrantCue && <AccessNotice tone="warning" title="Sprint access required"
        body="You have no active sprint grant on this initiative."
        action={{ label: 'Open sprints', href: '/iq/sprints' }} data-testid="run-draft-access" />}
      {est.error && item.storyPoints != null && <T as="p" size="xs" role="alert" wrap className="text-danger">{est.error}</T>}
      <Inline gap="sm" wrap className="justify-between border-t border-border pt-3">
        <T as="p" size="xs" tone="tertiary" wrap>
          {run?.status === 'running' ? 'A job is running for this item. ' : ''}
          {canDispatch && blocked ? `${blocked}.` : 'Nothing starts until you authorize.'}
        </T>
        <Inline gap="sm" wrap>
          <Button variant="secondary" size="sm" disabled={saving || !!saveBlocked} title={saveBlocked}
            onClick={() => { void save(); }} data-testid="run-draft-save">
            {saving ? 'Saving estimate…' : 'Save estimate'}
          </Button>
          <Button size="sm" disabled={!!blocked} title={blocked}
            onClick={() => onAuthorize({ model, agentProjectId, capUsd, instruction })} data-testid="run-draft-dispatch">
            Review &amp; authorize
          </Button>
        </Inline>
      </Inline>
    </Stack>
  );
}
