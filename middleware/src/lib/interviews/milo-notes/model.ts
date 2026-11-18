// Milo's model for the lead's private questions (row I3.6; contract E0): Amazon Nova through Bedrock's Converse API, or a
// scripted stand-in. Which one runs is the coach's one switch, `makeCoachModel().kind === 'scripted'`, so a test's
// `setCoachModelFactory` and the mock world flip this model with the coach's.
//
// Rules kept as the coach keeps them (lib/interviews/coach/model.ts):
//   * the coach's timeout and at most one retry; a failure is a code, never an exception to the caller;
//   * nothing of the transcript, the prompt or the answer is logged: only the error's name;
//   * the model returns raw text; parse.ts reads it the same way for both models, so the stand-in walks the real path.
//
// `BedrockMiloModel.converse(request)` sends any Converse request built as data, so the question plan (row I3.10)
// sends its own request through this class. The call itself goes through the tenant's one Bedrock seam (../bedrock.ts).
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { converseOnce, type ConverseSend } from '../bedrock.js';
import { COACH_TIMEOUT_MS, coachModelId, makeCoachModel } from '../coach/model.js';
import type { CoachLine } from '../coach/prompt.js';
import { ASK_MAX_TOKENS, ASK_SYSTEM_PROMPT, askUserText, buildAskRequest, NOT_SAID, type AskInput } from './prompt.js';

export const SCRIPTED_MILO_MODEL_ID = 'scripted-milo';

export interface MiloTokenCounts { inputTokens: number; outputTokens: number }
export interface MiloModelResult {
  /** The model's text, or null when nothing came back. */
  raw: string | null;
  code: 'ok' | 'timeout' | 'error';
  /** The request reached the provider (so it may have cost something). */
  sent: boolean;
  usage: MiloTokenCounts | null;
}

export interface MiloModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  ask(input: AskInput): Promise<MiloModelResult>;
}

/** About four characters a token, plus the answer's cap: what a hold is sized from. */
export function estimateAskTokens(input: AskInput): MiloTokenCounts {
  const chars = ASK_SYSTEM_PROMPT.length + 800 + askUserText(input).length;
  return { inputTokens: Math.ceil(chars / 4), outputTokens: ASK_MAX_TOKENS };
}

export type MiloSend = ConverseSend;

export class BedrockMiloModel implements MiloModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  constructor(private readonly opts: { send?: MiloSend; timeoutMs?: number; modelId?: string } = {}) {
    this.modelId = opts.modelId ?? coachModelId();
  }

  /** Send one Converse request built as data (its `modelId` should be this model's). */
  converse(request: ConverseCommandInput): Promise<MiloModelResult> {
    return converseOnce(request, { send: this.opts.send, timeoutMs: this.opts.timeoutMs ?? COACH_TIMEOUT_MS, label: 'milo' });
  }

  ask(input: AskInput): Promise<MiloModelResult> {
    return this.converse(buildAskRequest(this.modelId, input) as ConverseCommandInput);
  }
}

// ---- the scripted stand-in --------------------------------------------------------------------------------------------------------
//
// Deterministic, from the words, never from meaning: the question's content words (four letters or more, common words
// left out, one common ending dropped); the candidate's lines that share at least one of them, oldest first, at most three;
// one sentence per line naming its number, each with the line quoted (its first 200 characters, cut at a word). No line
// shares a word: NOT_SAID.

const STOP = new Set(('what that this with about they them their there have said does didn when where which were been from your would could '
  + 'should tell talk mention mentioned says anything something candidate candidates interview line lines think more much some them then than '
  + 'into also just like only over such very will want wants know how why who whom whose here does doing done').split(' '));

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
/** A light stem, so "page", "paged" and "paging" meet: one common ending off, three letters kept. */
const stem = (w: string): string => { const t = w.replace(/(?:ing|ed|es|s|e)$/, ''); return t.length >= 3 ? t : w; };
const tokens = (s: string): string[] => words(s).map(stem);

export const contentWords = (s: string): string[] => [...new Set(words(s).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))];

function quoteOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 200) return t;
  const cut = t.slice(0, 200);
  const space = cut.lastIndexOf(' ');
  return space > 40 ? cut.slice(0, space) : cut;
}

export function scriptedAnswer(input: Pick<AskInput, 'lines' | 'question'>): { answer: string; sources: Array<{ seq: number; quote: string }> } {
  const want = new Set(contentWords(input.question));
  const hits = want.size ? input.lines.filter((l: CoachLine) => l.side === 'candidate' && tokens(l.text).some((w) => want.has(w))).slice(0, 3) : [];
  if (!hits.length) return { answer: NOT_SAID, sources: [] };
  return {
    answer: hits.map((l) => `The candidate spoke of it in line ${l.seq}.`).join(' '),
    sources: hits.map((l) => ({ seq: l.seq, quote: quoteOf(l.text) })),
  };
}

export class ScriptedMiloModel implements MiloModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_MILO_MODEL_ID;
  async ask(input: AskInput): Promise<MiloModelResult> {
    return { raw: JSON.stringify(scriptedAnswer(input)), code: 'ok', sent: true, usage: null };
  }
}

/** The one switch (E0): the coach's choice decides. */
export function makeMiloModel(): MiloModel {
  return makeCoachModel().kind === 'scripted' ? new ScriptedMiloModel() : new BedrockMiloModel();
}
