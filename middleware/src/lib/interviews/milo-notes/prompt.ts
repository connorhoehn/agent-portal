// What Milo is asked when the lead types a private question mid-interview (docs/interviews-tenant-plan.md decisions 6,
// 7, 20; row I3.6; contract E0).
//
// Pure: no config, no client, no clock, so a test pins the whole request body as text for a fixed input.
//
// What the model reads, and nothing else (decision 6: text only):
//   * the transcript lines of this interview's call, each with its number and its side (the candidate or the panel).
//     No names, no times, no audio, nothing about video, voice or tone;
//   * the kit's competencies (id, name, what to look for) and the questions the lead chose for this round;
//   * the lead's question.
// Left out on purpose: the anchors (levels invite placing the candidate on one), the résumé (the middleware holds no
// text of it), the pad and runs, and anything of the candidate's record.
//
// The model answers only from the transcript: at most three sentences, each resting on a quoted line given by its
// number; when the transcript does not hold the answer it says exactly NOT_SAID. It never rates, ranks, compares,
// recommends or describes the person. The transcript and the question are fenced as data; parse.ts reads the answer.
import { Fence, withDataRule } from '../../untrusted-text.js';
import type { CoachLine } from '../coach/prompt.js';
import type { KitCompetency, KitQuestion, RoundType } from '../types.js';

/** Bumped whenever the system prompt or the shape of the request changes; written on every log row. */
export const ASK_PROMPT_VERSION = 'milo-ask-2026-11-17.1';

/** The lead's question: one line typed mid-call. */
export const MAX_QUESTION_CHARS = 300;
/** The answer: three short sentences. */
export const MAX_ANSWER_CHARS = 600;
export const MAX_ANSWER_SENTENCES = 3;
/** At most one quote per sentence. */
export const MAX_SOURCES = 3;
export const MAX_QUOTE_CHARS = 300;
/** Bounds what a runaway answer can cost. */
export const ASK_MAX_TOKENS = 400;
/** The characters of one line the model reads. */
export const MAX_ASK_LINE_CHARS = 600;

/** The one answer for a transcript that does not hold what was asked. */
export const NOT_SAID = 'The transcript does not say.';

export interface AskInput {
  roundType: RoundType;
  competencies: readonly Pick<KitCompetency, 'id' | 'name' | 'lookFor'>[];
  /** The chosen questions of this round, in their order. */
  questions: readonly Pick<KitQuestion, 'id' | 'prompt' | 'competencyId'>[];
  /** Oldest first, already cut to the coach's MAX_TRANSCRIPT_LINES. */
  lines: readonly CoachLine[];
  question: string;
}

export const ASK_SYSTEM_PROMPT = [
  'You help the lead interviewer in a live job interview find what was said. You are a search aid for the interviewer, never a judge of the candidate.',
  'You read only the numbered transcript lines of this interview (each marked as said by the candidate or by the panel), the interview kit\'s competencies, the questions chosen for this round, and the interviewer\'s question.',
  'Answer the interviewer\'s question only from the transcript lines. Say what was said and where; do not add anything that is not in a line.',
  `Answer in at most ${MAX_ANSWER_SENTENCES} short sentences. Every sentence must rest on one transcript line: give that line's number and a word-for-word quote from it in "sources".`,
  `When the transcript does not hold the answer, answer exactly "${NOT_SAID}" with an empty "sources" list.`,
  'Never rate, score, rank or compare the candidate, never say whether an answer was good, bad, strong or weak, never say how the candidate did, and never recommend hiring, advancing or rejecting anyone.',
  'Never describe the candidate as a person: not their appearance, face, voice, tone, accent, manner, confidence, age, health, family, origin, beliefs or any other personal trait. Work only from the words said.',
  'If the question asks for a judgement or about a personal trait, answer exactly the sentence for an answer the transcript does not hold.',
  'Answer with ONE JSON object and nothing else, with exactly these keys:',
  '{"answer": string, "sources": [{"seq": number, "quote": string}]}',
].join('\n');

/** The user message: the kit as plain text, the transcript and the question fenced as data. */
export function askUserText(input: AskInput, fence: Fence = new Fence()): string {
  const competencies = input.competencies.map((c) => `- ${c.id}: ${c.name}. Look for: ${c.lookFor}`).join('\n');
  const questions = input.questions.map((q) => `- ${q.id} (${q.competencyId}): ${q.prompt}`).join('\n');
  const lines = input.lines.map((l) =>
    fence.wrap(l.text, { kind: 'line', inline: true, maxChars: MAX_ASK_LINE_CHARS, attrs: { n: String(l.seq), side: l.side } })).join('\n');
  return [
    `Round type: ${input.roundType}`,
    '',
    `Competencies:\n${competencies || '(none)'}`,
    '',
    `Questions chosen for this round:\n${questions || '(none)'}`,
    '',
    `Transcript, oldest first:\n${lines || '(nothing said yet)'}`,
    '',
    `The interviewer asks:\n${fence.wrap(input.question, { kind: 'question', inline: true, maxChars: MAX_QUESTION_CHARS })}`,
    '',
    'Answer with the JSON object only.',
  ].join('\n');
}

/** The Converse request (the `@aws-sdk/client-bedrock-runtime` ConverseCommand input). Deterministic for a given fence token. */
export function buildAskRequest(modelId: string, input: AskInput, fence: Fence = new Fence()) {
  return {
    modelId,
    system: [{ text: withDataRule(ASK_SYSTEM_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: askUserText(input, fence) }] }],
    inferenceConfig: { maxTokens: ASK_MAX_TOKENS, temperature: 0 },
  };
}
