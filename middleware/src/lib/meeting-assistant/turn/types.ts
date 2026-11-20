// The turn owner's shared shapes (docs/milo-rebuild/REBUILD-PLAN.md section 2, amended by REBUILD-REVIEW.md risks 6, 8 and 12).
//
// A turn is one sentence someone said, judged once on the final transcript: Decide picks one tool (or, where the person's role
// answers freely, a short answer), Act runs it as that person, Speak logs the line and then says exactly the logged words.
//
// The tenant contract (`TurnPolicy`) is everything the turn needs from the kind of call it is in. The core imports nothing from a
// tenant's folder: a tenant hands over its roles, tools, instructions, fixed lines, its log of what Milo said, and its state string.
import type { JsonSchemaObject } from '../../voice/catalogue.js';
import type { PolicyCall } from '../policy.js';

/**
 * The core tools every Decide call may offer. They are answered by the turn, not by a tenant:
 *   stay_silent      the sentence was not for Milo (a mention, talk to someone else, thanks, a close)
 *   cannot_help      for Milo, but nothing this person may ask for (the tenant's fixed line, or silence)
 *   keep_listening   a request for Milo cut off mid-thought: wait for the rest
 *   pause_listening  stop listening until asked again
 *   leave_call       leave the call
 *   cancel           stop what Milo is doing or about to do ("never mind")
 */
export const CORE_TOOLS = ['stay_silent', 'cannot_help', 'keep_listening', 'pause_listening', 'leave_call', 'cancel'] as const;
export type CoreToolName = typeof CORE_TOOLS[number];
export const isCoreTool = (name: string): name is CoreToolName => (CORE_TOOLS as readonly string[]).includes(name);

/** A tenant's tool as Decide offers it. `kind: 'server'` runs through server-tools.ts `runServerTool`; `catalogue` is Work's browser turn (phase 2). */
export interface MiloTool {
  name: string;
  /** What the model reads. */
  description: string;
  parameters: JsonSchemaObject;
  kind: 'server' | 'catalogue';
  /** It changes something: it runs only while its turn is still the current one (a new onset from the asker cancels it). */
  writes: boolean;
  /** The largest arguments a call may carry, in bytes. Absent: 4096. */
  maxArgsBytes?: number;
}

/** Who said the sentence, as the turn knows them: the user and the role the tenant gave them for this call. */
export interface TurnPerson { userId: string; role: string }

/** One sentence handed to the turn: a final transcript line from one person's lane. */
export interface TurnSentence {
  /** Unique per sentence: the idempotency key (a sentence is acted on once, however often it is handed over). */
  id: string;
  /** The speaker's user id (the lane it was heard on). */
  who: string;
  text: string;
  /** When it ended, ms on the turn owner's clock. */
  atMs: number;
  /** How it reached the turn: the name was heard in it, it is a follow-up inside the window after Milo answered this person, or the hold button was down. */
  via: 'name' | 'follow-up' | 'hold';
}

/** One earlier line of the call, as the turn owner keeps it for context. */
export interface HeardLine { userId: string | null; text: string; atMs: number }

/** What Milo last did for the call: the tool, its arguments and the line it said ("same again but in Python" needs all three). */
export interface MiloAction { tool: string; args: Record<string, unknown>; line: string | null; askedBy: string; atMs: number }

/** What Decide chose. `offered` is the tool names the request carried; Act refuses anything outside it. */
export type Decision =
  | { kind: 'tool'; tool: string; args: Record<string, unknown>; core: boolean; offered: readonly string[]; reason: DecisionReason; role: string }
  | { kind: 'answer'; text: string; offered: readonly string[]; reason: DecisionReason; role: string }
  /** The person has no role in this call (null `roleOf`, e.g. a candidate who declined Milo): no model call was made. */
  | { kind: 'none'; reason: 'no-role' };

/**
 * Why Decide chose it: the model's own choice, or the code's fallback when the model's reply could not be used (a timeout, an
 * error, an unparseable reply, a tool it was not offered, arguments too large, words from a role that may not answer freely).
 */
export type DecisionReason = 'model' | 'timeout' | 'error' | 'malformed' | 'not-offered' | 'args-too-large' | 'free-text-refused';

/** A line Milo is about to say, as the tenant's log receives it (before any audio). */
export interface SpokenLine {
  text: string;
  askedBy: string;
  /** The tool that produced it (`cannot_help`, `answer`, a tenant tool). */
  tool: string;
  /** The sentence it answers (the idempotency key). */
  sentenceId: string;
}

/** How a logged line ended: heard whole, cut off (talked over or cancelled), or never played (posted to the chat only). */
export type SpokenOutcome = 'spoken' | 'partly' | 'unspoken';

/**
 * The tenant contract: the members a kind of call supplies for the turn owner. On `MeetingAssistantPolicy` they are optional (a
 * policy that has not adopted the turn owner leaves them out); `turnPolicyOf` (policy.ts) gives the complete contract or null.
 */
export interface TurnPolicy {
  /** The person's role in this call, or null: none of their sentences reach Decide (and none of their lines reach its context). */
  roleOf(call: PolicyCall, userId: string): Promise<string | null>;
  /** The tenant tools this person may ask for, already filtered by who may ask. Core tools are added by the turn. */
  toolsFor(call: PolicyCall, person: TurnPerson): Promise<MiloTool[]>;
  /** True: the role may get a short model-written answer. False: a forced choice of tools, no model-written words. */
  answersFreely(call: PolicyCall, role: string): boolean;
  /** The tenant's words for Decide about this role (600 characters at most; longer is cut). */
  instructions(call: PolicyCall, role: string): string;
  /** The fixed line for `cannot_help` when Milo was named or held; null: silence. */
  cannotHelp(call: PolicyCall, role: string): string | null;
  /** The call's state for Decide (the round, the current question): a short string, or ''. */
  context(call: PolicyCall, person: TurnPerson): Promise<string>;
  /** May this role hold Milo's floor with the hold button. */
  mayHold(call: PolicyCall, role: string): boolean;
  /** Log a line before it is posted or said; returns the row id. A throw means it is neither posted nor said. */
  logSpoken(call: PolicyCall, line: SpokenLine): Promise<string | null>;
  /** How a logged line ended (row id from `logSpoken`, or from a server tool's own log when it returns one). Absent: not recorded. */
  markSpoken?(call: PolicyCall, rowId: string | null, line: SpokenLine, outcome: SpokenOutcome): Promise<void>;
  /** The money for saying one line: a release to call after, or null (refused: the line goes to the chat only). Absent: no hold. */
  holdSpeech?(call: PolicyCall, line: SpokenLine): Promise<{ release: () => Promise<void> } | null>;
  /** May this role use this core tool. Absent: stay_silent, cannot_help, keep_listening and cancel for everyone; pause and leave too. */
  mayUseCore?(call: PolicyCall, role: string, tool: CoreToolName): boolean;
}

/** The longest tenant instructions Decide sends. */
export const TENANT_INSTRUCTIONS_MAX = 600;
