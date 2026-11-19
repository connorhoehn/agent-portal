// Milo's recap model (docs/interviews-tenant-plan.md decisions 6, 7; row I5.2; contract E0): Amazon Nova through Bedrock's
// Converse API, or a scripted stand-in. Which one runs is the coach's one switch (`makeCoachModel().kind === 'scripted'`),
// so the mock world, tests and a test's `setCoachModelFactory` flip the recap with the coach.
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
import { addressesMilo } from './parse.js';

export const SCRIPTED_RECAP_MODEL_ID = 'scripted-recap';
/**
 * Nobody is mid-conversation when the recap is written, and the answer is a few hundred tokens rather than one question:
 * three times the coach's timeout.
 */
export const RECAP_TIMEOUT_MS = COACH_TIMEOUT_MS * 3;

export interface RecapModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
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
    .map((q) => opening(q.text)).filter((o) => o.length > 0);
  const opens = (n: number, openings: readonly string[]) => input.lines[n]!.side === 'panel' && openings.some((o) => words(input.lines[n]!.text).includes(o));
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
        if (line.side === 'candidate' && !addressesMilo(line.text) && quoteOf(line.text)) answers.push(k);
      }
      windows.push(answers.sort((a, b) => input.lines[b]!.text.length - input.lines[a]!.text.length || a - b));
    });
    // Communication is not asked in a question of its own; it is read across everything the candidate said once a question was asked.
    if (windows.length === 0 && CROSS_CUTTING.includes(c.id)) {
      const first = input.lines.findIndex((_l, n) => opens(n, anyQuestion));
      if (first >= 0) {
        const all: number[] = [];
        for (let k = first + 1; k < input.lines.length; k += 1) {
          const line = input.lines[k]!;
          if (line.side === 'candidate' && !addressesMilo(line.text) && quoteOf(line.text)) all.push(k);
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

/** E0's one switch: the scripted recap whenever the coach is scripted. */
export function makeRecapModel(): RecapModel {
  return makeCoachModel().kind === 'scripted' ? new ScriptedRecapModel() : new BedrockRecapModel();
}
