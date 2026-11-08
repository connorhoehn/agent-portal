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
import { refusalCode, type RefusalCode } from './sessionEvents.ts';

/** The closing clause of every `next`. */
export const NO_REPEAT = 'Do not repeat this call with the same arguments.';
/** The output of the second identical refused call. */
export const STOP_NEXT = 'Stop: this exact call was already refused in this session. Do not call it again. Tell the user in one sentence what was refused and why, and offer the fix.';
/** Refusals that never make a repeat terminal. */
const NOT_COUNTED: ReadonlySet<RefusalCode> = new Set(['card-open']);
/** At most this many allowed values are named (open's pages can run to sixty). */
const MAX_NAMED = 30;

type Ctx = { tenant: string; role?: string };

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
  if (refTool && (code === 'not-found' || code === 'other' || code === 'invalid-arguments') && /\bref\b|\brow\b|result|found no|records are not read/i.test(reason)) {
    return `${REF_SHAPE} To find one, list or search that kind first.${allowedClause('list', ctx)} ${NO_REPEAT}`;
  }
  if (offersAccess && (code === 'role' || code === 'no-grant' || code === 'other')) {
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
    case 'read-failed':
      fix = 'The read failed: tell the user, and offer to open the page instead.';
      break;
    case 'unknown-tool':
      fix = `Use one of the functions you are given (${named(VOICE_TOOLS.filter((t) => t.tenants.includes(ctx.tenant)).map((t) => t.name))}).`;
      break;
    case 'not-in-workspace':
      fix = 'That is not offered in this workspace: say so, and offer the nearest page.';
      break;
    default:
      fix = 'Tell the user what was refused and why, and offer the fix the reason names.';
  }
  if (tool === 'open' && code !== 'unknown-tool' && output['page'] != null && !navigatePageIds(ctx.tenant, ctx.role).includes(String(output['page']))) {
    fix += ` The pages here: ${named(navigatePageIds(ctx.tenant, ctx.role))}.`;
  }
  return `${fix} ${NO_REPEAT}`;
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

/** The line the dock speaks for a terminal repeat: the runner's own reason (user-facing, never a row it could not read). */
export function refusalLine(output: Record<string, unknown>): string {
  const reason = typeof output['reason'] === 'string' && output['reason'].trim() ? output['reason'].trim() : 'I could not do that.';
  return reason.length > 240 ? `${reason.slice(0, 239)}…` : reason;
}

