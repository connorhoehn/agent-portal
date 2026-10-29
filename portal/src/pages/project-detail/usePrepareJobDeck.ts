// The Prepare job deck's state and requests: the job derived from the work
// item (prepareJobModel), the live forecast, the reader's envelope, and the
// dispatch POST with its accumulating confirm flags. Returns the prompts the
// page hands the docked composer (`InitiativeComposer prompts`); the words and
// the rules are all in prepareJobModel.ts. An SME with no grant here gets the
// funding prompt instead: the envelope request (POST
// /api/access-requests/envelope, status from GET …/mine) or Save for later
// (PUT /api/bots/work-items/:id/job-draft, loaded back when the deck opens).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerPrompt, ComposerPromptResult } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { useFetch } from '../../hooks/useFetch';
import { storedEstimateFor, type EstimateProvenance, type WorkEstimate } from '../../lib/dispatchGates';
import type { EnvelopesResponse } from '../../lib/envelopeFormat';
import { usd } from '../../lib/format';
import type { AccessRequest } from '../../lib/accessRequests';
import { QUICK_REQUEST_API, mineUrl } from '../projects/budgetAccessModel';
import type { BotRun } from '../bots/BotsPage';
import {
  deriveJob,
  dispatchBlockedReason,
  dispatchBody,
  envelopeLabel,
  envelopeRequestBody,
  envelopeResult,
  jobDraftBody,
  jobFields,
  jobFromDraft,
  NO_GRANT_LABEL,
  readEnvelopeResponse,
  modelLabel,
  prepareJobPrompts,
  readDispatchResponse,
  type Confirms,
  type DispatchPayload,
  type EnvelopeRequestOutcome,
  type ForecastRead,
  type GateKind,
  type PreparedJob,
  type PrepareStep,
} from './prepareJobModel';
import type { FlatWorkItem } from './projectFormat';
import type { Codebase } from './types';

/** The live forecast for one item at one model — or the recorded one, which is
 *  a decision with an author and is never recomputed over. */
function useForecast(item: FlatWorkItem | null, model: string, agentProjectId: string | null, enabled: boolean): ForecastRead {
  const stored = useMemo(() => (item ? storedEstimateFor(item, model) : null), [item, model]);
  const [live, setLive] = useState<{ key: string; estimate: WorkEstimate | null; error: string | null } | null>(null);
  const key = item ? `${item.id}|${item.storyPoints}|${model}|${agentProjectId ?? ''}` : '';
  useEffect(() => {
    if (!item || !enabled || stored || item.storyPoints == null) return;
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
  }, [key, enabled, stored]); // eslint-disable-line react-hooks/exhaustive-deps
  if (stored) return { estimate: stored, stored: true, loading: false, error: null };
  // The estimate route is dispatch-gated; a role without it gets no forecast
  // rather than a request it can only lose.
  if (!item || !enabled || item.storyPoints == null) return { estimate: null, stored: false, loading: false, error: null };
  const current = live?.key === key ? live : null;
  return { estimate: current?.estimate ?? null, stored: false, loading: current == null, error: current?.error ?? null };
}

export interface PrepareJobDeckInput {
  /** The open work item; null: no deck. */
  item: FlatWorkItem | null;
  codebases: readonly Codebase[];
  /** The initiative's linked repository (`owner/name`), which picks among several codebases. */
  linkedRepo: string | null;
  /** The initiative the run is charged to (envelope pre-flight). */
  orgProjectId: string | null;
  canDispatch: boolean;
  role: string | undefined;
  /** This item's latest marketplace run, if any. */
  run: BotRun | undefined;
  /** "Prepare job" / "View job setup" from the header menu: show (or re-show) the deck. */
  request: { itemId: string; revision: number } | null;
  onDispatched: (workItemId: string, run: BotRun) => void;
  onEstimateSaved: (workItemId: string, saved: EstimateProvenance) => void;
  /** Who holds the initiative's budget, when the page knows; the request message names them. */
  budgetHolder?: string | null;
}

export function usePrepareJobDeck(input: PrepareJobDeckInput): ComposerPrompt[] {
  const { item, codebases, linkedRepo, orgProjectId, canDispatch, role, run, request, onDispatched, onEstimateSaved, budgetHolder } = input;
  const itemId = item?.id ?? null;
  const derived = useMemo(() => (item ? deriveJob({ item, codebases, linkedRepo }) : null),
    // The job is derived per item; a codebase list that arrives late fills the codebase only.
    [itemId, codebases.map((c) => c.id).join(','), linkedRepo]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edits, setEdits] = useState<{ itemId: string; job: Partial<PreparedJob> } | null>(null);
  const job: PreparedJob | null = derived ? { ...derived, ...(edits?.itemId === itemId ? edits.job : {}) } : null;
  const [step, setStep] = useState<PrepareStep>({ kind: 'confirm' });
  const [rev, setRev] = useState(0);
  const confirms = useRef<Confirms>({});
  // Shown on its own for a dispatcher on work that is up next; otherwise on request.
  const blocked = item ? dispatchBlockedReason(item, canDispatch) : 'No work item';
  const running = run?.status === 'running';
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<string | null>(null);

  // A different item starts a new job.
  useEffect(() => {
    setStep({ kind: 'confirm' });
    confirms.current = {};
    setRev((r) => r + 1);
  }, [itemId]);

  const lastRequest = useRef<typeof request>(null);
  useEffect(() => {
    if (!request || request === lastRequest.current || request.itemId !== itemId) return;
    lastRequest.current = request;
    setShownFor(itemId);
    setDoneFor(null);
    setStep({ kind: 'confirm' });
    setRev((r) => r + 1);
  }, [request, itemId]);

  // A setup saved for later comes back as the job's edits when the deck opens
  // for the item (and again on every Prepare job).
  const draftRequest = request?.itemId === itemId ? request?.revision : undefined;
  useEffect(() => {
    if (!itemId || !canDispatch) return;
    let cancelled = false;
    fetch(`/api/bots/work-items/${encodeURIComponent(itemId)}/job-draft`, { credentials: 'include' })
      .then(async (res) => (res.ok ? await res.json().catch(() => ({})) as { draft?: Parameters<typeof jobFromDraft>[0] } : {}))
      .then((body) => {
        if (cancelled || !body.draft) return;
        setEdits({ itemId, job: jobFromDraft(body.draft) });
        confirms.current = {};
      })
      .catch(() => { /* no draft read: the derived job stands */ });
    return () => { cancelled = true; };
  }, [itemId, canDispatch, draftRequest]);

  const forecast = useForecast(item, job?.model ?? '', job?.agentProjectId ?? null, canDispatch);
  const { data: envelopes } = useFetch<EnvelopesResponse>(item && canDispatch ? '/api/sprints/envelopes' : null);
  const envelope = item && canDispatch ? envelopeLabel(envelopes ?? null, orgProjectId, role, forecast.estimate) : null;
  // The funding prompt's status read: only for a reader who may need to ask.
  const mayAsk = !!item && canDispatch && !!orgProjectId && (envelope?.value === NO_GRANT_LABEL || step.kind === 'funding');
  const { data: mine, refresh: refreshMine } = useFetch<{ items?: AccessRequest[] }>(mayAsk ? mineUrl(`envelope:${orgProjectId}`) : null);

  const to = useCallback((next: PrepareStep) => { setStep(next); setRev((r) => r + 1); }, []);
  const edit = useCallback((patch: Partial<PreparedJob>) => {
    if (!itemId) return;
    setEdits((prev) => ({ itemId, job: { ...(prev?.itemId === itemId ? prev.job : {}), ...patch } }));
    // A changed job is a new authorization: nothing confirmed for the old one carries.
    confirms.current = {};
    to({ kind: 'confirm' });
  }, [itemId, to]);

  const dispatch = useCallback(async (agentProjectId?: string): Promise<ComposerPromptResult> => {
    if (!item || !job) return { error: 'No work item is open.' };
    // A codebase picked from the server's options is part of the job from now on
    // (a gate's retry must send it again).
    if (agentProjectId) setEdits((prev) => ({ itemId: item.id, job: { ...(prev?.itemId === item.id ? prev.job : {}), agentProjectId } }));
    let res: Response;
    try {
      res = await fetch('/api/bots/dispatch-work', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dispatchBody(item.id, job, confirms.current, agentProjectId)),
      });
    } catch (err) {
      return { error: `Dispatch failed: ${(err as Error).message}` };
    }
    const payload = await res.json().catch(() => ({})) as DispatchPayload;
    const outcome = readDispatchResponse(res.status, payload);
    if (outcome.kind === 'refused') return { error: outcome.message };
    if (outcome.kind === 'no-grant') {
      if (!orgProjectId) return { error: outcome.message };
      to({ kind: 'funding' });
      return { receipt: 'Needs a sprint envelope' };
    }
    if (outcome.kind === 'codebase') { to({ kind: 'codebase', options: outcome.options }); return { receipt: 'Needs a codebase' }; }
    if (outcome.kind === 'gate') { to({ kind: 'gate', stop: outcome.stop }); return { receipt: `Needs your confirmation · ${outcome.stop.title}` }; }
    confirms.current = {};
    setDoneFor(item.id);
    onDispatched(item.id, outcome.run as BotRun);
    return { receipt: `Dispatched · "${item.title}" is in progress on ${modelLabel(job.model)}` };
  }, [item, job, to, onDispatched, orgProjectId]);

  const confirmGate = useCallback(async (gate: GateKind) => {
    confirms.current = { ...confirms.current, [gate]: true };
    return dispatch(job?.agentProjectId ?? undefined);
  }, [dispatch, job?.agentProjectId]);

  const saveEstimate = useCallback(async (): Promise<ComposerPromptResult> => {
    if (!item || !job || !forecast.estimate) return { error: 'No forecast to record yet.' };
    try {
      const res = await fetch(`/api/bots/work-items/${encodeURIComponent(item.id)}/estimate`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: job.model, estimate: forecast.estimate }),
      });
      const body = await res.json().catch(() => ({})) as { item?: EstimateProvenance; error?: string };
      if (!res.ok) return { error: `Estimate not saved: ${body.error ?? `HTTP ${res.status}`}` };
      if (body.item) onEstimateSaved(item.id, body.item);
      to({ kind: 'confirm' });
      return { receipt: `Estimate saved · ${usd(forecast.estimate.costUsdP25)}–${usd(forecast.estimate.costUsdP75)} on ${modelLabel(job.model)}` };
    } catch (err) {
      return { error: `Estimate not saved: ${(err as Error).message}` };
    }
  }, [item, job, forecast.estimate, onEstimateSaved, to]);

  // The envelope request. A filed request changes nothing the prompt ids read,
  // so the card stays on its Done stage until the reader closes it; the status
  // read refreshes behind it.
  const requestBudget = useCallback(async (justification: string, requestedUsd: number): Promise<ComposerPromptResult> => {
    if (!item || !job || !orgProjectId) return { error: 'Request not filed: no initiative to ask on.' };
    let outcome: EnvelopeRequestOutcome;
    try {
      const res = await fetch(`${QUICK_REQUEST_API}/envelope`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelopeRequestBody({ initiativeId: orgProjectId, justification, requestedUsd, workItemId: item.id, model: job.model, estimate: forecast.estimate })),
      });
      outcome = readEnvelopeResponse(res.status, await res.json().catch(() => ({})));
    } catch (err) {
      outcome = { kind: 'failed', message: (err as Error).message };
    }
    if (outcome.kind !== 'failed') refreshMine();
    return envelopeResult(outcome);
  }, [item, job, orgProjectId, forecast.estimate, refreshMine]);

  const saveDraft = useCallback(async (): Promise<{ error: string } | { ok: true }> => {
    if (!item || !job) return { error: 'No work item is open.' };
    try {
      const res = await fetch(`/api/bots/work-items/${encodeURIComponent(item.id)}/job-draft`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobDraftBody(job)),
      });
      if (res.ok) return { ok: true };
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { error: `Not saved: ${body.error ?? `HTTP ${res.status}`}` };
    } catch (err) {
      return { error: `Not saved: ${(err as Error).message}` };
    }
  }, [item, job]);

  if (!item || !job) return [];
  const open = shownFor === item.id || (canDispatch && !blocked && !running);
  if (!open || doneFor === item.id) return [];
  return prepareJobPrompts({
    item, job, step, rev, canDispatch, blocked, forecast, running,
    fields: jobFields({ item, job, codebases, forecast, envelope, canDispatch }),
    funding: orgProjectId ? { noGrant: envelope?.value === NO_GRANT_LABEL, holder: budgetHolder ?? null, requests: mine?.items ?? null } : null,
  }, {
    dispatch,
    edit: (what) => to({ kind: what }),
    setModel: (model) => edit({ model }),
    setCap: (capUsd) => edit({ capUsd }),
    setInstruction: (instruction) => edit({ instruction }),
    confirmGate,
    back: () => to({ kind: 'confirm' }),
    saveEstimate,
    requestBudget,
    saveDraft,
  });
}
