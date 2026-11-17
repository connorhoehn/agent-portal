// What the coach asks the model (docs/interviews-tenant-plan.md decisions 6, 7, 8; row I3.3).
//
// Pure: no config, no client, no clock, so a test pins the whole request body as text for a fixed input, as
// lib/meeting-assistant/decision-prompt.ts does for the decision check.
//
// What the coach reads, and nothing else (decision 6: text only):
//   * the transcript lines of this interview's call: which side spoke (the candidate or the panel) and the words.
//     No names, no times, no audio, nothing about video, voice or tone; a line nobody's audio was attributed to is
//     left out (lib/interviews/coach/transcript.ts);
//   * the opening's kit: the competencies with what to look for and their anchors, and the question bank for this
//     round's type with each question's follow-ups;
//   * the questions the lead chose for this round;
//   * the suggestions already made in this interview, each with what the lead did with it.
// Left out, on purpose: the résumé (a PDF; the middleware holds no text extract of it, so there is nothing to read),
// the code pad and runs (row I4.5), and anything about the candidate's record (name, contact, notes, stage).
//
// The transcript and the coach's own earlier words are fenced as data (lib/untrusted-text.ts); the system prompt
// carries the data rule. The answer is a schema read by parse.ts; anything else is dropped whole.
import { Fence, withDataRule } from '../../untrusted-text.js';
import type { KitCompetency, KitQuestion, RoundType } from '../types.js';

/** Bumped whenever the system prompt or the shape of the request changes; written on every log row. */
export const COACH_PROMPT_VERSION = 'coach-2026-11-16.1';

/** A spoken question: one breath. Longer answers are dropped (parse.ts). */
export const MAX_SUGGESTION_CHARS = 280;
/** The quote a suggestion builds on. */
export const MAX_BASED_ON_CHARS = 300;
/** The answer is short; this bounds what a runaway answer can cost. */
export const COACH_MAX_TOKENS = 300;
/** The most recent lines the coach reads (oldest dropped first), and the characters per line. */
export const MAX_TRANSCRIPT_LINES = 120;
export const MAX_LINE_CHARS = 600;
/** The earlier suggestions the coach is reminded of (the most recent). */
export const MAX_PREVIOUS = 20;

export type CoachSide = 'candidate' | 'panel';
export interface CoachLine { seq: number; side: CoachSide; text: string }
export type CoachPreviousAnswer = 'ask' | 'milo-ask' | 'skip' | null;
export interface CoachPrevious { text: string; competencyId: string; answer: CoachPreviousAnswer }

export interface CoachInput {
  roundType: RoundType;
  competencies: readonly Pick<KitCompetency, 'id' | 'name' | 'lookFor' | 'anchors'>[];
  /** The bank for this round's type, in the kit's order. */
  questions: readonly Pick<KitQuestion, 'id' | 'prompt' | 'followUps' | 'competencyId'>[];
  /** The ids the lead chose for this round, in their order. */
  chosenQuestionIds: readonly string[];
  /** Oldest first, already cut to MAX_TRANSCRIPT_LINES. */
  lines: readonly CoachLine[];
  /** Oldest first, already cut to MAX_PREVIOUS; dropped attempts are not here. */
  previous: readonly CoachPrevious[];
}

export const COACH_SYSTEM_PROMPT = [
  'You help the lead interviewer in a live job interview by suggesting what to ask next. You are an adviser to the interviewer, never a judge of the candidate.',
  'You read only the words said in the interview (the transcript), the interview kit (the competencies, what to look for in each, and the question bank), the questions chosen for this round, and the suggestions you already made with what the interviewer did with them.',
  'Suggest exactly ONE thing: either a follow-up on something the candidate just said, or the next question for a competency with little or no evidence so far. Prefer a question from the bank or one of its follow-ups.',
  'Tie it to exactly one competency, by its id from the kit.',
  'Quote, word for word, the short piece of the transcript the suggestion builds on. Use null only for a new question that builds on nothing said yet.',
  'Never rate, score, rank or compare the candidate, never say whether an answer was good or bad, and never recommend hiring, advancing or rejecting anyone. The anchors describe levels so you can see what is still unexplored; never use them to place the candidate on a level.',
  'Never mention or ask about the candidate\'s appearance, face, voice, tone, accent, age, health, family, origin, beliefs or any other personal trait. Work only from what was said.',
  'Do not repeat a question already asked in the transcript or a suggestion already made.',
  `The suggestion is said aloud: one short question, at most ${MAX_SUGGESTION_CHARS} characters.`,
  'Answer with ONE JSON object and nothing else, with exactly these keys:',
  '{"text": string, "competencyId": string, "basedOn": string | null}',
].join('\n');

const answerLabel = (a: CoachPreviousAnswer): string =>
  (a === 'ask' ? 'the interviewer asked it' : a === 'milo-ask' ? 'Milo asked it' : a === 'skip' ? 'skipped' : 'not answered');

/** The user message: the kit as plain text, the earlier suggestions and the transcript fenced as data. */
export function coachUserText(input: CoachInput, fence: Fence = new Fence()): string {
  const competencies = input.competencies.map((c) => [
    `- ${c.id}: ${c.name}. Look for: ${c.lookFor}`,
    `  Levels: 1 ${c.anchors[1]} 2 ${c.anchors[2]} 3 ${c.anchors[3]} 4 ${c.anchors[4]}`,
  ].join('\n')).join('\n');
  const chosen = new Set(input.chosenQuestionIds);
  const questions = input.questions.map((q) => [
    `- ${q.id} (${q.competencyId})${chosen.has(q.id) ? ' [chosen for this round]' : ''}: ${q.prompt}`,
    ...q.followUps.map((f) => `  Follow-up: ${f}`),
  ].join('\n')).join('\n');
  const previous = input.previous.map((p) =>
    fence.wrap(p.text, { kind: 'suggestion', inline: true, maxChars: MAX_SUGGESTION_CHARS, attrs: { competency: p.competencyId, outcome: answerLabel(p.answer) } })).join('\n');
  const lines = input.lines.map((l) =>
    fence.wrap(l.text, { kind: 'line', inline: true, maxChars: MAX_LINE_CHARS, attrs: { n: String(l.seq), side: l.side } })).join('\n');
  return [
    `Round type: ${input.roundType}`,
    '',
    `Competencies:\n${competencies || '(none)'}`,
    '',
    `Question bank:\n${questions || '(none)'}`,
    '',
    `Suggestions already made, oldest first:\n${previous || '(none)'}`,
    '',
    `Transcript, oldest first:\n${lines || '(nothing said yet)'}`,
    '',
    'Answer with the JSON object only.',
  ].join('\n');
}

/** The Converse request (the `@aws-sdk/client-bedrock-runtime` ConverseCommand input). Deterministic for a given fence token. */
export function buildCoachRequest(modelId: string, input: CoachInput, fence: Fence = new Fence()) {
  return {
    modelId,
    system: [{ text: withDataRule(COACH_SYSTEM_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: coachUserText(input, fence) }] }],
    inferenceConfig: { maxTokens: COACH_MAX_TOKENS, temperature: 0.2 },
  };
}
