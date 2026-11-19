// Hands-free Milo, lane D: what the routes do with a call's run (types.ts `HandsfreeRun`), shared by the staff routes
// (routes/meeting-assistant.ts) and the candidate's (routes/interview-invite-milo.ts). Each caller does its own auth first.
//
//   floorOf   who is talking to Milo now ("Hugo is talking to Milo", the tile ring), for every viewer of the call. Only a held floor
//             (routing, answering) is shown; the follow-up window is the asker's courtesy, not a hold.
//   holdAction  the hold button's press / release / cancel, as the person the route authenticated.
//   mayHold   whether this person sees the button: the same admission the run asks at a press (a candidate without pad help gets
//             fixed lines, so no button).
import { createHandsfreeRules } from './rules.js';
import type { HandsfreeRules, HandsfreeRun } from './types.js';
import type { PolicyCall } from '../policy.js';

export interface FloorView {
  /** The call runs hands-free now (the bar shows the hold button and polls the floor). */
  handsfree: boolean;
  floor: { userId: string; name: string; via: 'name' | 'follow-up' | 'hold'; phase: 'routing' | 'answering' } | null;
}
export type HoldAction = 'press' | 'release' | 'cancel';
export const HOLD_ACTIONS: readonly HoldAction[] = ['press', 'release', 'cancel'];

type NameOf = (userId: string) => Promise<string>;

export async function floorOf(run: HandsfreeRun | null, nameOf: NameOf): Promise<FloorView> {
  if (!run) return { handsfree: false, floor: null };
  const s = run.state();
  if (s.phase !== 'routing' && s.phase !== 'answering') return { handsfree: true, floor: null };
  const name = await nameOf(s.userId).catch(() => '');
  return { handsfree: true, floor: { userId: s.userId, name: name && name !== s.userId ? name : s.userId.startsWith('guest:') ? 'The candidate' : 'Someone', via: s.via, phase: s.phase } };
}

const REFUSED = {
  busy: { status: 409, code: 'BUSY', error: 'Someone else is talking to Milo. Try again when they finish.' },
  'already-holding': { status: 409, code: 'ALREADY_HOLDING', error: 'You are already talking to Milo.' },
  'not-admitted': { status: 403, code: 'NOT_ADMITTED', error: 'Milo cannot take a request from you in this call.' },
  'not-running': { status: 409, code: 'NOT_HANDSFREE', error: 'Milo is not listening hands-free in this call.' },
} as const;

export async function holdAction(run: HandsfreeRun | null, userId: string, action: HoldAction, nameOf: NameOf): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!run) { const r = REFUSED['not-running']; return { status: r.status, body: { code: r.code, error: r.error } }; }
  if (action === 'release') run.holdRelease(userId);
  if (action === 'cancel') run.holdCancel(userId);
  if (action !== 'press') return { status: 200, body: { holding: false, ...(await floorOf(run, nameOf)) } };
  const out = await run.holdPress(userId);
  if (out.ok) return { status: 200, body: { holding: true, ...(await floorOf(run, nameOf)) } };
  const r = REFUSED[out.reason];
  return { status: r.status, body: { code: r.code, error: r.error, ...(await floorOf(run, nameOf)) } };
}

let shared: HandsfreeRules | null = null;
export async function mayHold(run: HandsfreeRun | null, call: PolicyCall, userId: string, rules?: HandsfreeRules): Promise<boolean> {
  if (!run) return false;
  try { return (await (rules ?? (shared ??= createHandsfreeRules())).admit(call, userId)) === 'route'; } catch { return false; }
}
