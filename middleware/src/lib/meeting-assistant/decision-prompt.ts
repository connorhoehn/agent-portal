// What the decision check asks the model, and how its answer is read (docs/meeting-consent-design.md, "Detection").
//
// Pure: no config, no client, no clock, so the paid check script (scripts/meeting-assistant/watcher-check.mjs) builds the very
// same request, and tests compare the request body as text.
//
// The transcript is data: it is fenced (lib/untrusted-text.ts) and the system prompt carries the data rule. The answer is a schema:
// anything that is not exactly that schema is dropped whole. The server never executes the model's text; it builds the outcome itself.
import { Fence, withDataRule } from '../untrusted-text.js';

export const DECISION_MODEL_ID = 'amazon.nova-lite-v1:0';
export const MAX_ANSWER_STATEMENT = 280;
export const MAX_ANSWER_NAMED = 10;
export const MAX_ANSWER_EVIDENCE = 40;
/** The answer is short; this bounds what a runaway answer can cost. */
export const ANSWER_MAX_TOKENS = 300;

export interface CheckLine { seq: number; speaker: string; text: string }
export interface DecisionCheckInput {
  /** The window, oldest first (the last 90 s, at most 40 lines; echoes and unattributed pieces already removed). */
  lines: readonly CheckLine[];
  /** Display names of the people in the call; the only names `named` may hold. */
  roster: readonly string[];
}

export type AnswerOutcome = 'decision' | 'work-item' | 'none';
export interface DecisionAnswer {
  isDecision: boolean;
  outcome: AnswerOutcome;
  statement: string;
  named: string[];
  evidence: number[];
  confidence: number;
}

export const DECISION_SYSTEM_PROMPT = [
  'You read a short stretch of a meeting transcript and say whether the people in it just reached a decision or agreed that someone takes on a piece of work.',
  'It counts only when one person proposes something and a DIFFERENT person clearly agrees. A suggestion nobody answered, a question, a joke, sarcasm, a hypothetical or one person deciding alone is not a decision.',
  'Answer with ONE JSON object and nothing else, with exactly these keys:',
  '{"isDecision": boolean, "outcome": "decision" | "work-item" | "none", "statement": string, "named": string[], "evidence": number[], "confidence": number}',
  '- outcome: "work-item" when a named person agreed to take on a task, "decision" for any other agreement, "none" when isDecision is false.',
  `- statement: what was agreed, as one plain sentence of at most ${MAX_ANSWER_STATEMENT} characters, in the speakers' own terms; "" when none.`,
  '- named: the people who must act or who own it, spelled exactly as in the roster; [] when nobody is named. Never a name that is not in the roster.',
  '- evidence: the line numbers (the n attribute) of the proposing line and the agreeing line, and any line between them that matters.',
  '- confidence: 0 to 1, how sure you are that this is a real, agreed decision.',
].join('\n');

/** The user message: the roster and the window, each line fenced as data with its number and speaker. */
export function decisionUserText(input: DecisionCheckInput, fence: Fence = new Fence()): string {
  const roster = input.roster.map((n) => fence.wrap(n, { kind: 'roster-name', inline: true, maxChars: 80 })).join('\n');
  const lines = input.lines.map((l) => fence.wrap(l.text, { kind: 'line', inline: true, maxChars: 600, attrs: { n: String(l.seq), speaker: l.speaker } })).join('\n');
  return `Roster:\n${roster || '(none)'}\n\nTranscript, oldest first:\n${lines}\n\nAnswer with the JSON object only.`;
}

/** The Converse request (the `@aws-sdk/client-bedrock-runtime` ConverseCommand input). Deterministic for a given fence token. */
export function buildDecisionRequest(input: DecisionCheckInput, fence: Fence = new Fence()) {
  return {
    modelId: DECISION_MODEL_ID,
    system: [{ text: withDataRule(DECISION_SYSTEM_PROMPT) }],
    messages: [{ role: 'user' as const, content: [{ text: decisionUserText(input, fence) }] }],
    inferenceConfig: { maxTokens: ANSWER_MAX_TOKENS, temperature: 0 },
  };
}

/** The first JSON object in the model's text (a code fence around it is tolerated), or null. */
export function extractJson(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)) as unknown; } catch { return null; }
}

const KEYS = ['isDecision', 'outcome', 'statement', 'named', 'evidence', 'confidence'];

/** The answer when it is exactly the schema (no missing or extra keys, every bound kept); otherwise null. */
export function parseDecisionAnswer(raw: unknown): DecisionAnswer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  const { isDecision, outcome, statement, named, evidence, confidence } = o;
  if (typeof isDecision !== 'boolean') return null;
  if (outcome !== 'decision' && outcome !== 'work-item' && outcome !== 'none') return null;
  if (typeof statement !== 'string') return null;
  const s = statement.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_ANSWER_STATEMENT) return null;
  if (!Array.isArray(named) || named.length > MAX_ANSWER_NAMED || named.some((n) => typeof n !== 'string' || n.length > 120)) return null;
  if (!Array.isArray(evidence) || evidence.length > MAX_ANSWER_EVIDENCE || evidence.some((n) => !Number.isInteger(n) || (n as number) < 1)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (isDecision && (outcome === 'none' || !s)) return null;
  return { isDecision, outcome, statement: s, named: (named as string[]).map((n) => n.trim()), evidence: [...new Set(evidence as number[])], confidence };
}
