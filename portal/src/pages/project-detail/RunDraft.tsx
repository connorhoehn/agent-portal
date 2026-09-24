// The run-draft column beside the open work item: which model, which codebase,
// what it should cost, and the two acts — record the estimate, or authorize a
// run. The library's RunDraftPanel draws it; this file only feeds it.
//
// Authorizing opens the EstimateDrawer rather than POSTing here. The drawer is
// where the four dispatch refusals (codebase pick, run cap, allocation,
// envelope) each get their own confirm, and a second copy of that chain would
// drift from the first. The choices made here are handed to it prefilled.

import { useEffect, useMemo, useState } from 'react';
import { RunDraftPanel, type RunDraftStatus, type RunEstimate } from '@connorhoehnslalom/ui-components';
import { BranchIcon } from '@connorhoehnslalom/ui-components/shared';
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

export function RunDraft({
  item,
  codebases,
  run,
  canDispatch,
  showGrantCue,
  instruction,
  onEstimateSaved,
  onAuthorize,
}: {
  item: FlatWorkItem;
  codebases: Codebase[];
  /** This item's latest marketplace run, if any. */
  run: BotRun | undefined;
  canDispatch: boolean;
  /** An sme with no active sprint grant here — dispatch would 403. */
  showGrantCue: boolean;
  /** The instruction prepared in the composer, carried into the dispatch. */
  instruction: string;
  onEstimateSaved: (workItemId: string, saved: EstimateProvenance) => void;
  onAuthorize: (choice: RunChoice) => void;
}) {
  const [model, setModel] = useState(DEFAULT_DEVBOX_MODEL);
  const [agentProjectId, setAgentProjectId] = useState<string | null>(null);
  // The dispatch route's per-run cap (budgetPerRunUsd): the run is refused if
  // its forecast is over it. Blank means no cap — a cap is opt-in.
  const [capUsd, setCapUsd] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // A new item is a new draft: the last item's codebase may not deliver this one.
  useEffect(() => {
    setAgentProjectId(codebases.length === 1 ? codebases[0]!.id : null);
    setCapUsd(null);
  }, [item.id, codebases]);

  const est = useWorkEstimate(item, model, agentProjectId, canDispatch);
  const { cost, duration } = asEstimates(item, est, canDispatch);
  const modelLabel = DEVBOX_MODELS.find((m) => m.id === model)?.label ?? model;
  const codebase = codebases.find((c) => c.id === agentProjectId) ?? null;

  const status: RunDraftStatus = run?.status === 'running' ? 'running'
    : est.stored ? 'saved'
    : instruction.trim() ? 'unsaved'
    : 'no-draft';

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

  return (
    <RunDraftPanel
      status={status}
      className="min-h-full"
      // No target line when no codebase is readable: `null` would print the
      // library's "No workflow chosen", which is not what is missing here.
      target={codebases.length === 0
        ? undefined
        : {
            mark: <BranchIcon size={22} />,
            title: codebase?.repoFullName ?? 'Choose a codebase',
            subtitle: 'Where the agent works',
          }}
      fields={[
        {
          id: 'model',
          label: 'Model',
          value: model,
          options: DEVBOX_MODELS.map((m) => ({ value: m.id, label: m.label })),
          onChange: setModel,
        },
        ...(codebases.length > 1
          ? [{
              id: 'codebase',
              label: 'Codebase',
              value: agentProjectId ?? '',
              placeholder: 'Choose…',
              options: codebases.map((c) => ({ value: c.id, label: c.repoFullName })),
              onChange: (v: string) => setAgentProjectId(v || null),
            }]
          : []),
      ]}
      cost={cost}
      duration={duration}
      // A 'prior' forecast is a static per-tier bracket, not history: the
      // panel shows it marked low confidence rather than hiding it.
      confidence={est.estimate
        ? { sampleSize: est.estimate.sampleCount, basis: est.estimate.basis === 'prior' ? 'prior' : 'runs' }
        : null}
      budget={{
        unit: 'usd',
        usd: capUsd,
        onChange: setCapUsd,
        hint: capUsd != null && est.estimate && est.estimate.costUsdP75 > capUsd
          ? 'Below the forecast — the dispatch will ask you to confirm'
          : 'Not started if forecast above this',
        ...(canDispatch ? {} : { disabledReason: 'Your role cannot dispatch agents' }),
      }}
      access={!canDispatch
        ? {
            tone: 'info',
            title: 'Dispatch needs an SME or leader role',
            body: 'You can read this item and its plan; an SME with a sprint grant here, or a release manager, authorizes runs.',
          }
        : showGrantCue
        ? {
            tone: 'warning',
            title: 'Sprint access required',
            body: 'You hold no active sprint grant on this initiative, so a dispatch would be refused.',
            action: { label: 'Open sprints', href: '/iq/sprints' },
          }
        : null}
      onSave={() => { void save(); }}
      saving={saving}
      saveDisabledReason={!canDispatch ? 'Your role cannot record estimates'
        : est.stored ? `Already recorded on ${modelLabel}`
        : !est.estimate ? 'No forecast to record yet'
        : undefined}
      onDispatch={() => onAuthorize({ model, agentProjectId, capUsd })}
      dispatchDisabledReason={blocked}
      error={est.error && item.storyPoints != null ? est.error : null}
    />
  );
}
