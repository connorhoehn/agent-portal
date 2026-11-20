// Act: run what Decide chose, as the person who asked (docs/milo-rebuild/REBUILD-PLAN.md section 1, REBUILD-REVIEW.md risks 2, 5, 8).
//
// The code, not the model, has the last word: the tool must be one Decide offered AND one the tenant still gives this person now;
// a free answer only for a role that answers freely; pause, leave and cancel only for a role the tenant lets use them. A writing tool
// runs only while its sentence is still the current turn (a new onset from the asker cancels it). Each sentence is acted on once,
// however often it is handed over (the idempotency key is the sentence id). `cannot_help` speaks the tenant's fixed line only when
// Milo was named or held; inside the follow-up window it is silence. Act returns the line; Speak logs and says it.
import { runServerTool, type ServerToolRun } from '../server-tools.js';
import type { PolicyCall } from '../policy.js';
import { trace } from '../trace.js';
import { coreToolsFor } from './decide.js';
import { isCoreTool, type CoreToolName, type Decision, type MiloAction, type TurnPolicy, type TurnSentence } from './types.js';

/** What the turn owner does besides speaking: wait for the rest of the sentence, stop listening, leave, or stop what Milo is doing. */
export type ActEffect = 'keep-listening' | 'pause' | 'leave' | 'cancel';

export interface ActResult {
  /** The tool acted on (`answer` for a free answer), or null when nothing ran. */
  tool: string | null;
  /** What Milo says, or null for silence. */
  line: string | null;
  /** The line is already in the tenant's log (a server tool's family log wrote it): Speak must not log it again. */
  logged: boolean;
  effect: ActEffect | null;
  /** What Milo did, for the next Decide's context; null when it did nothing. */
  action: MiloAction | null;
  /** Why nothing ran: the sentence was acted on already, its turn is no longer current, the person may not, or the tool kind is not served yet. */
  skipped?: 'repeat' | 'stale' | 'not-allowed' | 'no-role' | 'catalogue';
}

export interface ActInput {
  call: PolicyCall;
  policy: TurnPolicy;
  sentence: TurnSentence;
  decision: Decision;
  /** Still the current turn (no new onset from the asker since this sentence)? Absent: yes. */
  isCurrent?: () => boolean;
}

export interface ActDeps {
  runServer?: (call: PolicyCall, askedBy: string, name: string, args: unknown) => Promise<ServerToolRun | null>;
  now?: () => number;
}

const SEEN_MAX = 2000;
const seen = new Map<string, true>();
/** Tests: forget acted-on sentences. */
export function _resetActed(): void { seen.clear(); }
function firstTime(call: PolicyCall, sentenceId: string): boolean {
  const key = `${call.tenant}|${call.callId}|${sentenceId}`;
  if (seen.has(key)) return false;
  seen.set(key, true);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
  return true;
}

const EFFECT: Partial<Record<CoreToolName, ActEffect>> = { keep_listening: 'keep-listening', pause_listening: 'pause', leave_call: 'leave', cancel: 'cancel' };
const nothing = (skipped?: ActResult['skipped']): ActResult => ({ tool: null, line: null, logged: false, effect: null, action: null, ...(skipped ? { skipped } : {}) });

export async function act(input: ActInput, deps: ActDeps = {}): Promise<ActResult> {
  const { call, policy, sentence, decision } = input;
  const now = deps.now ?? Date.now;
  const note = (outcome: string, tool?: string | null): void => trace('turn.act', { outcome, tool: tool ?? null, via: sentence.via });
  if (decision.kind === 'none') { note('no-role'); return nothing('no-role'); }
  if (!firstTime(call, sentence.id)) { note('repeat'); return nothing('repeat'); }
  const role = decision.role;
  const named = sentence.via !== 'follow-up';
  const actionOf = (tool: string, args: Record<string, unknown>, line: string | null): MiloAction => ({ tool, args, line, askedBy: sentence.who, atMs: now() });

  const cannotHelp = (): ActResult => {
    const line = named ? policy.cannotHelp(call, role) : null;
    note(line ? 'cannot-help' : 'cannot-help-silent', 'cannot_help');
    return { tool: 'cannot_help', line, logged: false, effect: null, action: line ? actionOf('cannot_help', {}, line) : null };
  };

  if (decision.kind === 'answer') {
    if (!policy.answersFreely(call, role)) return cannotHelp();
    note('answer', 'answer');
    return { tool: 'answer', line: decision.text, logged: false, effect: null, action: actionOf('answer', {}, decision.text) };
  }

  const name = decision.tool;
  if (!decision.offered.includes(name)) return cannotHelp();
  if (isCoreTool(name)) {
    if (!coreToolsFor(policy, call, role).includes(name)) { note('not-allowed', name); return cannotHelp(); }
    if (name === 'stay_silent') { note('silent', name); return { tool: name, line: null, logged: false, effect: null, action: null }; }
    if (name === 'cannot_help') return cannotHelp();
    note('effect', name);
    return { tool: name, line: null, logged: false, effect: EFFECT[name]!, action: name === 'keep_listening' ? null : actionOf(name, {}, null) };
  }

  // A tenant tool: the tenant must still give it to this person now (the list Decide offered may be a moment old).
  const tools = await policy.toolsFor(call, { userId: sentence.who, role }).catch(() => []);
  const tool = tools.find((t) => t.name === name);
  if (!tool) { note('not-allowed', name); return cannotHelp(); }
  if (tool.writes && input.isCurrent && !input.isCurrent()) { note('stale', name); return nothing('stale'); }
  if (tool.kind !== 'server') { note('catalogue', name); return nothing('catalogue'); }
  const run = deps.runServer ?? ((c, who, n, a) => runServerTool(c, who, n, a, 'model', { heardOnce: true }));
  const out = await run(call, sentence.who, name, decision.args);
  note(out ? 'ran' : 'nothing', name);
  if (!out) return { tool: name, line: null, logged: false, effect: null, action: actionOf(name, decision.args, null) };
  return { tool: name, line: out.line, logged: true, effect: null, action: actionOf(name, decision.args, out.line) };
}
