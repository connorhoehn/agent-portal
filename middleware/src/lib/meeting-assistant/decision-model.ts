// The decision check's model (docs/meeting-consent-design.md, "Detection", step 3): Amazon Nova Lite through Bedrock, following the
// client in lib/session-titles.ts, or a scripted stand-in chosen the way session-select.ts chooses the live session (the mock world
// scripts it unless MEETING_ASSISTANT_LIVE=1 asks for the real one), so tests and walks are deterministic and cost nothing.
//
// Rules kept here:
//   * a short timeout and at most one retry; a failure is a code, never an exception to the caller;
//   * nothing of the transcript, the prompt or the answer is logged: only codes and counts;
//   * the answer is read by parseDecisionAnswer (decision-prompt.ts); anything else is `malformed` and dropped.
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../../config.js';
import { liveForced } from './live-flag.js';
import { mockTranscriptEnabled } from './transcript-source.js';
import {
  buildDecisionRequest, DECISION_MODEL_ID, DECISION_SYSTEM_PROMPT, decisionUserText, extractJson, parseDecisionAnswer,
  type CheckLine, type DecisionAnswer, type DecisionCheckInput,
} from './decision-prompt.js';

export const DECISION_TIMEOUT_MS = 8000;

export interface TokenCounts { inputTokens: number; outputTokens: number }
export interface ModelCheckResult {
  answer: DecisionAnswer | null;
  code: 'ok' | 'malformed' | 'timeout' | 'error';
  /** The request reached the provider (so it may have cost something). */
  sent: boolean;
  /** The provider's own counts, when it gave them. */
  usage: TokenCounts | null;
  /** What the request should weigh, for booking when the provider gave no counts. */
  estimate: TokenCounts;
}

export interface DecisionModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  check(input: DecisionCheckInput): Promise<ModelCheckResult>;
}

/** About four characters a token, plus the answer's usual size. */
export function estimateTokens(input: DecisionCheckInput): TokenCounts {
  const chars = DECISION_SYSTEM_PROMPT.length + 600 + decisionUserText(input).length;
  return { inputTokens: Math.ceil(chars / 4), outputTokens: 150 };
}

type Send = (cmd: ConverseCommand, opts: { abortSignal: AbortSignal }) => Promise<ConverseCommandOutput>;

let client: BedrockRuntimeClient | null = null;
const defaultSend: Send = (cmd, opts) => {
  // One retry at most: the SDK's attempts count the first try.
  client ??= new BedrockRuntimeClient({ region: config.region, maxAttempts: 2 });
  return client.send(cmd, opts);
};

export class BedrockDecisionModel implements DecisionModel {
  readonly kind = 'bedrock' as const;
  readonly modelId = DECISION_MODEL_ID;
  constructor(private readonly opts: { send?: Send; timeoutMs?: number } = {}) {}

  async check(input: DecisionCheckInput): Promise<ModelCheckResult> {
    const estimate = estimateTokens(input);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.timeoutMs ?? DECISION_TIMEOUT_MS);
    timer.unref?.();
    try {
      const resp = await (this.opts.send ?? defaultSend)(new ConverseCommand(buildDecisionRequest(input) as ConverseCommandInput), { abortSignal: abort.signal });
      const usage = resp.usage && Number.isFinite(resp.usage.inputTokens) && Number.isFinite(resp.usage.outputTokens)
        ? { inputTokens: Number(resp.usage.inputTokens), outputTokens: Number(resp.usage.outputTokens) } : null;
      const text = (resp.output?.message?.content ?? []).map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('');
      const answer = parseDecisionAnswer(extractJson(text));
      return { answer, code: answer ? 'ok' : 'malformed', sent: true, usage, estimate };
    } catch (e) {
      // The error's name only: its message could quote the request.
      const timedOut = abort.signal.aborted;
      console.warn('[meeting-assistant] decision check failed', timedOut ? 'timeout' : (e as Error)?.name ?? 'error');
      return { answer: null, code: timedOut ? 'timeout' : 'error', sent: true, usage: null, estimate };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- the scripted stand-in --------------------------------------------------------------------------------------------------------
//
// Decides from fixed phrases, never from meaning:
//   proposal  "let's go with X", "so we'll X", "I propose X", "we decided X", "decision: X", or "let's X" (not see/talk/think/wait/...);
//   agreement a LATER line by a DIFFERENT speaker that starts with "agreed", "yes", "yep", "sounds good", "works for me", "fine by me",
//             "let's do it/that" or "deal", or that says "agreed";
//   work item "<Name>, can you own X" answered later by <Name> with an agreement or "sure" / "I'll take it" / "on it";
//   a joke    either line says "just kidding", "kidding", "joking", "haha" or "lol": nothing.
// The latest qualifying pair wins; a decision is preferred to a work item. Confidence 0.9.

const PROPOSAL = /\b(?:let'?s go with|so we'?ll|i propose(?: that)?(?: we)?|we decided(?: to)?|decision:|let'?s(?!\s+(?:see|talk|think|wait|chat|discuss|check|move on|break|not)\b))\s+(.{3,200}?)\s*(?:[.!?]|$)/i;
const AGREEMENT = /^\W*(?:agreed|yes|yep|sounds good|works for me|fine by me|let'?s do (?:it|that)|deal)\b|\bagreed\b/i;
const TAKES_IT = /^\W*(?:sure|i'?ll take it|on it)\b/i;
const OWN_ASK = /\b([A-Z][\p{L}'’-]*),?\s+can you own\s+(.{3,200}?)\s*(?:[.!?]|$)/u;
const JOKE = /\b(?:just kidding|kidding|joking|haha|lol)\b/i;

const sentence = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

/** The roster name a spoken name stands for: the exact name, or a first name only one person has. */
function rosterName(said: string, roster: readonly string[]): string | null {
  if (roster.includes(said)) return said;
  const first = roster.filter((n) => n.split(/\s+/)[0] === said);
  return first.length === 1 ? first[0]! : null;
}

export function scriptedAnswer(input: DecisionCheckInput): DecisionAnswer {
  const none: DecisionAnswer = { isDecision: false, outcome: 'none', statement: '', named: [], evidence: [], confidence: 0.9 };
  const lines = input.lines;
  const agreeAfter = (i: number, by: (l: CheckLine) => boolean, extra?: RegExp): CheckLine | null => {
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j]!;
      if (by(l) && (AGREEMENT.test(l.text) || (extra?.test(l.text) ?? false))) return l;
    }
    return null;
  };
  let decision: DecisionAnswer | null = null;
  let work: DecisionAnswer | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const p = lines[i]!;
    const prop = PROPOSAL.exec(p.text);
    if (prop) {
      const yes = agreeAfter(i, (l) => l.speaker !== p.speaker);
      if (yes && !JOKE.test(p.text) && !JOKE.test(yes.text)) {
        decision = { isDecision: true, outcome: 'decision', statement: sentence(prop[1]!).slice(0, 280), named: [], evidence: [p.seq, yes.seq], confidence: 0.9 };
      }
    }
    const ask = OWN_ASK.exec(p.text);
    const who = ask ? rosterName(ask[1]!, input.roster) : null;
    if (ask && who && who !== p.speaker) {
      const yes = agreeAfter(i, (l) => l.speaker === who, TAKES_IT);
      if (yes && !JOKE.test(p.text) && !JOKE.test(yes.text)) {
        work = { isDecision: true, outcome: 'work-item', statement: `${ask[1]!} owns ${ask[2]!.trim()}`.slice(0, 280), named: [who], evidence: [p.seq, yes.seq], confidence: 0.9 };
      }
    }
  }
  return decision ?? work ?? none;
}

export class ScriptedDecisionModel implements DecisionModel {
  readonly kind = 'scripted' as const;
  readonly modelId = 'scripted-decision-check';
  async check(input: DecisionCheckInput): Promise<ModelCheckResult> {
    const estimate = estimateTokens(input);
    return { answer: scriptedAnswer(input), code: 'ok', sent: true, usage: null, estimate };
  }
}

export type DecisionModelFactory = () => DecisionModel;
export const defaultDecisionModelFactory: DecisionModelFactory = () =>
  (mockTranscriptEnabled() && !liveForced() ? new ScriptedDecisionModel() : new BedrockDecisionModel());

let factory: DecisionModelFactory | null = null;
export function setDecisionModelFactory(next: DecisionModelFactory | null): void { factory = next; }
export function makeDecisionModel(): DecisionModel { return (factory ?? defaultDecisionModelFactory)(); }
