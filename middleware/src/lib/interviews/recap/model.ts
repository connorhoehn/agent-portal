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
//   For each competency in the kit's order: the panel lines that contain the opening words (the first six) of one of the
//   asked questions tied to that competency; after each such line, the candidate lines that follow it until the next
//   panel line (a question Milo said aloud is a panel line of the timeline, service.ts `withMiloQuestions`). A candidate line that
//   speaks to Milo (a repeat or time request) is a request, not an answer, and never counts. Each becomes one statement, ANSWER_TEXT, beside the line's own words as its quote (its first
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

export function scriptedRecap(input: RecapInput): { competencies: { id: string; evidence: { text: string; seq: number; quote: string }[] }[]; notCovered: string[] } {
  const competencies: { id: string; evidence: { text: string; seq: number; quote: string }[] }[] = [];
  const notCovered: string[] = [];
  for (const c of input.competencies) {
    const openings = input.questions.filter((q) => q.competencyId === c.id).map((q) => opening(q.text)).filter((o) => o.length > 0);
    const evidence: { text: string; seq: number; quote: string }[] = [];
    const used = new Set<number>();
    const answersFrom = (k: number) => {
      for (; k < input.lines.length && input.lines[k]!.side === 'candidate'; k += 1) {
        const line = input.lines[k]!;
        if (used.has(line.seq) || evidence.length >= MAX_CLAIMS_PER_COMPETENCY || addressesMilo(line.text)) continue;
        const quote = quoteOf(line.text);
        if (!quote) continue;
        used.add(line.seq);
        evidence.push({ text: ANSWER_TEXT, seq: line.seq, quote });
      }
    };
    input.lines.forEach((l, n) => {
      if (l.side !== 'panel' || !openings.some((o) => words(l.text).includes(o))) return;
      answersFrom(n + 1);
    });
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
