// The model behind Milo's test cases (docs/interviews-tenant-plan.md, "Milo writes test cases"): the interviews text model
// (the coach's, Amazon Nova through Bedrock, `INTERVIEWS_COACH_MODEL_ID`), or a scripted stand-in chosen by the coach's one
// switch (`makeCoachModel().kind`, which `INTERVIEWS_COACH_MODEL=scripted` holds on the stand-in), so tests, walks and the
// film cost nothing.
//
// What the model is asked for, and what it may not do (the policy):
//   * data only: each case's arguments and the value the QUESTION says the call returns, as JSON (render.ts writes the code);
//   * no solution, hint, explanation or comment, and nothing about the candidate's code: it is not shown as reviewed, rated or
//     fixed, and the model is told not to judge it;
//   * nothing it writes is trusted: the question, the candidate's pad and the count are fenced as data, and parse.ts keeps
//     only well-formed cases of bounded size.
// The expected values are the model's reading of the question, never checked against a reference (the kit holds none) and
// never computed by running the candidate's code (that would only echo their code back, and would make Milo a judge of it).
// The block in the pad says so.
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { Fence, withDataRule } from '../../untrusted-text.js';
import { makeCoachModel } from '../coach/model.js';
import { BedrockMiloModel, type MiloModelResult } from '../milo-notes/model.js';
import type { PadLanguage } from '../types.js';
import { scriptedTestCases } from '../../../mock/interviews-testcases.js';
import { MAX_TEST_CASES } from './request.js';
import type { TestCase } from './render.js';

export const TEST_CASES_PROMPT_VERSION = 'tests-1';
export const SCRIPTED_TEST_CASES_MODEL_ID = 'scripted-tests';
/** The answer's cap: twenty small cases fit well inside it. */
export const TEST_CASES_MAX_TOKENS = 2000;
/** How much of the pad the model reads (its end, where the candidate's own tests usually are). */
export const MAX_PAD_CHARS = 6000;

export interface TestCaseInput {
  /** The question the cases are for (the round's question the pad is working on). */
  question: { id: string; prompt: string };
  language: PadLanguage;
  /** The function the cases call, when the pad defines one. */
  fn: string | null;
  /** The pad's text as it stands. */
  pad: string;
  count: number;
}

export const TEST_CASES_SYSTEM_PROMPT = [
  'You write test cases for a coding question in a live technical interview.',
  'You are given the question, the programming language, the function the candidate is writing (when known), the candidate\'s code pad, and how many cases to write.',
  'Each case is the arguments to the function, in order, and the value the question says the call returns.',
  'Rules:',
  '- Write data only. No code, no solution, no hints, no explanations, no comments.',
  '- Never comment on, review, rate or fix the candidate\'s code. You are not judging the candidate.',
  '- Work out each expected value from the question alone, not from the candidate\'s code.',
  '- Cover ordinary inputs and the edge cases the question allows. Do not repeat cases already in the pad.',
  '- Keep values small: lists of at most 12 elements, strings of at most 40 characters.',
  'Answer with one JSON object and nothing else:',
  '{"cases": [{"args": [<argument>, ...], "expected": <value>}]}',
].join('\n');

/** The user message: the question, the pad and the count fenced as data. */
export function testCaseUserText(input: TestCaseInput, fence: Fence = new Fence()): string {
  const pad = input.pad.length > MAX_PAD_CHARS ? input.pad.slice(-MAX_PAD_CHARS) : input.pad;
  return [
    `Language: ${input.language}`,
    `Function: ${input.fn ?? '(not found in the pad: use the question\'s inputs in order)'}`,
    `Cases to write: ${Math.max(1, Math.min(MAX_TEST_CASES, input.count))}`,
    '',
    `The question:\n${fence.wrap(input.question.prompt, { kind: 'question', maxChars: 2000 })}`,
    '',
    `The candidate's pad:\n${fence.wrap(pad, { kind: 'code', maxChars: MAX_PAD_CHARS })}`,
    '',
    'Answer with the JSON object only.',
  ].join('\n');
}

export function buildTestCaseRequest(modelId: string, input: TestCaseInput, fence: Fence = new Fence()) {
  return {
    modelId,
    system: [{ text: withDataRule(TEST_CASES_SYSTEM_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: testCaseUserText(input, fence) }] }],
    inferenceConfig: { maxTokens: TEST_CASES_MAX_TOKENS, temperature: 0 },
  };
}

/** About four characters a token, plus the answer's cap: what the hold is sized from. */
export function estimateTestCaseTokens(input: TestCaseInput): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Math.ceil((TEST_CASES_SYSTEM_PROMPT.length + 800 + testCaseUserText(input).length) / 4), outputTokens: TEST_CASES_MAX_TOKENS };
}

export interface TestCaseModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  write(input: TestCaseInput): Promise<MiloModelResult>;
}

export class BedrockTestCaseModel implements TestCaseModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  private readonly inner: BedrockMiloModel;
  constructor(inner: BedrockMiloModel = new BedrockMiloModel()) { this.inner = inner; this.modelId = inner.modelId; }
  write(input: TestCaseInput): Promise<MiloModelResult> {
    return this.inner.converse(buildTestCaseRequest(this.modelId, input) as ConverseCommandInput);
  }
}

/**
 * The stand-in: the mock world's prepared cases for the question (mock/interviews-testcases.ts), those not already in the pad,
 * as many as asked; nothing prepared for the question is `nothing` (no cases, no charge). Answers in the model's own JSON, so
 * parse.ts reads it the same way.
 */
export class ScriptedTestCaseModel implements TestCaseModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_TEST_CASES_MODEL_ID;
  async write(input: TestCaseInput): Promise<MiloModelResult> {
    const prepared: readonly TestCase[] = scriptedTestCases(input.question.id);
    if (!prepared.length) return { raw: null, code: 'error', sent: false, usage: null };
    return { raw: JSON.stringify({ cases: prepared }), code: 'ok', sent: true, usage: null };
  }
}

export type TestCaseModelFactory = () => TestCaseModel;
let factory: TestCaseModelFactory | null = null;
/** Tests: choose the model; `null` puts the coach's switch back. */
export function setTestCaseModelFactory(next: TestCaseModelFactory | null): void { factory = next; }
export function makeTestCaseModel(): TestCaseModel {
  if (factory) return factory();
  return makeCoachModel().kind === 'scripted' ? new ScriptedTestCaseModel() : new BedrockTestCaseModel();
}
