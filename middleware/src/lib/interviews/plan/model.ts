// The model for the question plan (row I3.10; contract E0): Amazon Nova through Bedrock, sent through MILO-FOR-YOU's
// `BedrockMiloModel.converse`, or a scripted stand-in. The one switch is the coach's (`makeCoachModel().kind`), as
// `makeMiloModel` reads it, so a test's `setCoachModelFactory` and the mock world flip this model with the others.
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { BedrockMiloModel, makeMiloModel, type MiloModelResult } from '../milo-notes/model.js';
import { buildPlanRequest, MINUTES_PER_QUESTION, planCap, type PlanInput } from './prompt.js';

export const SCRIPTED_PLAN_MODEL_ID = 'scripted-plan';

export interface PlanModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  draft(input: PlanInput): Promise<MiloModelResult>;
}

/**
 * Deterministic, from the kit alone: the first bank question of each competency, in the kit's order, until the minutes
 * are filled (one question per MINUTES_PER_QUESTION, the same cap the parse holds); when every competency has had one and
 * minutes remain, a second pass takes each competency's next question. A competency with no question is skipped.
 */
export function scriptedPlan(input: PlanInput): { questions: Array<{ questionId: string; why: string }> } {
  const cap = planCap(input.minutes);
  const byComp = input.competencies.map((c) => ({ c, qs: input.questions.filter((q) => q.competencyId === c.id) }));
  const out: Array<{ questionId: string; why: string }> = [];
  for (let pass = 0; out.length < cap; pass++) {
    let any = false;
    for (const { c, qs } of byComp) {
      const q = qs[pass];
      if (!q) continue;
      any = true;
      if (out.length >= cap) break;
      out.push({ questionId: q.id, why: `It gathers evidence for ${c.name}.` });
    }
    if (!any) break;
  }
  return { questions: out };
}

export class ScriptedPlanModel implements PlanModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_PLAN_MODEL_ID;
  async draft(input: PlanInput): Promise<MiloModelResult> {
    return { raw: JSON.stringify(scriptedPlan(input)), code: 'ok', sent: true, usage: null };
  }
}

export class BedrockPlanModel implements PlanModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  constructor(private readonly inner: BedrockMiloModel) { this.modelId = inner.modelId; }
  draft(input: PlanInput): Promise<MiloModelResult> {
    return this.inner.converse(buildPlanRequest(this.modelId, input) as ConverseCommandInput);
  }
}

export function makePlanModel(): PlanModel {
  const m = makeMiloModel();
  return m instanceof BedrockMiloModel ? new BedrockPlanModel(m) : new ScriptedPlanModel();
}

export { MINUTES_PER_QUESTION };
