// What Milo's recap asks the model (docs/interviews-tenant-plan.md decisions 6, 7, 14; row I5.2; contract E0).
//
// Pure: no config, no client, no clock, so a test pins the whole request body as text for a fixed input, as the coach's
// prompt.ts does.
//
// What the recap reads, and nothing else (decision 6: text only):
//   * the transcript lines of the interview: which side spoke (the candidate or the panel), the line's number and the
//     words. No names, no times, no audio, nothing about video, voice or tone;
//   * the opening's kit: the competencies, what to look for in each, and their anchors (given so the model knows what
//     the competency is about; the system prompt forbids placing the candidate on them);
//   * the questions asked: the ones the lead chose for this round, and Milo's suggestions the lead answered "I'll ask
//     it" or "Have Milo ask", each with its competency.
// Left out, on purpose: the résumé (a PDF; the middleware holds no text extract of it), the code pad and runs, the
// scorecards (the recap must never see a rating: decision 14's order), and anything about the candidate's record
// (name, contact, notes, stage, consent answers).
//
// The transcript and the asked questions are fenced as data (lib/untrusted-text.ts); the system prompt carries the data
// rule. The answer is a schema read by parse.ts; anything else is dropped whole.
import { Fence, withDataRule } from '../../untrusted-text.js';
import type { CoachLine } from '../coach/prompt.js';
import type { KitCompetency } from '../types.js';

/** Bumped whenever the system prompt or the shape of the request changes; written on the recap's row. */
export const RECAP_PROMPT_VERSION = 'recap-2026-11-18.1';

/** One statement of what the candidate said or did. */
export const MAX_CLAIM_CHARS = 300;
/** The quote one statement rests on. */
export const MAX_QUOTE_CHARS = 300;
/** Statements kept per competency (the first ones, in the model's order). */
export const MAX_CLAIMS_PER_COMPETENCY = 4;
/** The answer is a few short statements per competency; this bounds what a runaway answer can cost. */
export const RECAP_MAX_TOKENS = 2000;
/** The lines the recap reads (the newest kept when there are more), and the characters per line. */
export const RECAP_MAX_LINES = 400;
export const RECAP_MAX_LINE_CHARS = 600;

/** How a question came to be asked: the lead chose it, or the lead took Milo's suggestion (asking it, or having Milo ask). */
export type AskedHow = 'chosen' | 'ask' | 'milo-ask';
export interface RecapQuestion { text: string; competencyId: string; how: AskedHow }

export interface RecapInput {
  competencies: readonly Pick<KitCompetency, 'id' | 'name' | 'lookFor' | 'anchors'>[];
  /** Chosen questions first (in the lead's order), then the taken suggestions oldest first. */
  questions: readonly RecapQuestion[];
  /** Oldest first, already cut to RECAP_MAX_LINES. */
  lines: readonly CoachLine[];
}

export const RECAP_SYSTEM_PROMPT = [
  'You write an evidence recap of a finished job interview for the interviewers, who have already rated the candidate themselves. You collect what was said; you never judge it.',
  'You read only the words said in the interview (the transcript, each line numbered and marked as the candidate\'s or the panel\'s), the interview kit (the competencies and what to look for in each), and the questions that were asked.',
  'For each competency, list short, plain statements of what the candidate said or did that bears on it. Each statement rests on exactly one transcript line spoken by the candidate: give that line\'s number as "seq" and quote, word for word, the piece of the line it rests on as "quote".',
  `At most ${MAX_CLAIMS_PER_COMPETENCY} statements per competency, each at most ${MAX_CLAIM_CHARS} characters; each quote at most ${MAX_QUOTE_CHARS} characters.`,
  'A panel line with a negative number is a question Milo said aloud in the interview; it is never evidence. A line in which the candidate speaks to Milo (asking it to repeat the question, or how much time is left) is a request to Milo, not an answer.',
  'List, by id, the competencies nothing in the transcript bears on, in "notCovered". Do not guess to fill a competency.',
  'Describe only what was said, in neutral words, for example: "The candidate described rolling back the release before paging the team." Refer to the person only as "the candidate".',
  'Never rate, score, rank, grade or compare the candidate, never place them on a level or an anchor, never say whether an answer was good, bad, strong, weak, clear or complete, never praise or doubt what they said, and never recommend hiring, advancing or rejecting anyone. The anchors are given only so you know what each competency covers.',
  'Never describe the person: not their appearance, face, voice, tone, manner, confidence, accent, age, gender, health, family, origin, beliefs or any other personal trait. Work only from the words.',
  'Answer with ONE JSON object and nothing else, with exactly these keys:',
  '{"competencies": [{"id": string, "evidence": [{"text": string, "seq": number, "quote": string}]}], "notCovered": [string]}',
].join('\n');

const howLabel = (h: AskedHow): string => (h === 'chosen' ? 'chosen for this round' : h === 'ask' ? 'Milo suggested it; the interviewer asked it' : 'Milo suggested it; Milo asked it');

/** The user message: the kit as plain text, the asked questions and the transcript fenced as data. */
export function recapUserText(input: RecapInput, fence: Fence = new Fence()): string {
  const competencies = input.competencies.map((c) => [
    `- ${c.id}: ${c.name}. Look for: ${c.lookFor}`,
    `  Anchors (what the competency covers; never place the candidate on them): 1 ${c.anchors[1]} 2 ${c.anchors[2]} 3 ${c.anchors[3]} 4 ${c.anchors[4]}`,
  ].join('\n')).join('\n');
  const questions = input.questions.map((q) =>
    fence.wrap(q.text, { kind: 'question', inline: true, maxChars: RECAP_MAX_LINE_CHARS, attrs: { competency: q.competencyId, how: howLabel(q.how) } })).join('\n');
  const lines = input.lines.map((l) =>
    fence.wrap(l.text, { kind: 'line', inline: true, maxChars: RECAP_MAX_LINE_CHARS, attrs: { n: String(l.seq), side: l.side } })).join('\n');
  return [
    `Competencies:\n${competencies || '(none)'}`,
    '',
    `Questions asked:\n${questions || '(none recorded)'}`,
    '',
    `Transcript, oldest first:\n${lines || '(nothing said)'}`,
    '',
    'Answer with the JSON object only.',
  ].join('\n');
}

/** The Converse request (the `@aws-sdk/client-bedrock-runtime` ConverseCommand input). Deterministic for a given fence token. */
export function buildRecapRequest(modelId: string, input: RecapInput, fence: Fence = new Fence()) {
  return {
    modelId,
    system: [{ text: withDataRule(RECAP_SYSTEM_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: recapUserText(input, fence) }] }],
    inferenceConfig: { maxTokens: RECAP_MAX_TOKENS, temperature: 0.1 },
  };
}
