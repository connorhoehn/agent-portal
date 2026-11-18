// What Milo is asked when the lead wants a draft question plan for a round (docs/interviews-tenant-plan.md decisions 6, 7;
// row I3.10; contract E6).
//
// Pure: no config, no client, no clock, so a test pins the whole request body as text for a fixed input.
//
// What the model reads, and nothing else (decision 6: text only): the round's type and length, the kit's competencies
// (id, name, what to look for) and the bank's questions for that round type, each with its id. NOT read, on purpose: the
// candidate's name or record, and the résumé (the middleware holds no text of it), the anchors, any transcript.
//
// The model picks question ids only, in the order to ask them, with one short reason each that names the competency it
// serves. It never mentions the candidate and never rates anyone. parse.ts reads the answer.
import { Fence, withDataRule } from '../../untrusted-text.js';
import type { KitCompetency, KitQuestion, RoundType } from '../types.js';

/** Bumped whenever the system prompt or the shape of the request changes; written on every log row. */
export const PLAN_PROMPT_VERSION = 'milo-plan-2026-11-17.1';

/** Minutes of a round one planned question is allowed to take, on average: the cap and the stand-in's fill both use it. */
export const MINUTES_PER_QUESTION = 10;
/** The most questions one plan holds (the same bound as the lead's own plan, lib/interviews/prepare.ts). */
export const PLAN_MAX_QUESTIONS = 8;
export const MAX_WHY_CHARS = 200;
export const PLAN_MAX_TOKENS = 700;
/** The characters of one bank question the model reads. */
export const MAX_PLAN_PROMPT_CHARS = 400;

/** How many questions a round of `minutes` takes: one per ten minutes, at least one, at most eight. */
export function planCap(minutes: number): number {
  const n = Number.isFinite(minutes) ? Math.floor(minutes / MINUTES_PER_QUESTION) : 1;
  return Math.max(1, Math.min(PLAN_MAX_QUESTIONS, n));
}

export interface PlanInput {
  roundType: RoundType;
  minutes: number;
  competencies: readonly Pick<KitCompetency, 'id' | 'name' | 'lookFor'>[];
  /** The bank's questions for this round type, in the kit's order. */
  questions: readonly (Pick<KitQuestion, 'id' | 'prompt' | 'competencyId'> & { followUps?: readonly string[] })[];
}

export const PLAN_SYSTEM_PROMPT = [
  'You help the lead interviewer prepare a round of a job interview. You propose which questions from the interview kit\'s question bank to ask in this round. You are a planning aid for the interviewer, never a judge of anyone.',
  'You read only the round\'s type and length, the kit\'s competencies and the bank\'s questions for this round type. You know nothing about any candidate and you never mention one.',
  'Choose questions by their ids, only from the bank given. Never invent a question, never reword one, and never use an id twice.',
  'Cover the competencies in the kit\'s order, favour breadth over several questions on one competency, and choose no more questions than the stated maximum.',
  `For each question give one short reason (at most ${MAX_WHY_CHARS} characters) that names the competency it serves.`,
  'Never rate, score, rank or compare people, never say whether anyone is strong or weak, and never recommend hiring, advancing or rejecting anyone. The reasons are about what the question helps the interviewer learn, nothing else.',
  'Answer with ONE JSON object and nothing else, with exactly this shape:',
  '{"questions": [{"questionId": string, "why": string}]}',
].join('\n');

/** The user message: the kit as plain text, each of the lead's own words fenced as data. */
export function planUserText(input: PlanInput, fence: Fence = new Fence()): string {
  const competencies = input.competencies
    .map((c) => `- ${c.id}: ${fence.wrap(c.name, { kind: 'competency', inline: true, maxChars: 120 })}. Look for: ${fence.wrap(c.lookFor, { kind: 'look-for', inline: true, maxChars: 400 })}`).join('\n');
  const questions = input.questions
    .map((q) => `- ${q.id} (${q.competencyId}): ${fence.wrap(q.prompt, { kind: 'question', inline: true, maxChars: MAX_PLAN_PROMPT_CHARS })}`).join('\n');
  return [
    `Round type: ${input.roundType}`,
    `Round length: ${input.minutes} minutes`,
    `Choose at most ${planCap(input.minutes)} questions.`,
    '',
    `Competencies, in the kit's order:\n${competencies || '(none)'}`,
    '',
    `The question bank for this round type:\n${questions || '(none)'}`,
    '',
    'Answer with the JSON object only.',
  ].join('\n');
}

/** The Converse request (the `@aws-sdk/client-bedrock-runtime` ConverseCommand input). Deterministic for a given fence token. */
export function buildPlanRequest(modelId: string, input: PlanInput, fence: Fence = new Fence()) {
  return {
    modelId,
    system: [{ text: withDataRule(PLAN_SYSTEM_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: planUserText(input, fence) }] }],
    inferenceConfig: { maxTokens: PLAN_MAX_TOKENS, temperature: 0 },
  };
}

/** About four characters a token, plus the answer's cap: what a hold is sized from. */
export function estimatePlanTokens(input: PlanInput): { inputTokens: number; outputTokens: number } {
  const chars = PLAN_SYSTEM_PROMPT.length + 800 + planUserText(input).length;
  return { inputTokens: Math.ceil(chars / 4), outputTokens: PLAN_MAX_TOKENS };
}
