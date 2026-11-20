// Decide: one text-model call on a sentence's FINAL transcript picks what Milo does (docs/milo-rebuild/REBUILD-REVIEW.md, "Amended
// phase 1", 1A).
//
// What the model reads: the core and tenant instructions for the speaker's role, the tenant's state string (`context`), the asker's
// last three lines, Milo's last action, how the sentence reached Milo (name, follow-up, hold) and the sentence. Every line passes the
// policy's `modelReadsSpeaker` first, and only the asker's own lines are sent; a person with no role (`roleOf` null) never reaches the
// model at all.
//
// What the code enforces, whatever the model says: the tools offered are the tenant's tools for this person plus the core tools their
// role may use; a tool outside that list, arguments that do not parse or are too large, a timeout or an error, all become
// `cannot_help` (Act turns that into the fixed line only when Milo was named or held, else silence). A role that may not answer freely
// gets a forced choice (`tool_choice: required`) and any words it returns are refused the same way.
import { requestToolChoice, TextToolError, type TextToolReply, type TextToolRequest } from '../../voice/openai-text.js';
import type { ResponsesFunctionTool } from '../../voice/catalogue.js';
import { policyForLobby, type PolicyCall } from '../policy.js';
import { trace } from '../trace.js';
import {
  CORE_TOOLS, isCoreTool, TENANT_INSTRUCTIONS_MAX,
  type CoreToolName, type Decision, type DecisionReason, type HeardLine, type MiloAction, type MiloTool, type TurnPolicy, type TurnSentence,
} from './types.js';

/**
 * The Decide model, picked by accuracy and error direction in the judge lane's bake-off (114 decide-layer scenarios, two runs, scored
 * on the logged line): gpt-5.4-mini chose the right action 98.1% of the time and 96.2% on the hold-out, with no false speech and no
 * false write. gpt-5.6-luna stayed silent on 17 real requests; gpt-5.4-nano and gpt-4.1-mini retire in 2027. MILO_DECIDE_MODEL
 * overrides it, so a retired or better model is a config change.
 */
export const DEFAULT_DECIDE_MODEL = 'gpt-5.4-mini';
/** How long Decide waits for the model before the code's fallback (`cannot_help`). MILO_DECIDE_TIMEOUT_MS overrides it. */
export const DEFAULT_DECIDE_TIMEOUT_MS = 4000;
/** The asker's own recent lines sent as context. */
export const CONTEXT_LINES = 3;
/** A free answer is spoken: at most this many characters are kept. */
export const ANSWER_MAX_CHARS = 400;
const DEFAULT_ARGS_BYTES = 4096;

export function decideModel(): string { return (process.env['MILO_DECIDE_MODEL'] ?? '').trim() || DEFAULT_DECIDE_MODEL; }
function decideTimeoutMs(): number {
  const n = Number(process.env['MILO_DECIDE_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DECIDE_TIMEOUT_MS;
}

const fn = (name: string, description: string): ResponsesFunctionTool =>
  ({ type: 'function', name, description, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } });

/** The core tools' words for the model. */
export const CORE_TOOL_DEFS: Readonly<Record<CoreToolName, ResponsesFunctionTool>> = Object.freeze({
  stay_silent: fn('stay_silent', 'Say nothing: the sentence is not a request to Milo (talking about Milo, to someone else, thanking, agreeing, or closing). Mentioning the name is not asking.'),
  cannot_help: fn('cannot_help', 'The sentence asks Milo for something, but none of the other tools does it or this person may not ask for it.'),
  keep_listening: fn('keep_listening', 'The sentence is a request to Milo that stops mid-thought (for example "Milo, add a test for..."): wait for the rest before acting.'),
  pause_listening: fn('pause_listening', 'The speaker asks Milo to stop listening, mute itself or be quiet for now.'),
  leave_call: fn('leave_call', 'The speaker asks Milo to leave the call.'),
  cancel: fn('cancel', 'The speaker asks Milo to stop what it is doing or saying, or takes back their request ("never mind", "cancel that").'),
});

const DEFAULT_CORE: Readonly<Record<CoreToolName, boolean>> = Object.freeze({
  stay_silent: true, cannot_help: true, keep_listening: true, pause_listening: true, leave_call: true, cancel: true,
});

/** The core tools this role may use; stay_silent and cannot_help are always offered (the code's own fallbacks). */
export function coreToolsFor(policy: TurnPolicy, call: PolicyCall, role: string): CoreToolName[] {
  return CORE_TOOLS.filter((t) => t === 'stay_silent' || t === 'cannot_help' || (policy.mayUseCore ? policy.mayUseCore(call, role, t) : DEFAULT_CORE[t]));
}

const CORE_INSTRUCTIONS = [
  'You are Milo, a voice assistant in a call. You get one sentence one person just said; it may or may not be meant for you.',
  'Pick exactly one tool. If the sentence is not a request to you, call stay_silent: people often talk about Milo, or to each other, near you.',
  'If it asks you for something none of your tools does, call cannot_help. Never guess a tool the person did not ask for.',
  'A follow-up sentence (no name) is for you only if it plainly continues the request you just answered; otherwise stay_silent.',
].join(' ');
const FREE_INSTRUCTIONS = 'If the person asks you a question no tool answers and you can answer it, you may answer in at most two short spoken sentences, plain words, no markdown, instead of calling a tool.';

export interface DecideInput {
  call: PolicyCall;
  policy: TurnPolicy;
  sentence: TurnSentence;
  /** Recent lines of the call, any speaker, oldest first; Decide keeps the asker's last three the model may read. */
  recent: readonly HeardLine[];
  lastAction: MiloAction | null;
}

export interface DecideDeps {
  request?: (req: TextToolRequest, opts: { timeoutMs: number }) => Promise<TextToolReply>;
  /** Which speakers' lines the models may read. Absent: the call's policy (`modelReadsSpeaker`), all when it has none. */
  modelReads?: (call: PolicyCall) => Promise<(userId: string | null) => boolean>;
  model?: string;
  timeoutMs?: number;
}

async function readsOf(call: PolicyCall, deps: DecideDeps): Promise<(userId: string | null) => boolean> {
  if (deps.modelReads) return deps.modelReads(call);
  const p = policyForLobby(call.lobby);
  if (!p.modelReadsSpeaker) return () => true;
  return (await p.modelReadsSpeaker(call).catch(() => null)) ?? (() => false);
}

const VIA_WORDS: Record<TurnSentence['via'], string> = {
  name: 'they said your name',
  'follow-up': 'no name; it came within seconds after you answered this person',
  hold: 'they held the button that asks Milo',
};

/** The user turn the model reads. Exported for tests (what is, and is not, in a request). */
export function decideInput(input: { role: string; sentence: TurnSentence; lines: readonly HeardLine[]; lastAction: MiloAction | null; state: string }): string {
  const parts = [`Speaker's role: ${input.role}`];
  if (input.state.trim()) parts.push(`Call state: ${input.state.trim()}`);
  if (input.lines.length) parts.push(`Their recent lines, oldest first:\n${input.lines.map((l) => `- ${l.text}`).join('\n')}`);
  if (input.lastAction) {
    const a = input.lastAction;
    parts.push(`Your last action: ${a.tool}${Object.keys(a.args).length ? ` ${JSON.stringify(a.args)}` : ''}${a.line ? `, you said: "${a.line}"` : ''}`);
  }
  parts.push(`How it reached you: ${VIA_WORDS[input.sentence.via]}`);
  parts.push(`Sentence: "${input.sentence.text}"`);
  return parts.join('\n\n');
}

/** Decide what Milo does about one final sentence. Never throws: every failure is the code's `cannot_help`. */
export async function decide(input: DecideInput, deps: DecideDeps = {}): Promise<Decision> {
  const { call, policy, sentence } = input;
  const role = await policy.roleOf(call, sentence.who).catch(() => null);
  if (role === null) { trace('turn.decide', { outcome: 'no-role' }); return { kind: 'none', reason: 'no-role' }; }

  const tenantTools = (await policy.toolsFor(call, { userId: sentence.who, role }).catch(() => [] as MiloTool[])).filter((t) => !isCoreTool(t.name));
  const core = coreToolsFor(policy, call, role);
  const offered = [...tenantTools.map((t) => t.name), ...core];
  const free = policy.answersFreely(call, role);
  const fallback = (reason: DecisionReason): Decision => ({ kind: 'tool', tool: 'cannot_help', args: {}, core: true, offered, reason, role });

  const may = await readsOf(call, deps);
  const lines = input.recent.filter((l) => l.userId === sentence.who && may(l.userId)).slice(-CONTEXT_LINES);
  const lastAction = input.lastAction && may(input.lastAction.askedBy) ? input.lastAction : null;
  const state = await policy.context(call, { userId: sentence.who, role }).catch(() => '');
  const tenantWords = policy.instructions(call, role).slice(0, TENANT_INSTRUCTIONS_MAX);

  const req: TextToolRequest = {
    model: deps.model ?? decideModel(),
    instructions: [CORE_INSTRUCTIONS, free ? FREE_INSTRUCTIONS : 'Never answer in words: always call one tool.', tenantWords].filter(Boolean).join('\n\n'),
    input: decideInput({ role, sentence, lines, lastAction, state }),
    tools: [...tenantTools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters })), ...core.map((t) => CORE_TOOL_DEFS[t])],
    toolChoice: free ? 'auto' : 'required',
  };

  let reply: TextToolReply;
  try {
    reply = await (deps.request ?? requestToolChoice)(req, { timeoutMs: deps.timeoutMs ?? decideTimeoutMs() });
  } catch (e) {
    const reason: DecisionReason = e instanceof TextToolError && e.kind === 'timeout' ? 'timeout' : 'error';
    trace('turn.decide', { outcome: reason, kind: e instanceof TextToolError ? e.kind : 'error' });
    return fallback(reason);
  }
  const done = (d: Decision): Decision => {
    trace('turn.decide', { outcome: d.kind === 'none' ? 'no-role' : d.reason, tool: d.kind === 'tool' ? d.tool : d.kind, ms: Math.round(reply.ms), model: req.model, input: reply.usage?.input, output: reply.usage?.output });
    return d;
  };

  if (!reply.call) {
    if (reply.text && free) return done({ kind: 'answer', text: reply.text.slice(0, ANSWER_MAX_CHARS), offered, reason: 'model', role });
    return done(fallback(reply.text ? 'free-text-refused' : 'malformed'));
  }
  const { name } = reply.call;
  if (!offered.includes(name)) return done(fallback('not-offered'));
  const tool = tenantTools.find((t) => t.name === name);
  if (Buffer.byteLength(reply.call.arguments, 'utf8') > (tool?.maxArgsBytes ?? DEFAULT_ARGS_BYTES)) return done(fallback('args-too-large'));
  let args: unknown;
  try { args = JSON.parse(reply.call.arguments || '{}'); } catch { return done(fallback('malformed')); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return done(fallback('malformed'));
  return done({ kind: 'tool', tool: name, args: isCoreTool(name) ? {} : args as Record<string, unknown>, core: isCoreTool(name), offered, reason: 'model', role });
}
