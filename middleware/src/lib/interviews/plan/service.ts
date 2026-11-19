// The question plan (docs/interviews-tenant-plan.md row I3.10; decisions 6, 7, 8; contract E6): Milo proposes which of the
// kit's questions to ask in this round. Advisory: the lead's own save (PUT /interviews/:id/questions) is unchanged.
//
// From the kit only: the résumé has no text extract in the middleware, so nothing of it is read.
//
//   who     the lead of the interview, while it is `accepted` or `ready`; anyone else is the route's not-found.
//   limits  at most MAX_PLAN_DRAFTS drafts per interview; one in flight at a time.
//   money   a hold on the opening for the part `coach`, key `plan-<n>`; a refused hold makes no call and answers
//           `paused: 'budget'`; the money is settled (the stand-in settles zero) or released, as askMilo does.
//   log     every draft is a row of Milo's log (`kind: 'plan'`), "logged like a suggestion": the proposed ids and reasons
//           as `sources`, or the code that dropped it. Nothing of the kit's words is logged anywhere else.
import { randomBytes } from 'node:crypto';
import { estimateUsageCost } from '../../pricing.js';
import { COACH_TIMEOUT_MS, DEFAULT_COACH_MODEL_ID } from '../coach/model.js';
import type { MiloModelResult } from '../milo-notes/model.js';
import { coachLogStore, type CoachLogCode, type CoachLogRecord, type CoachLogStore } from '../milo-notes/store.js';
import { isPreparable } from '../prepare.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend, type InterviewReserveInput, type InterviewReserveOutcome, type InterviewSettleInput } from '../spend.js';
import type { Interview, Opening } from '../types.js';
import { competenciesOfRound, questionsOfRound } from '../kit.js';
import { makePlanModel, type PlanModel } from './model.js';
import { parsePlan, type PlanQuestion } from './parse.js';
import { estimatePlanTokens, PLAN_PROMPT_VERSION, planCap, type PlanInput } from './prompt.js';
import { interviewsNowMs } from '../clock.js';

export const MAX_PLAN_DRAFTS = 3;

export const PLAN_LINES = {
  atMax: 'Milo has drafted three plans for this round. Choose from those, or build the plan yourself below.',
  nothing: 'Milo could not draft a plan this time. Choose the questions yourself below.',
  notPreparable: 'You can ask Milo for a plan only before the round starts.',
  inFlight: 'Milo is already drafting a plan for this round.',
} as const;

export interface PlanDeps {
  log: () => CoachLogStore;
  model: () => PlanModel;
  reserve: (i: InterviewReserveInput) => Promise<InterviewReserveOutcome>;
  settle: (i: InterviewSettleInput) => Promise<void>;
  release: (holdIds: readonly (string | null)[]) => Promise<void>;
  now: () => number;
  newId: () => string;
}

const DEFAULTS: PlanDeps = {
  log: coachLogStore,
  model: makePlanModel,
  reserve: reserveInterviewSpend,
  settle: settleInterviewSpend,
  release: releaseInterviewSpend,
  now: interviewsNowMs,
  newId: () => `pl-${Date.now().toString(36)}${randomBytes(5).toString('hex')}`,
};

let overrides: Partial<PlanDeps> = {};
/** Tests: replace some dependencies; `null` puts every default back. */
export function setPlanDeps(next: Partial<PlanDeps> | null): void { overrides = next ?? {}; }
const deps = (): PlanDeps => ({ ...DEFAULTS, ...overrides });

export interface PlanRef { interview: Interview; opening: Opening }

/** E6's answer, with one plain line for the page when there is no plan. */
export interface PlanBody { plan: { questions: PlanQuestion[] } | null; paused: null | 'budget'; line: string | null }
export type PlanOutcome = { kind: 'not-found' } | { kind: 'not-preparable'; body: PlanBody } | { kind: 'ok'; body: PlanBody };

const inFlight = new Set<string>();
const body = (plan: PlanQuestion[] | null, paused: null | 'budget' = null, line: string | null = null): PlanBody => ({ plan: plan ? { questions: plan } : null, paused, line });

/** The model's input: the competencies the round assesses and the bank's questions for them (kit.ts competenciesOfRound, questionsOfRound). */
export function planInputOf(ref: PlanRef): PlanInput {
  const { interview, opening } = ref;
  return {
    roundType: interview.type,
    minutes: interview.minutes,
    competencies: competenciesOfRound(opening.kit, interview.roundId).map((c) => ({ id: c.id, name: c.name, lookFor: c.lookFor })),
    questions: questionsOfRound(opening.kit, interview.roundId, interview.type).map((q) => ({ id: q.id, prompt: q.prompt, competencyId: q.competencyId, followUps: q.followUps })),
  };
}

export function planEstimateUsd(model: Pick<PlanModel, 'modelId'>, input: PlanInput): number {
  const tokens = estimatePlanTokens(input);
  return estimateUsageCost(model.modelId, tokens) ?? estimateUsageCost(DEFAULT_COACH_MODEL_ID, tokens) ?? 0.02;
}

async function book(d: PlanDeps, model: PlanModel, input: PlanInput, held: { holdId: string | null; sourceId: string }, result: MiloModelResult, lead: string): Promise<void> {
  try {
    if (!result.sent) { await d.release([held.holdId]); return; }
    if (model.kind === 'scripted') {
      await d.settle({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model: model.modelId, actorId: lead, provider: 'local' });
      return;
    }
    const usage = result.usage ?? estimatePlanTokens(input);
    const cost = estimateUsageCost(model.modelId, usage);
    await d.settle({
      sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model: model.modelId, actorId: lead, provider: 'bedrock',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    });
  } catch (e) {
    console.warn('[interviews] plan spend not booked', (e as Error)?.name ?? 'error');
  }
}

/** A draft that failed outright (the provider, not the answer) does not use up one of the three. */
const counts = (r: CoachLogRecord): boolean => r.code !== 'timeout' && r.code !== 'error';

export async function draftPlan(ref: PlanRef, viewer: { userId: string }): Promise<PlanOutcome> {
  const d = deps();
  const { interview } = ref;
  if (viewer.userId !== interview.leadId) return { kind: 'not-found' };
  if (!isPreparable(interview.state)) return { kind: 'not-preparable', body: body(null, null, PLAN_LINES.notPreparable) };
  if (inFlight.has(interview.id)) return { kind: 'ok', body: body(null, null, PLAN_LINES.inFlight) };
  // Taken in the same tick as the check, before any await (O-128): a second ask that arrives while the earlier drafts are read
  // is told a draft is on its way, so two asks never make two model calls or pass the three-draft cap in this process.
  inFlight.add(interview.id);
  try {
    const store = d.log();
    const earlier = await store.list(interview.id, 'plan');
    if (earlier.filter(counts).length >= MAX_PLAN_DRAFTS) return { kind: 'ok', body: body(null, null, PLAN_LINES.atMax) };
    const model = d.model();
    const input = planInputOf(ref);
    const row = (over: Partial<CoachLogRecord>): CoachLogRecord => ({
      id: d.newId(), interviewId: interview.id, kind: 'plan', askedBy: viewer.userId, question: `Draft ${earlier.length + 1} for a ${interview.type} round of ${interview.minutes} minutes`,
      answer: '', sources: [], code: null, askedAt: new Date(d.now()).toISOString(), modelId: model.modelId, promptVersion: PLAN_PROMPT_VERSION, ...over,
    });
    if (!input.questions.length) {
      await store.append(row({ modelId: 'none', code: 'nothing' }));
      return { kind: 'ok', body: body(null, null, PLAN_LINES.nothing) };
    }
    const held = await d.reserve({
      interviewId: interview.id, part: 'coach', key: `plan-${earlier.length + 1}`, estimateUsd: planEstimateUsd(model, input), expiresInMs: COACH_TIMEOUT_MS * 2 + 30_000,
    });
    if (!held.ok) return { kind: 'ok', body: body(null, 'budget') };
    let result: MiloModelResult;
    try { result = await model.draft(input); } catch { result = { raw: null, code: 'error', sent: false, usage: null }; }
    await book(d, model, input, held, result, viewer.userId);
    const parsed = result.code === 'ok' ? parsePlan(result.raw, new Set(input.questions.map((q) => q.id)), planCap(interview.minutes)) : null;
    if (parsed?.ok && parsed.plan) {
      await store.append(row({ answer: parsed.plan.map((q) => q.why).join(' '), sources: parsed.plan.map((q) => ({ questionId: q.questionId, why: q.why })) }));
      return { kind: 'ok', body: body(parsed.plan) };
    }
    const code: CoachLogCode = result.code !== 'ok' ? result.code : !parsed || !parsed.ok ? 'malformed' : parsed.drops.offBank ? 'off-kit' : 'nothing';
    console.warn('[interviews] milo plan dropped', code);
    await store.append(row({ code }));
    return { kind: 'ok', body: body(null, null, PLAN_LINES.nothing) };
  } finally {
    inFlight.delete(interview.id);
  }
}
