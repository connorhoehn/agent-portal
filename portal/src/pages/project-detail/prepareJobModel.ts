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
//
// The server contract is the estimate drawer's, unchanged: POST
// /api/bots/dispatch-work with { workItemId, model, agentProjectId?,
// instruction?, budgetPerRunUsd? } plus only the flags confirmed so far.
// Confirmations ACCUMULATE across a chain; a 403 (no sprint grant) and a 429
// (concurrency) are not confirmable and stay on the card as errors.
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

/** What is left of the reader's sprint envelope here, in one value. */
export function envelopeLabel(data: EnvelopesResponse | null, orgProjectId: string | null, role: string | undefined, forecast: WorkEstimate | null):
  { value: string; tone?: ComposerPromptField['tone'] } {
  if (!data) return { value: '…' };
  if (!data.resolved) return { value: 'Unknown', tone: 'warning' };
  const row = envelopeForInitiative(data, orgProjectId);
  if (!row) return role === 'sme' ? { value: 'No sprint grant here', tone: 'danger' } : { value: 'Not braked by an envelope' };
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
  if (status === 403) return { kind: 'refused', message: payload.error ?? 'You hold no active sprint grant on this initiative.' };
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
  | { kind: 'gate'; stop: GateStop };

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
}

export const READ_ONLY_REASON = 'An SME with a sprint grant on this initiative, or a release manager, authorizes jobs. You can see the setup it would run with.';

/** The deck's prompts for this item — only the question that needs a human now. */
export function prepareJobPrompts(view: PrepareJobView, actions: PrepareJobActions): ComposerPrompt[] {
  const { item, job, fields, step, rev, canDispatch, blocked, forecast } = view;
  const title = item.title;
  const eyebrow = canDispatch ? 'Prepare job' : 'Job setup';
  const id = (what: string) => `prepare-job:${item.id}:${what}:${rev}`;

  if (!canDispatch || step.kind === 'confirm') {
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
    return [{
      id: id('cap'), eyebrow, title: 'Run cap', fields: fields.filter((f) => f.label === 'Run cap' || f.label === 'Forecast'),
      question: 'Cap this run at how many dollars? Type an amount in the composer, or pick one. A cap below the forecast asks you to confirm at dispatch.',
      kind: 'number', min: 0, placeholder: 'A dollar amount, e.g. 2.50',
      options: [
        { id: 'none', label: 'No cap' },
        ...(high != null ? [{ id: 'forecast', label: `Forecast high (${usd(high)})` }] : []),
      ],
      defaultOptionId: job.capUsd == null ? 'none' : undefined,
      onAnswer: (answer) => {
        const cap = answer.kind === 'number' ? Math.round(answer.value * 100) / 100 : answer.optionId === 'forecast' && high != null ? high : null;
        actions.setCap(cap);
        return { receipt: `Run cap → ${cap == null ? 'no cap' : usd(cap)}` };
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
