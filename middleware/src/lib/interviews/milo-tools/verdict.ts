// Is this helper the interview question's answer? (docs/interviews-tenant-plan.md, "Milo's interview tools", `pad_add_helper`).
//
// Asked only for a CANDIDATE's helper request (the lead's needs none: helper.ts). The interviews text model (the coach's, Amazon
// Nova through Bedrock) answers one word, HELPER or SOLUTION, given the question and the code, both fenced as data; anything
// else, a timeout, an error or a refused hold reads as SOLUTION: the check fails closed. The scripted stand-in
// (`INTERVIEWS_COACH_MODEL=scripted`, the coach's one switch) carries fixed verdicts: SOLUTION when the code names the
// question's function or reads like its approach (a target and a complement), else HELPER; it costs nothing.
//
// Money: a hold under the interview's `coach` part before the model is asked, settled with what it cost (zero for the
// stand-in), as Milo's private answers book theirs; booked to the lead, who turned the candidate's requests on.
import { randomBytes } from 'node:crypto';
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { estimateUsageCost } from '../../pricing.js';
import { Fence, withDataRule } from '../../untrusted-text.js';
import { DEFAULT_COACH_MODEL_ID, makeCoachModel } from '../coach/model.js';
import { BedrockMiloModel, type MiloModelResult } from '../milo-notes/model.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend } from '../spend.js';

export const SOLUTION_CHECK_PROMPT = [
  'You check code before it is added to a candidate\'s shared code pad in a technical interview.',
  'You are given the interview question and a piece of helper code someone asked for. Answer SOLUTION if the code solves the',
  'question, or most of it (its algorithm, its function, or the part the candidate is meant to work out); answer HELPER if it is',
  'a general tool (a data structure, a utility) that does not by itself answer the question.',
  'Answer with exactly one word: HELPER or SOLUTION.',
].join('\n');
export const SOLUTION_CHECK_MAX_TOKENS = 5;
export const SCRIPTED_VERDICT_MODEL_ID = 'scripted-verdict';

export interface VerdictInput { question: string; code: string; entry: string | null }
export type Verdict = 'helper' | 'solution';

export interface VerdictModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  judge(input: VerdictInput): Promise<MiloModelResult>;
}

export function buildVerdictRequest(modelId: string, input: VerdictInput, fence: Fence = new Fence()) {
  return {
    modelId,
    system: [{ text: withDataRule(SOLUTION_CHECK_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: [
      `The question:\n${fence.wrap(input.question, { kind: 'question', maxChars: 2000 })}`,
      '',
      `The helper code:\n${fence.wrap(input.code, { kind: 'code', maxChars: 6000 })}`,
      '',
      'HELPER or SOLUTION?',
    ].join('\n') }] }],
    inferenceConfig: { maxTokens: SOLUTION_CHECK_MAX_TOKENS, temperature: 0 },
  };
}

export class BedrockVerdictModel implements VerdictModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  private readonly inner: BedrockMiloModel;
  constructor(inner: BedrockMiloModel = new BedrockMiloModel()) { this.inner = inner; this.modelId = inner.modelId; }
  judge(input: VerdictInput): Promise<MiloModelResult> { return this.inner.converse(buildVerdictRequest(this.modelId, input) as ConverseCommandInput); }
}

/** The stand-in's fixed verdicts. */
export class ScriptedVerdictModel implements VerdictModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_VERDICT_MODEL_ID;
  async judge(input: VerdictInput): Promise<MiloModelResult> {
    const named = input.entry !== null && new RegExp(String.raw`\b${input.entry.replace(/[^\w]/g, '')}\b`).test(input.code);
    const approach = /\btarget\b[\s\S]*\b(?:complement|seen|diff)\b|\b(?:complement|seen|diff)\b[\s\S]*\btarget\b/i.test(input.code);
    return { raw: named || approach ? 'SOLUTION' : 'HELPER', code: 'ok', sent: true, usage: null };
  }
}

let factory: (() => VerdictModel) | null = null;
/** Tests: choose the model; `null` puts the coach's switch back. */
export function setVerdictModelFactory(next: (() => VerdictModel) | null): void { factory = next; }
export function makeVerdictModel(): VerdictModel {
  if (factory) return factory();
  return makeCoachModel().kind === 'scripted' ? new ScriptedVerdictModel() : new BedrockVerdictModel();
}

const estimate = (input: VerdictInput) => ({ inputTokens: Math.ceil((SOLUTION_CHECK_PROMPT.length + 400 + input.question.length + input.code.length) / 4), outputTokens: SOLUTION_CHECK_MAX_TOKENS });

/** The verdict, held and settled under the interview's cap; anything but a clear HELPER is `solution` (fail closed). */
export async function judgeHelper(interviewId: string, leadId: string, input: VerdictInput): Promise<Verdict> {
  const model = makeVerdictModel();
  const usage0 = estimate(input);
  const held = await reserveInterviewSpend({
    interviewId, part: 'coach', key: `helper-${randomBytes(6).toString('hex')}`,
    estimateUsd: estimateUsageCost(model.modelId, usage0) ?? estimateUsageCost(DEFAULT_COACH_MODEL_ID, usage0) ?? 0.01, expiresInMs: 60_000,
  }).catch(() => ({ ok: false as const }));
  if (!held.ok) return 'solution';
  const result = await model.judge(input).catch((): MiloModelResult => ({ raw: null, code: 'error', sent: false, usage: null }));
  try {
    if (!result.sent) await releaseInterviewSpend([held.holdId]);
    else if (model.kind === 'scripted') await settleInterviewSpend({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model: model.modelId, actorId: leadId, provider: 'local' });
    else {
      const usage = result.usage ?? usage0;
      const cost = estimateUsageCost(model.modelId, usage);
      await settleInterviewSpend({ sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model: model.modelId, actorId: leadId, provider: 'bedrock', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
  } catch (e) {
    console.warn('[interviews] helper check spend not booked', (e as Error)?.name ?? 'error');
  }
  return result.code === 'ok' && /^\s*HELPER\b/i.test(result.raw ?? '') ? 'helper' : 'solution';
}
