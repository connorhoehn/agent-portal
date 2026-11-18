// The coach's model (docs/interviews-tenant-plan.md decision 7, row I3.3): Amazon Nova through Bedrock's Converse API, or a
// scripted stand-in chosen the way lib/meeting-assistant/session-select.ts chooses (the mock world scripts it unless
// MEETING_ASSISTANT_LIVE=1 asks for the real one), so tests and walks are deterministic and cost nothing.
//
// Rules kept here, as lib/meeting-assistant/decision-model.ts keeps them:
//   * a short timeout and at most one retry; a failure is a code, never an exception to the caller;
//   * nothing of the transcript, the prompt or the answer is logged: only codes;
//   * the call itself goes through the tenant's one Bedrock seam (../bedrock.ts);
//   * the model returns raw text; parse.ts reads it, the same way for both models, so the stand-in walks the real path.
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { converseOnce, refusedBeforeRunning, type ConverseSend } from '../bedrock.js';
import { liveForced } from '../../meeting-assistant/live-flag.js';
import { mockTranscriptEnabled } from '../../meeting-assistant/transcript-source.js';
import { buildCoachRequest, coachUserText, COACH_SYSTEM_PROMPT, MAX_BASED_ON_CHARS, type CoachInput } from './prompt.js';

/** Nova Pro: the coach's words reach a person judging another person, so it gets the stronger of the two text models. */
export const DEFAULT_COACH_MODEL_ID = 'amazon.nova-pro-v1:0';
export const SCRIPTED_COACH_MODEL_ID = 'scripted-coach';
/** One suggestion should come back well inside the 90 seconds between suggestions; the lead is mid-conversation. */
export const COACH_TIMEOUT_MS = 10_000;

/** `INTERVIEWS_COACH_MODEL_ID`: the deployment's Bedrock model for the coach (an Amazon Nova text model), else Nova Pro. */
export function coachModelId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env['INTERVIEWS_COACH_MODEL_ID'] ?? '').trim();
  return /^[A-Za-z0-9.:_-]{3,120}$/.test(raw) ? raw : DEFAULT_COACH_MODEL_ID;
}

export interface TokenCounts { inputTokens: number; outputTokens: number }
export interface CoachModelResult {
  /** The model's text, or null when nothing came back. */
  raw: string | null;
  /** `nothing`: the stand-in has nothing left to suggest. */
  code: 'ok' | 'nothing' | 'timeout' | 'error';
  /** The request reached the provider (so it may have cost something). */
  sent: boolean;
  /** The provider's own counts, when it gave them. */
  usage: TokenCounts | null;
}

export interface CoachModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  suggest(input: CoachInput): Promise<CoachModelResult>;
}

/** About four characters a token, plus the answer's usual size: what a hold is sized from. */
export function estimateCoachTokens(input: CoachInput): TokenCounts {
  const chars = COACH_SYSTEM_PROMPT.length + 800 + coachUserText(input).length;
  return { inputTokens: Math.ceil(chars / 4), outputTokens: 120 };
}

export { refusedBeforeRunning };

export class BedrockCoachModel implements CoachModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  constructor(private readonly opts: { send?: ConverseSend; timeoutMs?: number; modelId?: string } = {}) {
    this.modelId = opts.modelId ?? coachModelId();
  }

  suggest(input: CoachInput): Promise<CoachModelResult> {
    // A refusal (no access, bad credentials, a throttle, a bad request) ran no model and bills nothing, so no spend is
    // booked for it; a timeout or a server-side failure may have run, so it is booked at the estimate as before.
    return converseOnce(buildCoachRequest(this.modelId, input) as ConverseCommandInput,
      { send: this.opts.send, timeoutMs: this.opts.timeoutMs ?? COACH_TIMEOUT_MS, label: 'coach', refusalBooksNothing: true });
  }
}

// ---- the scripted stand-in --------------------------------------------------------------------------------------------------------
//
// Deterministic, from the kit and the transcript it is given, never from meaning:
//   1. the competencies in the kit's order; a competency is covered when an earlier suggestion was tied to it, or when a
//      panel line contains the opening words of one of its bank questions (the question was asked);
//   2. the first competency not covered, with its first bank question (chosen questions first, then the bank's order)
//      that was neither suggested nor asked;
//   3. when every competency is covered: the first follow-up of an asked or suggested question not yet suggested;
//   4. when nothing is left: no answer (`nothing`).
// The suggestion quotes the last candidate line (its first 200 characters, cut at a word) when there is one, else null.

const words = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
/** A question's opening words (its first six). */
const opening = (s: string): string => words(s).split(' ').slice(0, 6).join(' ');
const said = (needle: string, line: string): boolean => needle.length > 0 && words(line).includes(needle);

function quoteOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 200) return t;
  const cut = t.slice(0, 200);
  const space = cut.lastIndexOf(' ');
  return space > 40 ? cut.slice(0, space) : cut;
}

export function scriptedSuggestion(input: CoachInput): { text: string; competencyId: string; basedOn: string | null } | null {
  const panel = input.lines.filter((l) => l.side === 'panel').map((l) => l.text);
  const asked = (prompt: string) => panel.some((t) => said(opening(prompt), t));
  const suggested = new Set(input.previous.map((p) => p.text.replace(/\s+/g, ' ').trim()));
  const chosen = input.chosenQuestionIds;
  const bank = [...input.questions].sort((a, b) => {
    const ia = chosen.indexOf(a.id); const ib = chosen.indexOf(b.id);
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
  });
  const lastCandidate = [...input.lines].reverse().find((l) => l.side === 'candidate');
  const basedOn = lastCandidate ? quoteOf(lastCandidate.text).slice(0, MAX_BASED_ON_CHARS) : null;
  const covered = new Set(input.previous.map((p) => p.competencyId));
  for (const q of bank) if (asked(q.prompt)) covered.add(q.competencyId);
  for (const c of input.competencies) {
    if (covered.has(c.id)) continue;
    const q = bank.find((x) => x.competencyId === c.id && !suggested.has(x.prompt) && !asked(x.prompt));
    if (q) return { text: q.prompt, competencyId: c.id, basedOn };
  }
  for (const q of bank) {
    if (!asked(q.prompt) && !suggested.has(q.prompt)) continue;
    const f = q.followUps.find((x) => !suggested.has(x) && !asked(x));
    if (f) return { text: f, competencyId: q.competencyId, basedOn };
  }
  return null;
}

export class ScriptedCoachModel implements CoachModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_COACH_MODEL_ID;
  async suggest(input: CoachInput): Promise<CoachModelResult> {
    const s = scriptedSuggestion(input);
    return s ? { raw: JSON.stringify(s), code: 'ok', sent: true, usage: null } : { raw: null, code: 'nothing', sent: true, usage: null };
  }
}

export type CoachModelFactory = () => CoachModel;
export const defaultCoachModelFactory: CoachModelFactory = () =>
  (mockTranscriptEnabled() && !liveForced() ? new ScriptedCoachModel() : new BedrockCoachModel());

let factory: CoachModelFactory | null = null;
export function setCoachModelFactory(next: CoachModelFactory | null): void { factory = next; }
export function makeCoachModel(): CoachModel { return (factory ?? defaultCoachModelFactory)(); }
