// Prepare job, with no form (W-prepare, 2026-10-13). The whole job is derived
// from the work item — instruction, codebase, model, cap, forecast — and the
// docked composer asks only what needs a human, as ComposerPromptDeck prompts:
//
//   Dispatch with these settings?   1 Dispatch · 2 Change model · 3 Change cap
//                                   4 Edit instruction (· 5 Save estimate)
//   Change model                    the models as choices (1–3)
//   Change cap                      a number typed in the composer, or 1 No cap
//   Edit instruction                text typed in the composer, or 1 Keep it
//   Which codebase?                 the server's 409 options, as choices
//   <gate>                          a 409 from a money brake: its reason, its
//                                   own confirm flag (confirmOverRunBudget /
//                                   confirmOverAllocation / confirmOverEnvelope)
//   This job needs a sprint envelope
//                                   an SME with no grant here (the envelope
//                                   reads "No sprint grant here", or dispatch
//                                   answered 403): 1 Request budget · 2 Save for
//                                   later, inside the same card (no modal):
//                                   Choose → Draft request → Confirm → Done, or
//                                   Choose → Saved (approved 2026-10-28,
//                                   docs/claude-code-handoff-2026-10-28-ui.md)
//
// The server contract is the estimate drawer's, unchanged: POST
// /api/bots/dispatch-work with { workItemId, model, agentProjectId?,
// instruction?, budgetPerRunUsd? } plus only the flags confirmed so far.
// Confirmations ACCUMULATE across a chain; a 429 (concurrency) is not
// confirmable and stays on the card as an error. A 403 for a missing sprint
// grant is not confirmable either: it routes to the funding prompt, which files
// an ordinary access request (POST /api/access-requests/envelope) or saves the
// setup (PUT /api/bots/work-items/:id/job-draft). Neither grants money or runs
// anything, and nothing here says otherwise.
//
// Pure: no React, no fetch. `prepareJobPrompts` returns plain prompt objects
// whose `onAnswer` calls the injected actions, so a node test can answer them.

import { DEFAULT_DEVBOX_MODEL, DEVBOX_MODELS } from '../../lib/devboxModels.ts';
import {
  overAllocationBody,
  overEnvelopeBody,
  overRunBudgetBody,
  type ForecastConfidence,
  type OverAllocation,
  type OverEnvelope,
  type OverRunBudget,
  type WorkEstimate,
} from '../../lib/dispatchGates.ts';
import { envelopeForInitiative, hasKnownBurn, type EnvelopesResponse } from '../../lib/envelopeFormat.ts';
import { usd } from '../../lib/format.ts';
import type { AccessRequest } from '../../lib/accessRequests.ts';
import { JUSTIFICATION_MIN, openStatusText, quickRequestState, waitingOn } from '../projects/budgetAccessModel.ts';
import type { ComposerPrompt, ComposerPromptField, ComposerPromptResult } from '@connorhoehnslalom/ui-components/social/rich-composer';
import type { FlatWorkItem } from './projectFormat.ts';
import type { Codebase } from './types.ts';

/** A job, ready to dispatch. */
export interface PreparedJob {
  model: string;
  agentProjectId: string | null;
  /** The per-run cap (`budgetPerRunUsd`); null is no cap — a cap is opt-in. */
  capUsd: number | null;
  instruction: string;
}

type JobItem = Pick<FlatWorkItem, 'id' | 'title' | 'key' | 'summary' | 'description' | 'nextStep' | 'nextStepDetail' | 'estimateModel' | 'storyPoints' | 'status'>;

const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** What the agent is asked to do, from what the item already says. */
export function deriveInstruction(item: Pick<JobItem, 'title' | 'summary' | 'description' | 'nextStep' | 'nextStepDetail'>): string {
  const parts = [sentence(clean(item.title))];
  const summary = clean(item.summary);
  if (summary && summary !== clean(item.title)) parts.push(sentence(summary));
  const why = clean(item.description);
  if (why) parts.push(`Why: ${sentence(why)}`);
  const next = clean(item.nextStep);
  if (next) parts.push(`Start with: ${sentence(next)}${clean(item.nextStepDetail) ? ` ${sentence(clean(item.nextStepDetail))}` : ''}`);
  parts.push('Done when the change is in a pull request with passing checks and the acceptance criteria are met.');
  return parts.join(' ');
}

/**
 * The codebase: the only one delivering this initiative, else the one whose
 * repository is the initiative's linked repo. Several and no link: null — the
 * server answers with its options and the deck asks.
 */
export function deriveCodebase(codebases: readonly Codebase[], linkedRepo: string | null | undefined): string | null {
  if (codebases.length === 1) return codebases[0]!.id;
  const linked = linkedRepo ? codebases.find((c) => c.repoFullName.toLowerCase() === linkedRepo.toLowerCase()) : null;
  return linked?.id ?? null;
}

/** The model somebody recorded an estimate on, else the runtime's default. */
export function deriveModel(item: Pick<JobItem, 'estimateModel'>): string {
  return item.estimateModel && DEVBOX_MODELS.some((m) => m.id === item.estimateModel) ? item.estimateModel : DEFAULT_DEVBOX_MODEL;
}

export function deriveJob(input: { item: JobItem; codebases: readonly Codebase[]; linkedRepo?: string | null }): PreparedJob {
  return {
    model: deriveModel(input.item),
    agentProjectId: deriveCodebase(input.codebases, input.linkedRepo),
    capUsd: null,
    instruction: deriveInstruction(input.item),
  };
}

export const modelLabel = (id: string) => DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;

/** Why this item cannot be dispatched by this reader now, or null. */
export function dispatchBlockedReason(item: Pick<JobItem, 'storyPoints' | 'status'>, canDispatch: boolean): string | null {
  if (!canDispatch) return 'Your role cannot dispatch agents';
  if (item.storyPoints == null) return 'Size this item first';
  if (item.status !== 'open') return 'Only work that is up next can be dispatched';
  return null;
}

/** The forecast as read: a recorded estimate, a live one, loading, or why there is none. */
export interface ForecastRead {
  estimate: WorkEstimate | null;
  stored: boolean;
  loading: boolean;
  error: string | null;
}

function minutes(n: number) { return Math.max(1, Math.round(n)); }

export function forecastLabel(item: Pick<JobItem, 'storyPoints'>, forecast: ForecastRead, canDispatch: boolean): { value: string; tone?: ComposerPromptField['tone'] } {
  if (forecast.estimate) {
    const e = forecast.estimate;
    const range = `${usd(e.costUsdP25)}–${usd(e.costUsdP75)} · ${minutes(e.minutesP25)}–${minutes(e.minutesP75)} min`;
    return { value: forecast.stored ? `${range} · recorded` : e.basis === 'prior' ? `${range} · wide prior` : range };
  }
  if (!canDispatch) return { value: 'Needs dispatch rights' };
  if (item.storyPoints == null) return { value: 'Size this item first', tone: 'warning' };
  if (forecast.loading) return { value: 'Forecasting…' };
  return { value: forecast.error ? 'Forecast unavailable' : 'No forecast yet', tone: forecast.error ? 'warning' : undefined };
}

/** The envelope value an SME with no grant on this initiative reads. */
export const NO_GRANT_LABEL = 'No sprint grant here';

/** What is left of the reader's sprint envelope here, in one value. */
export function envelopeLabel(data: EnvelopesResponse | null, orgProjectId: string | null, role: string | undefined, forecast: WorkEstimate | null):
  { value: string; tone?: ComposerPromptField['tone'] } {
  if (!data) return { value: '…' };
  if (!data.resolved) return { value: 'Unknown', tone: 'warning' };
  const row = envelopeForInitiative(data, orgProjectId);
  if (!row) return role === 'sme' ? { value: NO_GRANT_LABEL, tone: 'danger' } : { value: 'Not braked by an envelope' };
  if (!hasKnownBurn(row)) return { value: `${usd(row.allocatedUsd)} · burn not attributed` };
  const over = forecast != null && forecast.costUsdP75 > row.remainingUsd!;
  return { value: `${usd(row.remainingUsd!)} left of ${usd(row.allocatedUsd)}`, tone: over ? 'warning' : 'success' };
}

/** The header card: Item, Codebase, Model, Run cap, Forecast, Envelope remaining. */
export function jobFields(input: {
  item: JobItem;
  job: PreparedJob;
  codebases: readonly Codebase[];
  forecast: ForecastRead;
  envelope: { value: string; tone?: ComposerPromptField['tone'] } | null;
  canDispatch: boolean;
}): ComposerPromptField[] {
  const { item, job, codebases, forecast, envelope, canDispatch } = input;
  const codebase = codebases.find((c) => c.id === job.agentProjectId);
  const fc = forecastLabel(item, forecast, canDispatch);
  const capOver = job.capUsd != null && forecast.estimate != null && forecast.estimate.costUsdP75 > job.capUsd;
  const fields: ComposerPromptField[] = [
    { label: 'Item', value: item.key ?? item.id, mono: true },
    { label: 'Codebase', value: codebase?.repoFullName ?? (codebases.length ? 'Asked at dispatch' : canDispatch ? 'No readable codebase' : 'Not shown to your role'), mono: !!codebase },
    { label: 'Model', value: modelLabel(job.model) },
    { label: 'Run cap', value: job.capUsd == null ? 'No cap' : usd(job.capUsd), ...(capOver ? { tone: 'warning' as const } : {}) },
    { label: 'Forecast', value: fc.value, ...(fc.tone ? { tone: fc.tone } : {}) },
  ];
  if (envelope) fields.push({ label: 'Envelope', value: envelope.value, ...(envelope.tone ? { tone: envelope.tone } : {}) });
  return fields;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export type GateKind = 'run-budget' | 'allocation' | 'envelope';
export type ConfirmFlag = 'confirmOverRunBudget' | 'confirmOverAllocation' | 'confirmOverEnvelope';
export const CONFIRM_FLAG: Record<GateKind, ConfirmFlag> = {
  'run-budget': 'confirmOverRunBudget',
  allocation: 'confirmOverAllocation',
  envelope: 'confirmOverEnvelope',
};

export type Confirms = Partial<Record<GateKind, boolean>>;

/** The dispatch route's body — the estimate drawer's exact shape. */
export function dispatchBody(itemId: string, job: PreparedJob, confirms: Confirms, agentProjectId?: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { workItemId: itemId, model: job.model };
  const target = agentProjectId ?? job.agentProjectId;
  if (target) body['agentProjectId'] = target;
  if (job.instruction.trim()) body['instruction'] = job.instruction.trim();
  if (job.capUsd != null) body['budgetPerRunUsd'] = job.capUsd;
  if (confirms['run-budget']) body['confirmOverRunBudget'] = true;
  if (confirms.allocation) body['confirmOverAllocation'] = true;
  if (confirms.envelope) body['confirmOverEnvelope'] = true;
  return body;
}

export interface DispatchPayload {
  run?: unknown;
  error?: string;
  options?: Array<{ id: string; repoFullName: string }>;
  gate?: GateKind;
  confidence?: ForecastConfidence;
  estimate?: WorkEstimate;
  runBudget?: { budgetPerRunUsd: number; costUsdP25?: number; costUsdP75?: number };
  allocation?: { allocatedUsd: number; spentUsd: number; remainingUsd: number };
  envelope?: { sprintName: string | null; allocatedUsd: number; attributedSpentUsd: number; remainingUsd: number; attributionAvailable: boolean };
}

export interface GateStop {
  gate: GateKind;
  flag: ConfirmFlag;
  title: string;
  /** The gate's reason, in the operator's terms (the drawer's own words). */
  body: string;
  fields: ComposerPromptField[];
}

export type DispatchOutcome =
  | { kind: 'dispatched'; run: unknown }
  | { kind: 'codebase'; options: Array<{ id: string; repoFullName: string }> }
  | { kind: 'gate'; stop: GateStop }
  /** 403 from the grant-scoped gate: the funding prompt, not an error. */
  | { kind: 'no-grant'; message: string }
  | { kind: 'refused'; message: string };

/** What a dispatch answer means — the drawer's four 409s, the 403 and the 429. */
export function readDispatchResponse(status: number, payload: DispatchPayload): DispatchOutcome {
  if (status === 409 && payload.options && payload.options.length > 0) return { kind: 'codebase', options: payload.options };
  if (status === 409 && payload.gate === 'run-budget' && payload.runBudget) {
    const over: OverRunBudget = { reason: payload.error ?? 'over the per-run cap', ...payload.runBudget };
    return { kind: 'gate', stop: {
      gate: 'run-budget', flag: CONFIRM_FLAG['run-budget'], title: 'Over the run cap you set', body: overRunBudgetBody(over),
      fields: [
        { label: 'Your cap', value: usd(over.budgetPerRunUsd) },
        ...(over.costUsdP25 != null && over.costUsdP75 != null ? [{ label: 'Forecast', value: `${usd(over.costUsdP25)}–${usd(over.costUsdP75)}`, tone: 'warning' as const }] : []),
      ],
    } };
  }
  if (status === 409 && payload.allocation) {
    const over: OverAllocation = { reason: payload.error ?? 'over the allocation', ...(payload.confidence ? { confidence: payload.confidence } : {}),
      ...(payload.estimate ? { estimate: payload.estimate } : {}), ...payload.allocation };
    return { kind: 'gate', stop: {
      gate: 'allocation', flag: CONFIRM_FLAG.allocation, title: "Over the initiative's monthly allocation", body: overAllocationBody(over),
      fields: [
        { label: 'Allocated', value: usd(over.allocatedUsd) },
        { label: 'Spent this month', value: usd(over.spentUsd) },
        { label: 'Left', value: usd(over.remainingUsd), tone: 'warning' },
      ],
    } };
  }
  if (status === 409 && payload.envelope) {
    const over: OverEnvelope = { reason: payload.error ?? 'over your sprint envelope', ...(payload.confidence ? { confidence: payload.confidence } : {}),
      ...(payload.estimate ? { estimate: payload.estimate } : {}), ...payload.envelope };
    return { kind: 'gate', stop: {
      gate: 'envelope', flag: CONFIRM_FLAG.envelope, title: 'Over your sprint envelope', body: overEnvelopeBody(over),
      fields: [
        { label: 'Envelope', value: over.sprintName ? `${usd(over.allocatedUsd)} · ${over.sprintName}` : usd(over.allocatedUsd) },
        { label: 'Spent by you', value: over.attributionAvailable ? usd(over.attributedSpentUsd) : 'Not attributed' },
        { label: 'Left', value: over.attributionAvailable ? usd(over.remainingUsd) : 'Unknown', tone: 'warning' },
      ],
    } };
  }
  if (status === 403) {
    // The grant-scoped gate's words (lib/bot-runner.ts); any other 403 stays a refusal.
    if (payload.error == null || /sprint grant/i.test(payload.error)) return { kind: 'no-grant', message: payload.error ?? 'You hold no active sprint grant on this initiative.' };
    return { kind: 'refused', message: payload.error };
  }
  if (status === 429) return { kind: 'refused', message: payload.error ?? 'Agent runs already in flight are at the concurrency ceiling. Try again shortly.' };
  if (status >= 200 && status < 300 && payload.run) return { kind: 'dispatched', run: payload.run };
  return { kind: 'refused', message: `Dispatch failed: ${payload.error ?? `HTTP ${status}`}` };
}

// ─── The prompts ─────────────────────────────────────────────────────────────

export type PrepareStep =
  | { kind: 'confirm' }
  | { kind: 'model' }
  | { kind: 'cap' }
  | { kind: 'instruction' }
  | { kind: 'codebase'; options: Array<{ id: string; repoFullName: string }> }
  | { kind: 'gate'; stop: GateStop }
  /** Dispatch answered 403 (no sprint grant): ask for budget or save for later. */
  | { kind: 'funding' };

export interface PrepareJobActions {
  /** POST the job (with the confirms so far, and a codebase picked from a 409). */
  dispatch: (agentProjectId?: string) => Promise<ComposerPromptResult>;
  edit: (step: 'model' | 'cap' | 'instruction') => void;
  setModel: (id: string) => void;
  setCap: (usd: number | null) => void;
  setInstruction: (text: string) => void;
  /** Confirm one gate's flag and dispatch again. */
  confirmGate: (gate: GateKind) => Promise<ComposerPromptResult>;
  /** Back to the job (a cancelled gate, a codebase not picked). */
  back: () => void;
  /** Record the live forecast on the item (no dispatch). Absent: not offered. */
  saveEstimate?: () => Promise<ComposerPromptResult>;
  /** File the envelope request with the confirmed message (POST /api/access-requests/envelope). */
  requestBudget: (justification: string, requestedUsd: number) => Promise<ComposerPromptResult>;
  /** Keep the job on the item (PUT …/job-draft). */
  saveDraft: () => Promise<{ error: string } | { ok: true }>;
}

export interface PrepareJobView {
  item: JobItem;
  job: PreparedJob;
  fields: ComposerPromptField[];
  step: PrepareStep;
  /** Bumped on every step change and every explicit request, so a re-asked question is a new prompt. */
  rev: number;
  canDispatch: boolean;
  blocked: string | null;
  forecast: ForecastRead;
  /** A running job for this item. */
  running: boolean;
  /** An SME without a grant can ask for one here; null: no initiative to ask on. */
  funding?: FundingView | null;
}

/** What the funding prompt reads. */
export interface FundingView {
  /** The reader's envelope reads "No sprint grant here" (the prompt shows without a dispatch first). */
  noGrant: boolean;
  /** The budget holder's name when the page knows it; else the message says "the budget holder". */
  holder: string | null;
  /** The reader's envelope requests on this initiative (GET /api/access-requests/mine), newest first; null: not read yet. */
  requests: readonly AccessRequest[] | null;
}

export const READ_ONLY_REASON = 'An SME with a sprint grant on this initiative, or a release manager, authorizes jobs. You can see the setup it would run with.';

/** The deck's prompts for this item — only the question that needs a human now. */
export function prepareJobPrompts(view: PrepareJobView, actions: PrepareJobActions): ComposerPrompt[] {
  const { item, job, fields, step, rev, canDispatch, blocked, forecast } = view;
  const title = item.title;
  const eyebrow = canDispatch ? 'Prepare job' : 'Job setup';
  const id = (what: string) => `prepare-job:${item.id}:${what}:${rev}`;

  const funding = canDispatch && view.funding && (step.kind === 'funding' || (step.kind === 'confirm' && view.funding.noGrant)) ? view.funding : null;
  if (funding) return [fundingPrompt(view, funding, actions, id('funding'))];

  if (!canDispatch || step.kind === 'confirm' || step.kind === 'funding') {
    const saveable = !!actions.saveEstimate && canDispatch && !!forecast.estimate && !forecast.stored;
    return [{
      id: id('confirm'), eyebrow, title, fields,
      question: !canDispatch ? 'The job this item would run with.'
        : view.running ? 'A job is already running for this item. Dispatch another with these settings?' : 'Dispatch with these settings?',
      kind: 'choice',
      options: [
        { id: 'dispatch', label: 'Dispatch', emphasis: 'primary', ...(blocked ? { disabledReason: blocked } : {}) },
        { id: 'model', label: 'Change model' },
        { id: 'cap', label: 'Change cap' },
        { id: 'instruction', label: 'Edit instruction', hint: job.instruction },
        ...(saveable ? [{ id: 'save', label: 'Save estimate', hint: 'Record this forecast on the item; nothing runs' }] : []),
      ],
      ...(blocked ? {} : { defaultOptionId: 'dispatch' }),
      ...(canDispatch ? {} : { readOnlyReason: READ_ONLY_REASON }),
      onAnswer: async (answer) => {
        const choice = answer.optionId;
        if (choice === 'dispatch') return actions.dispatch();
        if (choice === 'save' && actions.saveEstimate) return actions.saveEstimate();
        if (choice === 'model' || choice === 'cap' || choice === 'instruction') { actions.edit(choice); return { receipt: `${title}: ${choice === 'cap' ? 'change cap' : choice === 'model' ? 'change model' : 'edit instruction'}` }; }
        return { error: 'Pick one of the options.' };
      },
    }];
  }

  if (step.kind === 'model') {
    const options = DEVBOX_MODELS.map((m) => ({ id: m.id, label: m.label, hint: m.hint }));
    return [{
      id: id('model'), eyebrow, title: 'Model', fields: fields.filter((f) => f.label === 'Model' || f.label === 'Forecast'),
      question: `Which model runs "${title}"?`, kind: 'choice', options, defaultOptionId: job.model,
      onAnswer: (answer) => { if (!answer.optionId) return { error: 'Pick a model.' }; actions.setModel(answer.optionId); return { receipt: `Model → ${modelLabel(answer.optionId)}` }; },
    }];
  }

  if (step.kind === 'cap') {
    const high = forecast.estimate?.costUsdP75;
    const capFields = fields.filter((f) => f.label === 'Run cap' || f.label === 'Forecast');
    const saveCap = (cap: number | null) => {
      actions.setCap(cap);
      return { receipt: `Run cap → ${cap == null ? 'no cap' : usd(cap)}` };
    };
    return [{
      id: id('cap'), eyebrow, title: 'Run cap', fields: capFields,
      question: 'Choose a cap for this run. A cap below the forecast asks you to confirm at dispatch.',
      kind: 'choice',
      options: [
        { id: 'none', label: 'No cap' },
        ...(high != null ? [{ id: 'forecast', label: `Forecast high (${usd(high)})` }] : []),
        { id: 'custom', label: 'Custom amount' },
      ],
      defaultOptionId: job.capUsd == null ? 'none' : undefined,
      onAnswer: (answer) => {
        if (answer.optionId === 'none') return saveCap(null);
        if (answer.optionId === 'forecast' && high != null) return saveCap(high);
        if (answer.optionId === 'custom') return { next: {
          id: id('cap-amount'), eyebrow, title: 'Custom run cap', fields: capFields,
          question: 'Type the dollar amount below and press Enter. A cap below the forecast asks you to confirm at dispatch.',
          kind: 'number', min: 0, placeholder: 'A dollar amount, e.g. 2.50',
          onAnswer: (typed) => typed.kind === 'number'
            ? saveCap(Math.round(typed.value * 100) / 100)
            : { error: 'Type a dollar amount.' },
        } };
        return { error: 'Choose a cap or Custom amount.' };
      },
    }];
  }

  if (step.kind === 'instruction') {
    return [{
      id: id('instruction'), eyebrow, title: 'Instruction', fields: [{ label: 'Now', value: job.instruction }],
      question: 'Type the instruction in the composer and press Enter, or keep the derived one.',
      kind: 'text', placeholder: 'What should the agent change, and how will you verify it?',
      options: [{ id: 'keep', label: 'Keep it' }], defaultOptionId: 'keep',
      onAnswer: (answer) => {
        if (answer.kind === 'text') { actions.setInstruction(answer.text); return { receipt: 'Instruction updated' }; }
        actions.back();
        return { receipt: 'Instruction kept' };
      },
    }];
  }

  if (step.kind === 'codebase') {
    return [{
      id: id('codebase'), eyebrow, title: 'Which codebase?', fields,
      question: 'Several codebases deliver this initiative. Which one should this job change?',
      kind: 'choice',
      options: [...step.options.slice(0, 8).map((o) => ({ id: o.id, label: o.repoFullName })), { id: 'back', label: 'Back to the job' }],
      onAnswer: (answer) => (answer.optionId === 'back' || !answer.optionId ? (actions.back(), { receipt: 'Back to the job' }) : actions.dispatch(answer.optionId)),
    }];
  }

  // A money brake: its reason, and only its own flag.
  const stop = step.stop;
  return [{
    id: id(`gate-${stop.gate}`), eyebrow: `Budget gate · ${stop.flag}`, title: stop.title, fields: stop.fields,
    question: `${stop.body} Dispatch anyway?`,
    kind: 'confirm',
    options: [{ id: 'confirm', label: 'Dispatch anyway', emphasis: 'danger' }, { id: 'cancel', label: 'Back to the job' }],
    onAnswer: (answer) => {
      if (answer.kind === 'confirm' && answer.confirmed) return actions.confirmGate(stop.gate);
      actions.back();
      return { receipt: `${stop.title}: not dispatched` };
    },
  }];
}

// ─── Funding: no sprint grant here ───────────────────────────────────────────

export const FUNDING_STEPS: readonly string[] = ['Choose', 'Draft request', 'Confirm', 'Done'];
export const SAVED_STEPS: readonly string[] = ['Choose', 'Saved'];
export const NO_FORECAST_REASON = 'Get a forecast first';

/** The dollars asked for: the forecast's high end, rounded up to the cent; null without a usable forecast. */
export function requestedUsdFor(estimate: WorkEstimate | null | undefined): number | null {
  if (!estimate || !Number.isFinite(estimate.costUsdP75) || estimate.costUsdP75 <= 0) return null;
  // Round away float noise first (1.1 * 100 is 110.00000000000001), then up to the cent.
  return Math.ceil(Math.round(estimate.costUsdP75 * 1e6) / 1e4) / 100;
}

/** The prefilled message: who it is for, the work item, the forecast and the ask. */
export function fundingMessage(input: { holder: string | null; item: Pick<JobItem, 'id' | 'key' | 'title'>; model: string; estimate: WorkEstimate; requestedUsd: number }): string {
  const { holder, item, model, estimate, requestedUsd } = input;
  return `Hi${holder ? ` ${holder}` : ''}, I'd like a sprint envelope on this initiative so an agent can take ${item.key ?? item.id} "${clean(item.title)}". `
    + `The forecast is ${usd(estimate.costUsdP25)}–${usd(estimate.costUsdP75)} on ${modelLabel(model)}, so I'm asking for ${usd(requestedUsd)}.`;
}

/** Why the message cannot be filed yet, or null. The server checks the same and is the authority. */
export function justificationProblem(message: string): string | null {
  const n = message.trim().length;
  return n < JUSTIFICATION_MIN ? `Say why in at least ${JUSTIFICATION_MIN} characters (${n} so far)` : null;
}

/** POST /api/access-requests/envelope's body (docs/access-tenant-api.md, sprint envelopes). */
export function envelopeRequestBody(input: { initiativeId: string; justification: string; requestedUsd: number; workItemId: string; model: string; estimate: WorkEstimate | null }): Record<string, unknown> {
  const { initiativeId, justification, requestedUsd, workItemId, model, estimate } = input;
  return {
    initiativeId, justification: justification.trim(), requestedUsd,
    forecast: { workItemId, model, costUsdP25: estimate?.costUsdP25 ?? null, costUsdP75: estimate?.costUsdP75 ?? null },
  };
}

export type EnvelopeRequestOutcome =
  | { kind: 'filed'; request: AccessRequest }
  | { kind: 'already'; requestId: string }
  | { kind: 'failed'; message: string };

/** What the envelope route answered: filed (201), already open (409 + requestId), or not filed. */
export function readEnvelopeResponse(status: number, payload: Partial<AccessRequest> & { error?: string; requestId?: string }): EnvelopeRequestOutcome {
  if (status >= 200 && status < 300 && typeof payload.id === 'string') return { kind: 'filed', request: payload as AccessRequest };
  if (status === 409 && typeof payload.requestId === 'string') return { kind: 'already', requestId: payload.requestId };
  return { kind: 'failed', message: payload.error ?? `HTTP ${status}` };
}

/** The done stage's line (or the inline error). A filed request is a request: it grants nothing and runs nothing. */
export function envelopeResult(outcome: EnvelopeRequestOutcome): ComposerPromptResult {
  if (outcome.kind === 'failed') return { error: `Request not filed: ${outcome.message}` };
  if (outcome.kind === 'already') return { receipt: 'Already requested · your open request on this initiative still stands. Nothing runs until an envelope is granted.' };
  const who = Array.isArray(outcome.request.steps) ? waitingOn(outcome.request) : 'an approver';
  return { receipt: `Request filed · waiting on ${who}. Nothing runs until an envelope is granted.` };
}

/** The reader's newest envelope request, as a status line; null when they may ask (none, or the last one closed). */
export function fundingStatus(requests: readonly AccessRequest[] | null | undefined): string | null {
  const state = quickRequestState(requests);
  if (state.kind === 'open') return openStatusText(state);
  if (state.kind === 'approved' || state.kind === 'granted') return 'Approved — waiting for the envelope to reach your session';
  return null;
}

/** PUT /api/bots/work-items/:id/job-draft's body. */
export function jobDraftBody(job: PreparedJob): Record<string, unknown> {
  return { model: job.model, budgetPerRunUsd: job.capUsd, instruction: job.instruction.trim() || null, agentProjectId: job.agentProjectId };
}

/** A saved draft as job edits (GET …/job-draft): only what it actually recorded. */
export function jobFromDraft(draft: { model?: string | null; budgetPerRunUsd?: number | null; instruction?: string | null; agentProjectId?: string | null } | null | undefined): Partial<PreparedJob> {
  if (!draft) return {};
  const job: Partial<PreparedJob> = { capUsd: draft.budgetPerRunUsd ?? null };
  if (draft.model && DEVBOX_MODELS.some((m) => m.id === draft.model)) job.model = draft.model;
  if (draft.instruction && draft.instruction.trim()) job.instruction = draft.instruction;
  if (draft.agentProjectId) job.agentProjectId = draft.agentProjectId;
  return job;
}

function fundingPrompt(view: PrepareJobView, funding: FundingView, actions: PrepareJobActions, promptId: string): ComposerPrompt {
  const { item, job, fields, forecast } = view;
  const status = fundingStatus(funding.requests);
  const requestedUsd = requestedUsdFor(forecast.estimate);
  const requestOff = status ?? (requestedUsd == null ? NO_FORECAST_REASON : null);
  const holder = funding.holder?.trim() || null;
  const pick = (label: string) => fields.filter((f) => f.label === label);

  const compose: ComposerPrompt | null = requestedUsd != null && forecast.estimate ? {
    id: `${promptId}:request`, eyebrow: 'Prepare job', title: 'Request budget',
    fields: [...pick('Item'), ...pick('Forecast'), { label: 'Requested', value: usd(requestedUsd) }],
    question: 'Edit the message, then review it before it is filed.',
    kind: 'compose',
    path: { steps: FUNDING_STEPS, current: 1 },
    compose: {
      initialMessage: fundingMessage({ holder, item, model: job.model, estimate: forecast.estimate, requestedUsd }),
      recipient: `To ${holder ?? 'the budget holder'} · ${item.key ?? item.id}`,
      reviewTitle: 'Confirm budget request',
      continueLabel: 'Review request',
      confirmLabel: 'Confirm request',
      doneActionLabel: 'Close',
      note: `Confirming files an access request for ${usd(requestedUsd)}. It does not grant funding or start the job.`,
    },
    onAnswer: (answer) => {
      if (answer.kind !== 'compose') return { error: 'Confirm the message to file the request.' };
      const problem = justificationProblem(answer.message);
      if (problem) return { error: problem };
      return actions.requestBudget(answer.message.trim(), requestedUsd);
    },
  } : null;

  const saved: ComposerPrompt = {
    id: `${promptId}:saved`, eyebrow: 'Prepare job', title: 'Saved for later',
    fields: [...pick('Model'), ...pick('Run cap')],
    question: 'The setup is saved on the item; Prepare job opens with it next time. Nothing runs and nothing is requested.',
    kind: 'choice',
    path: { steps: SAVED_STEPS, current: 1 },
    options: [{ id: 'close', label: 'Close', emphasis: 'primary' }],
    defaultOptionId: 'close',
    onAnswer: () => ({ receipt: `Saved for later · ${item.key ?? item.id}` }),
  };

  return {
    id: promptId, eyebrow: 'Prepare job', title: 'This job needs a sprint envelope',
    fields: status ? [...fields, { label: 'Request', value: status, tone: 'info' }] : fields,
    question: status
      ? 'Your envelope request is open. Nothing runs until an envelope is granted; you can save this setup for later.'
      : 'You hold no sprint grant on this initiative, so this job cannot run yet. Request budget from the budget holder, or save the setup for later.',
    kind: 'choice',
    path: { steps: FUNDING_STEPS, current: 0 },
    options: [
      { id: 'request', label: 'Request budget', emphasis: 'primary', ...(requestOff ? { disabledReason: requestOff } : {}) },
      { id: 'save', label: 'Save for later', hint: 'Keep this setup on the item; nothing runs' },
    ],
    ...(requestOff ? {} : { defaultOptionId: 'request' }),
    onAnswer: async (answer) => {
      if (answer.optionId === 'request') return compose && !requestOff ? { next: compose } : { error: requestOff ?? NO_FORECAST_REASON };
      if (answer.optionId === 'save') {
        const result = await actions.saveDraft();
        return 'error' in result ? result : { next: saved };
      }
      return { error: 'Pick one of the options.' };
    },
  };
}

// ─── After dispatch: the run, in the same box ────────────────────────────────

/** The dispatched run's path. "Result ready" completes it; a stopped run halts at "Agent working". */
export const RUN_STEPS: readonly string[] = ['Dispatched', 'Agent working', 'Result ready'];

/** What the run card reads from the item's latest marketplace run (BotRun). */
export interface TrackedRun {
  id: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  costUsd: number | null;
  outcome?: { reason?: string; summary?: string; prUrl?: string } | null;
}

export interface RunPromptActions {
  /** Dispatch the same job again; every budget gate asks again if it applies. */
  retry: () => Promise<ComposerPromptResult>;
  /** Back to the job's settings (change model, cap or instruction first). */
  back: () => void;
  /** Close the card; the run carries on (or stays finished) without it. */
  dismiss: () => void;
}

/**
 * The run card that replaces the job once a dispatch is accepted: one path,
 * Dispatched → Agent working → Result ready, advanced by the polled run. A
 * failed or skipped run stops at Agent working and offers Retry inside the
 * same card (no modal, no navigation). Its id carries the status, so each
 * change is a new question rather than a stale one.
 */
export function runPrompt(input: { item: Pick<JobItem, 'id' | 'title'>; run: TrackedRun; model: string }, actions: RunPromptActions): ComposerPrompt {
  const { item, run, model } = input;
  const id = `prepare-job:${item.id}:run-${run.status}:${run.id}`;
  const cost = run.costUsd != null ? [{ label: 'Cost', value: usd(run.costUsd) }] : [];
  const dismiss = { id: 'dismiss', label: 'Dismiss' };
  const close = () => { actions.dismiss(); return { receipt: `${item.title}: run card closed` }; };

  if (run.status === 'running') {
    return {
      id, eyebrow: 'Job', title: item.title,
      fields: [{ label: 'Model', value: modelLabel(model) }, { label: 'Status', value: 'Agent working', tone: 'info' }],
      path: { steps: RUN_STEPS, current: 1 },
      question: 'The agent is working on this item. This card follows the run; you can keep typing.',
      kind: 'choice', options: [dismiss],
      onAnswer: close,
    };
  }

  if (run.status === 'done') {
    const summary = run.outcome?.summary ? [{ label: 'Summary', value: run.outcome.summary }] : [];
    const pr = run.outcome?.prUrl ? [{ label: 'Change', value: run.outcome.prUrl.replace(/^https:\/\/github\.com\//, ''), mono: true }] : [];
    return {
      id, eyebrow: 'Job', title: 'Result ready',
      fields: [{ label: 'Status', value: 'Finished', tone: 'success' }, ...summary, ...pr, ...cost],
      path: { steps: RUN_STEPS, current: RUN_STEPS.length },
      question: `The agent finished "${item.title}". Review the change before merging it.`,
      kind: 'choice', options: [dismiss], defaultOptionId: 'dismiss',
      onAnswer: close,
    };
  }

  const skipped = run.status === 'skipped';
  const reason = run.outcome?.reason ? [{ label: 'Reason', value: run.outcome.reason, tone: 'danger' as const }] : [];
  return {
    id, eyebrow: 'Job · stopped',
    title: skipped ? 'The run did not start' : 'Stopped while the agent was working',
    fields: [...reason, ...cost, { label: 'Model', value: modelLabel(model) }],
    path: { steps: RUN_STEPS, current: 1 },
    question: 'Retry with the same settings? A budget gate asks again if one applies.',
    kind: 'choice',
    options: [
      { id: 'retry', label: 'Retry', emphasis: 'primary' },
      { id: 'back', label: 'Back to the job', hint: 'Change the model, cap or instruction first' },
      dismiss,
    ],
    defaultOptionId: 'retry',
    onAnswer: (answer) => {
      if (answer.optionId === 'retry') return actions.retry();
      if (answer.optionId === 'back') { actions.back(); return { receipt: 'Back to the job' }; }
      return close();
    },
  };
}
