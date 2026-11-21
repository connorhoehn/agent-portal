// Milo's recap model (docs/interviews-tenant-plan.md decisions 6, 7; row I5.2; contract E0): Amazon Nova through Bedrock's
// Converse API, or a scripted stand-in. Defaults follow the coach (`makeCoachModel().kind === 'scripted'`).
// INTERVIEWS_RECAP_MODEL=openai explicitly selects the independent live backend in openai-model.ts.
//
// Rules kept here, as the coach's model.ts keeps them:
//   * a timeout and at most one retry (the SDK's attempts count the first try); a failure is a code, never an exception;
//   * nothing of the transcript, the prompt or the answer is logged: only the error's name;
//   * the model returns raw text; parse.ts reads it the same way for both models, so the stand-in walks the real path;
//   * the call itself goes through the tenant's one Bedrock seam (../bedrock.ts).
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { converseOnce, type ConverseSend } from '../bedrock.js';
import { COACH_TIMEOUT_MS, coachModelId, makeCoachModel, type CoachModelResult, type TokenCounts } from '../coach/model.js';
import { buildRecapRequest, MAX_CLAIMS_PER_COMPETENCY, MAX_QUOTE_CHARS, RECAP_SYSTEM_PROMPT, recapUserText, type RecapInput } from './prompt.js';
import { addressesMilo, courtesyOnly } from './parse.js';
import { OpenAIRecapModel } from './openai-model.js';

export const SCRIPTED_RECAP_MODEL_ID = 'scripted-recap';
/**
 * Nobody is mid-conversation when the recap is written, and the answer is a few hundred tokens rather than one question:
 * three times the coach's timeout.
 */
export const RECAP_TIMEOUT_MS = COACH_TIMEOUT_MS * 3;

export interface RecapModel {
  readonly kind: 'bedrock' | 'scripted' | 'openai';
  readonly modelId: string;
  readonly promptVersion?: string;
  write(input: RecapInput): Promise<CoachModelResult>;
}

/** About four characters a token, plus the answer's usual size: what a hold is sized from. */
export function estimateRecapTokens(input: RecapInput): TokenCounts {
  const chars = RECAP_SYSTEM_PROMPT.length + 800 + recapUserText(input).length;
  return { inputTokens: Math.ceil(chars / 4), outputTokens: 1000 };
}

export class BedrockRecapModel implements RecapModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  constructor(private readonly opts: { send?: ConverseSend; timeoutMs?: number; modelId?: string } = {}) {
    this.modelId = opts.modelId ?? coachModelId();
  }

  write(input: RecapInput): Promise<CoachModelResult> {
    return converseOnce(buildRecapRequest(this.modelId, input) as ConverseCommandInput,
      { send: this.opts.send, timeoutMs: this.opts.timeoutMs ?? RECAP_TIMEOUT_MS, label: 'recap' });
  }
}

// ---- the scripted stand-in --------------------------------------------------------------------------------------------------------
//
// Deterministic from its input, never from meaning, and honest: it invents nothing.
//   A QUESTION LINE is a panel line that contains the opening words (the first six) of any asked question (a question Milo said
//   aloud is a panel line of the timeline, service.ts `withMiloQuestions`). Each question line opens a window that runs to the
//   next question line; the panel's other lines inside it are conversation (the language, a clarification) and do not end it,
//   so an answer given after them still counts. For each competency in the kit's order, its windows are those opened by its own
//   questions; their candidate lines are the answers, except a line that speaks to Milo (a repeat or time request), which is a
//   request. The competency's MAX_CLAIMS_PER_COMPETENCY is shared across its windows in turn, each giving its longest line not
//   yet taken (a long line is the likeliest answer; a short one is "Python, please"), so every question asked gets its share;
//   the statements are listed in timeline order. Each becomes one statement, ANSWER_TEXT, beside the line's own words as its quote (its first
//   MAX_QUOTE_CHARS characters, cut at a word) and the line's number: a stand-in cannot restate a line in fewer words
//   without inventing, so it says only that the line answered the question and lets the quote speak (the screen shows
//   the statement and the quote once each). At most MAX_CLAIMS_PER_COMPETENCY.
//   A competency with none is not covered.

const words = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const opening = (s: string): string => words(s).split(' ').slice(0, 6).join(' ');
/** Match a bounded question opening with at most one ASR word substitution/insertion/deletion.
 * Short titles still require an exact match; a similar topic alone never opens a window. */
export function hearsQuestion(text: string, phrase: string): boolean {
  const heard = words(text).split(' ');
  const expected = phrase.split(' ');
  if (` ${words(text)} `.includes(` ${phrase} `)) return true;
  if (expected.length < 6) return false;
  for (let from = 0; from < heard.length; from += 1) {
    for (const length of [expected.length - 1, expected.length, expected.length + 1]) {
      const span = heard.slice(from, from + length);
      if (span.length !== length) continue;
      let previous = Array.from({ length: span.length + 1 }, (_, j) => j);
      for (let i = 1; i <= expected.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= span.length; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (expected[i - 1] === span[j - 1] ? 0 : 1));
        previous = current;
      }
      if (previous[span.length]! <= 1) return true;
    }
  }
  return false;
}

/** The deterministic stand-in can quote substantive answers, never social acknowledgments or a tool request. */
const isAnswer = (text: string): boolean => {
  const normalized = words(text);
  return !addressesMilo(text) && !courtesyOnly(text) && normalized.split(' ').length >= 4;
};
const codeQualityAnswer = (text: string): boolean => isAnswer(text)
  && /\b(?:tests?|assertions?|duplicates?|empty|indices|index|readab\w*|naming|exception|validation)\b/i.test(text)
  && /\b(?:because|so|before|after|expect\w*|return\w*|check\w*|avoid\w*|prevent\w*|ensure\w*)\b/i.test(text);
/**
 * How a question is named aloud: its first six words, and, for a prompt with a title before a colon ("Design Twitter: people
 * post…", a board round's question, which is on the board and named rather than read), the title of two to six words.
 */
const openingsOfText = (s: string): string[] => {
  const title = s.includes(':') ? words(s.slice(0, s.indexOf(':'))) : '';
  const n = title ? title.split(' ').length : 0;
  return [opening(s), ...(n >= 2 && n <= 6 ? [title] : [])].filter((o) => o.length > 0);
};

function quoteOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_QUOTE_CHARS) return t;
  const cut = t.slice(0, MAX_QUOTE_CHARS);
  const space = cut.lastIndexOf(' ');
  return space > 40 ? cut.slice(0, space) : cut;
}

/** The stand-in's one statement: reporting words only, so the drift limit has nothing to check and nothing is invented. */
export const ANSWER_TEXT = 'The candidate said this in answer to the question.';

/** Competencies judged on the whole conversation, with no question of their own to open a window. */
const CROSS_CUTTING: readonly string[] = ['communication'];

export function scriptedRecap(input: RecapInput): { competencies: { id: string; evidence: { text: string; seq: number; quote: string }[] }[]; notCovered: string[] } {
  const competencies: { id: string; evidence: { text: string; seq: number; quote: string }[] }[] = [];
  const notCovered: string[] = [];
  const openingsOf = (competencyId: string | null) => input.questions.filter((q) => competencyId === null || q.competencyId === competencyId)
    .flatMap((q) => openingsOfText(q.text));
  const opens = (n: number, openings: readonly string[]) => input.lines[n]!.side === 'panel' && openings.some((o) => hearsQuestion(input.lines[n]!.text, o));
  const anyQuestion = openingsOf(null);
  for (const c of input.competencies) {
    const own = openingsOf(c.id);
    // Each window: the candidate's answer lines (by position) from one of this competency's question lines to the next question line.
    const windows: number[][] = [];
    input.lines.forEach((_l, n) => {
      if (!opens(n, own)) return;
      const answers: number[] = [];
      for (let k = n + 1; k < input.lines.length && !opens(k, anyQuestion); k += 1) {
        const line = input.lines[k]!;
        if (line.side === 'candidate' && isAnswer(line.text)) answers.push(k);
      }
      windows.push(answers.sort((a, b) => input.lines[b]!.text.length - input.lines[a]!.text.length || a - b));
    });
    // Communication is not asked in a question of its own; it is read across everything the candidate said once a question was asked.
    if (windows.length === 0 && (CROSS_CUTTING.includes(c.id) || c.id === 'code-quality')) {
      const first = input.lines.findIndex((_l, n) => opens(n, anyQuestion));
      if (first >= 0) {
        const all: number[] = [];
        for (let k = first + 1; k < input.lines.length; k += 1) {
          const line = input.lines[k]!;
          if (line.side === 'candidate' && isAnswer(line.text) && (c.id !== 'code-quality' || codeQualityAnswer(line.text))) all.push(k);
        }
        windows.push(all.sort((a, b) => input.lines[b]!.text.length - input.lines[a]!.text.length || a - b));
      }
    }
    const taken = new Set<number>();
    for (let round = 0; taken.size < MAX_CLAIMS_PER_COMPETENCY && windows.some((w) => w.some((k) => !taken.has(k))); round += 1) {
      for (const w of windows) {
        if (taken.size >= MAX_CLAIMS_PER_COMPETENCY) break;
        const next = w.find((k) => !taken.has(k));
        if (next !== undefined) taken.add(next);
      }
    }
    const evidence = [...taken].sort((a, b) => a - b).map((k) => ({ text: ANSWER_TEXT, seq: input.lines[k]!.seq, quote: quoteOf(input.lines[k]!.text) }));
    if (evidence.length) competencies.push({ id: c.id, evidence });
    else notCovered.push(c.id);
  }
  return { competencies, notCovered };
}

export class ScriptedRecapModel implements RecapModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_RECAP_MODEL_ID;
  async write(input: RecapInput): Promise<CoachModelResult> {
    return { raw: JSON.stringify(scriptedRecap(input)), code: 'ok', sent: true, usage: null };
  }
}

/** Explicit live override for local proof runs; otherwise preserve the coach's model selection. */
export function makeRecapModel(): RecapModel {
  if (process.env['INTERVIEWS_RECAP_MODEL'] === 'openai') return new OpenAIRecapModel();
  return makeCoachModel().kind === 'scripted' ? new ScriptedRecapModel() : new BedrockRecapModel();
}
