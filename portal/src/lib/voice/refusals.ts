// What a refusal tells the model to change, and the retry guard
// (docs/voice-navigator-gaps.md G29).
//
// The 23:03 session (vs_a215e96c) refused `message` three times in 17 s and
// `get` four times in 14 s with what looked like the same intent: a refusal
// that only says "refused" leaves the delegation guessing, and it guesses the
// same call again. So:
//
// 1. Every refused output carries `next`: one sentence that names what to
//    change, by refusal code (sessionEvents.ts refusalCode) and tool: the
//    allowed kinds, scopes or types of this workspace, "a ref is kind:id",
//    "ask for access", "name one person", always ending with the rule that
//    the same call is not repeated. It is built from the code, the tool's
//    schema and the tenant's enums only, never from a row, so it can never
//    name a record the persona could not read (the G14 / V2-14 property).
// 2. The voice's and the delegation's instructions say the same (catalogue
//    voiceInstructions / delegationInstructions).
// 3. The controller keeps the calls refused in this session by tool and
//    canonical arguments (`callKey`, the arguments' hash input); the second
//    identical refused call is terminal: its output says stop, the dock asks
//    for no continuation, and it speaks the refusal line itself, once.
//    `card-open` never counts (the card answering is not the model's fault).

import {
  activityScopes, budgetScopes, createKinds, getParts, listKinds, navigatePageIds, openKinds, queueWorkKinds, searchRecordTypes, summaryKinds,
  updateKinds, decideKinds, VOICE_TOOLS,
} from './catalogue.ts';
import { failureCode, gateOf, refusalCode, MONEY_GATES, type RefusalCode } from './sessionEvents.ts';

/** The closing clause of every `next`. */
export const NO_REPEAT = 'Do not repeat this call with the same arguments.';
/** The output of the second identical refused call. */
export const STOP_NEXT = 'Stop: this exact call was already refused in this session. Do not call it again. Tell the user in one sentence what was refused and why, and offer the fix.';
/** Refusals that never make a repeat terminal. */
const NOT_COUNTED: ReadonlySet<RefusalCode> = new Set(['card-open']);
/** At most this many allowed values are named (open's pages can run to sixty). */
const MAX_NAMED = 30;

type Ctx = { tenant: string; role?: string };

/** The access-catalog item a refusal names (`requestItemId`, or its hint's `item`), else null. */
export function requestItemOf(output: Record<string, unknown>): string | null {
  if (typeof output['requestItemId'] === 'string' && output['requestItemId']) return output['requestItemId'];
  const hint = output['hint'];
  const item = hint && typeof hint === 'object' ? (hint as Record<string, unknown>)['item'] : null;
  return typeof item === 'string' && item ? item : null;
}

/** G27: what the model does with a refusal that names a request it can file. */
export function fileRequestNext(item: string): string {
  return `The user lacks the access this needs. Say in one sentence what is missing and offer to file the access request. If they say yes, call create with kind "access-request" and fields { item: "${item}", justification: their reason in their own words }; say the request id it returns, and offer to try the original request again once the approval comes in (the portal tells you when a notification arrives). ${NO_REPEAT}`;
}

/** The enum a tool's main argument takes in this workspace: [the argument's words, the values]. */
function allowed(tool: string, ctx: Ctx): [string, string[]] | null {
  const t = ctx.tenant;
  switch (tool) {
    case 'list': return ['kinds', listKinds(t)];
    case 'get': return ['parts', getParts(t)];
    case 'summary': return ['kinds', summaryKinds(t)];
    case 'search': return ['types', searchRecordTypes(t)];
    case 'budget': return ['scopes', budgetScopes(t)];
    case 'activity': return ['scopes', activityScopes(t)];
    case 'open': return ['kinds', openKinds(t)];
    case 'queue_work': return ['kinds', queueWorkKinds(t)];
    case 'create': return ['kinds', createKinds(t)];
    case 'update': return ['ref kinds', updateKinds(t)];
    case 'decide': return ['ref kinds', decideKinds(t)];
    default: return null;
  }
}

function named(values: readonly string[]): string {
  const shown = values.slice(0, MAX_NAMED);
  return `${shown.join(', ')}${values.length > shown.length ? ` and ${values.length - shown.length} more` : ''}`;
}

function allowedClause(tool: string, ctx: Ctx): string {
  const a = allowed(tool, ctx);
  if (!a || !a[1].length) return '';
  return ` The ${a[0]} here: ${named(a[1])}.`;
}

/** A ref the runner could not use: say its shape. */
const REF_SHAPE = 'A ref is kind:id exactly as a result gave it (for example "initiative:p-12"), or a row\'s position in the last result ("2"); never a name or a path.';

/**
 * The sentence that tells the model what to change, for a refused `tool`
 * call with this output. Pure: the code, the tool and the workspace's enums.
 */
export function refusalNext(tool: string, output: Record<string, unknown>, ctx: Ctx): string {
  const code = refusalCode(output);
  const reason = typeof output['reason'] === 'string' ? output['reason'] : '';
  const offersAccess = output['hint'] != null || output['offer'] != null || output['requestItemId'] != null;
  const people = tool === 'message' || tool === 'call';
  const refTool = tool === 'get' || tool === 'open' || tool === 'decide' || tool === 'update';
  let fix: string;
  if (code === 'invalid-ref' || code === 'not-read-yet') {
    return `${REF_SHAPE} ${code === 'not-read-yet' ? 'Nothing in this session read it yet: ' : ''}To find one, list or search that kind first.${allowedClause('list', ctx)} ${NO_REPEAT}`;
  }
  if (refTool && (code === 'not-found' || code === 'other' || code === 'invalid-arguments') && /\bref\b|\brow\b|result|found no [a-z-]+ "[^"]*" that you can read|records are not read/i.test(reason)) {
    return `${REF_SHAPE} To find one, list or search that kind first.${allowedClause('list', ctx)} ${NO_REPEAT}`;
  }
  if (offersAccess && (code === 'role' || code === 'no-grant' || code === 'other')) {
    // G27: where create files an access request, the refusal's item is a turn of its own: offer, file on yes, retry once approved.
    const item = requestItemOf(output);
    if (item && createKinds(ctx.tenant).includes('access-request')) return fileRequestNext(item);
    return `The user lacks the access this needs: tell them, and offer to ask for access with the request this result names. ${NO_REPEAT}`;
  }
  switch (code) {
    case 'ambiguous':
      fix = people
        ? 'Several match: read them to the user and ask which one person, team or channel they mean; then call again naming that one.'
        : 'Read the numbered matches to the user and ask which one; then call again with that one\'s ref or position.';
      break;
    case 'not-found':
      if (people) fix = 'Name one person, team or channel exactly as the user said it; if the user meant several, ask which one.';
      else fix = `Use what this workspace has, or list or search first and use a row's ref.${allowedClause(tool, ctx)}`;
      break;
    case 'invalid-arguments': {
      const prop = /"?([a-zA-Z_]+)"?/.exec(reason.replace(/^I could not use those details:\s*/i, ''))?.[1];
      fix = `Change the arguments the reason names${prop ? ` (${prop})` : ''} and pass null for anything the user did not say.${allowedClause(tool, ctx)}${tool === 'get' || tool === 'open' ? ` ${REF_SHAPE}` : ''}`;
      break;
    }
    case 'role':
    case 'no-grant':
      fix = offersAccess
        ? 'The user lacks the access this needs: tell them, and offer to ask for access with the request this result names.'
        : 'The user\'s role cannot do this: tell them, and offer to ask for access or to open the nearest page they can use.';
      break;
    case 'budget':
      fix = 'A budget or spend limit refused it: tell the user which, and offer the page that shows it; do not try it another way.';
      break;
    case 'allowlist':
      fix = 'That command is not one the dock may run: offer to open a shell on the computer (computer, action open-shell) so the user can type it.';
      break;
    case 'not-on-this-page':
      fix = 'The page in view does not show it: drop scope "this-page" and list or search that kind instead, or open its page first.';
      break;
    case 'other-workspace':
      fix = 'It belongs to another workspace: offer to open the workspaces page, and say that switching ends this voice session.';
      break;
    case 'card-open':
      fix = 'A card is waiting for the user: wait until they confirm or cancel it, then ask again.';
      break;
    case 'unavailable':
      fix = 'It cannot be reached right now: tell the user, and try again only when they ask.';
      break;
    case 'not-connected':
      fix = 'Social is not connected right now, so nothing was sent and no card was shown: tell the user in one sentence, and try again only when they ask.';
      break;
    case 'not-a-member':
      fix = 'The user is not a member of that channel: say so, and offer to join it with the update this result names; post only after the join is done.';
      break;
    case 'read-failed':
      fix = 'The read failed: tell the user, and offer to open the page instead.';
      break;
    case 'unknown-tool':
      fix = `Use one of the functions you are given (${named(VOICE_TOOLS.filter((t) => t.tenants.includes(ctx.tenant)).map((t) => t.name))}).`;
      break;
    case 'not-in-workspace':
      fix = 'That is not offered in this workspace: say so, and offer the nearest page.';
      break;
    case 'navigated':
      fix = 'This request already opened a page: say the one line about it and stop; the user asks for the next page themselves.';
      break;
    case 'repeat-failed':
      fix = 'That call already failed: tell the user why in one sentence; call it again only when they ask in a new request, at most once.';
      break;
    case 'too-many-calls':
      fix = 'This request used its calls: stop, and answer the user in one sentence with what you have, or ask them to say what they want in one sentence.';
      break;
    default:
      fix = 'Tell the user what was refused and why, and offer the fix the reason names.';
  }
  if (tool === 'open' && code !== 'unknown-tool' && output['page'] != null && !navigatePageIds(ctx.tenant, ctx.role).includes(String(output['page']))) {
    fix += ` The pages here: ${named(navigatePageIds(ctx.tenant, ctx.role))}.`;
  }
  return `${fix} ${NO_REPEAT}`;
}

/** Who did not happen, per tool (G47), for the `say` line; queue_work names its kind. */
const FAILURE_SUBJECT: Readonly<Record<string, string>> = {
  message: 'The message', call: 'The call', decide: 'The decision', create: 'It', update: 'The change',
  computer: 'The computer action', set_status: 'The status', queue_work: 'The work',
};
const WORK_SUBJECT: Readonly<Record<string, string>> = {
  dispatch: 'Dispatch', sweep: 'The sweep', 'bot-run': 'The bot run', pipeline: 'The dry-run', deck: 'The deck', summarize: 'The summary', draft: 'The draft',
};
/** How a brake is said: the money gates as "the budget gate", the rest by their own name. */
const GATE_WORDS: Readonly<Record<string, string>> = {
  'run-budget': 'budget gate (the per-run cap)', 'user-budget': 'budget gate (your monthly budget)', allocation: 'budget gate (the initiative\'s allocation)',
  envelope: 'budget gate (the sprint envelope)', 'spend-hold': 'spend hold', 'budget-state': 'budget gate (the budget could not be read)',
  'run-limit': 'run limit', paused: 'pause on this spend',
};

/**
 * G47: the one line the voice says for a failed call (or a route's brake), from its code and gate: "Dispatch was
 * refused by the budget gate (the per-run cap).", "The message receipt never came." Never the server's own words.
 */
export function failureSay(tool: string, output: Record<string, unknown>): string {
  const kind = typeof output['workKind'] === 'string' ? output['workKind'] : '';
  const who = (tool === 'queue_work' && WORK_SUBJECT[kind]) || FAILURE_SUBJECT[tool] || 'It';
  const gate = gateOf(output);
  if (gate) return `${who} was refused by the ${GATE_WORDS[gate] ?? `${gate.replace(/[-_]/g, ' ')} gate`}${MONEY_GATES.has(gate) ? '; its page can take it over the limit' : ''}.`;
  const code = failureCode(output);
  switch (code) {
    case 'not-connected': return tool === 'message' || tool === 'call' ? 'Social isn\'t connected right now, so nothing was sent.' : `${who} did not go through: the server could not be reached.`;
    case 'not-a-member': return 'You\'re not a member of that channel, so nothing was posted.';
    case 'receipt-timeout': return `${tool === 'message' ? 'The message' : who} receipt never came; check the conversation before trying again.`;
    case 'timeout': return `${who} did not answer in time.`;
    case 'rejected': return `${who} was rejected.`;
    default: {
      const status = Number(code.slice(5));
      return status >= 500 ? `${who} failed: the server had an error (HTTP ${status}).` : `${who} was refused by the server (HTTP ${status}).`;
    }
  }
}

/** G47: a failed result (and a route's brake) carries its code, its gate and the line to say, unless the runner wrote one. */
export function withFailure<T extends { outcome: string; output: Record<string, unknown> }>(res: T, tool: string): T {
  const gate = gateOf(res.output);
  if (res.outcome !== 'failed' && !(res.outcome === 'refused' && gate)) return res;
  const output = { ...res.output, code: failureCode(res.output), ...(typeof res.output['say'] === 'string' ? {} : { say: failureSay(tool, res.output) }) };
  return { ...res, output };
}

/** The result's output with `next` (kept when the runner already wrote one). */
export function withNext<T extends { outcome: string; output: Record<string, unknown> }>(res: T, tool: string, ctx: Ctx): T {
  if (res.outcome !== 'refused' || typeof res.output['next'] === 'string') return res;
  return { ...res, output: { ...res.output, next: refusalNext(tool, res.output, ctx) } };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] != null).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The identity of a call for the retry guard: the tool and its arguments as
 * canonical JSON with nulls dropped (the strict schema's "not given"), so a
 * raw string and the prepared arguments of the same call agree.
 */
export function callKey(tool: string, args: unknown): string {
  let a: unknown = args;
  if (typeof args === 'string') { try { a = JSON.parse(args); } catch { a = args; } }
  return `${tool}:${canonical(a)}`;
}

/** What the guard says about one refused call. */
export interface RefusalVerdict {
  /** This exact call was refused before in this session: answer it with STOP_NEXT and continue nothing. */
  terminal: boolean;
  /** The dock should speak the refusal line now (the first terminal verdict for this call only). */
  speak: boolean;
}

/** The calls refused in one session (G29): the second identical refused call is terminal. */
export class RefusalGuard {
  private seen = new Map<string, { count: number; spoken: boolean }>();

  /** Record a refused call; the verdict says whether it is a repeat. */
  refused(tool: string, args: unknown, output: Record<string, unknown>): RefusalVerdict {
    if (NOT_COUNTED.has(refusalCode(output))) return { terminal: false, speak: false };
    const key = callKey(tool, args);
    const entry = this.seen.get(key) ?? { count: 0, spoken: false };
    entry.count += 1;
    this.seen.set(key, entry);
    if (entry.count < 2) return { terminal: false, speak: false };
    const speak = !entry.spoken;
    entry.spoken = true;
    return { terminal: true, speak };
  }

  reset(): void { this.seen.clear(); }
}

/**
 * G48: a failed call may be retried once, with the same arguments, when the user asks ("try again"). The repeat
 * guard above counts refusals only; this one counts failures. A retry in the same user turn (the model trying again
 * on its own) is refused, so is a third try after two failures; a new turn's first retry runs.
 */
export const RETRY_NEXT = 'Tell the user in one sentence why it failed (the say line). If they ask to try again, call it once more with the same arguments; never retry on your own.';
export const FAILED_TWICE_NEXT = 'It failed twice: tell the user why in one sentence, and do not try it again in this session.';

export class FailureGuard {
  private seen = new Map<string, { count: number; turn: unknown }>();

  /** Before a call runs: null to let it run, else why not (`repeat-failed`). `turn` is the user turn it was asked in. */
  check(tool: string, args: unknown, turn: unknown): { reason: string; code: 'repeat-failed' } | null {
    const entry = this.seen.get(callKey(tool, args));
    if (!entry) return null;
    if (entry.count >= 2) return { reason: 'That failed twice in this session, so I will not try it a third time.', code: 'repeat-failed' };
    if (entry.turn === turn) return { reason: 'That just failed. Tell the user why; try again only when they ask.', code: 'repeat-failed' };
    return null;
  }

  /** A call failed: whether this was its last allowed try. */
  failed(tool: string, args: unknown, turn: unknown): { last: boolean } {
    const key = callKey(tool, args);
    const entry = this.seen.get(key) ?? { count: 0, turn };
    entry.count += 1;
    entry.turn = turn;
    this.seen.set(key, entry);
    return { last: entry.count >= 2 };
  }

  /** Whether this exact call has failed and not landed since (so a run of it now is a retry). */
  has(tool: string, args: unknown): boolean { return this.seen.has(callKey(tool, args)); }

  /** It landed: a later failure of the same call starts again. */
  succeeded(tool: string, args: unknown): void { this.seen.delete(callKey(tool, args)); }

  reset(): void { this.seen.clear(); }
}

/** The line the dock speaks for a terminal repeat: the runner's own reason (user-facing, never a row it could not read). */
export function refusalLine(output: Record<string, unknown>): string {
  const reason = typeof output['reason'] === 'string' && output['reason'].trim() ? output['reason'].trim() : 'I could not do that.';
  return reason.length > 240 ? `${reason.slice(0, 239)}…` : reason;
}

