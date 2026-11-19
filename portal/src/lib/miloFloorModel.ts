// Hands-free Milo's floor in the browser (middleware handsfree/surface.ts): who is talking to Milo now, and the hold button's words.
// Pure, so node:test reads it; the hook that polls it is lib/miloFloor.ts.

export interface MiloFloor { userId: string; name: string; via: 'name' | 'follow-up' | 'hold'; phase: 'routing' | 'answering' }
export interface MiloFloorView { handsfree: boolean; floor: MiloFloor | null; mayHold?: boolean }

/** While a call runs hands-free the floor is read this often: a turn lasts seconds, so the slower state poll would miss most of it. */
export const FLOOR_POLL_MS = 1000;
/** While it is not (yet) hands-free, the slower cadence of the state poll. */
export const IDLE_POLL_MS = 5000;
export const NO_FLOOR: MiloFloorView = Object.freeze({ handsfree: false, floor: null });
/** The hold button's own limit (the run caps a hold at 30 s too, types.ts HANDSFREE.holdMaxMs). */
export const HOLD_MAX_MS = 30_000;
export const HOLD_LABEL = 'Hold to talk to Milo';
export const HOLD_TALKING_LABEL = 'Talking to Milo, release to send';

const VIA = ['name', 'follow-up', 'hold'] as const;
const PHASE = ['routing', 'answering'] as const;

/** Reads one floor body (staff `/assistant/floor`, the candidate's `/milo/floor`, or a hold answer); anything odd is no floor. */
export function parseFloor(body: unknown): MiloFloorView {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const f = b['floor'] && typeof b['floor'] === 'object' ? b['floor'] as Record<string, unknown> : null;
  const via = VIA.find((v) => v === f?.['via']);
  const phase = PHASE.find((p) => p === f?.['phase']);
  const floor = f && typeof f['userId'] === 'string' && f['userId'] && typeof f['name'] === 'string' && f['name'].trim() && via && phase
    ? { userId: f['userId'], name: f['name'].trim().slice(0, 80), via, phase } : null;
  return { handsfree: b['handsfree'] === true, floor: b['handsfree'] === true ? floor : null, ...(typeof b['mayHold'] === 'boolean' ? { mayHold: b['mayHold'] } : {}) };
}

/** "Hugo is talking to Milo" for everyone else; "You are talking to Milo" for the person themself; null with nobody on the floor. */
export function floorWords(view: MiloFloorView, selfId: string | null): string | null {
  if (!view.floor) return null;
  return view.floor.userId === selfId ? 'You are talking to Milo' : `${view.floor.name} is talking to Milo`;
}

/** Someone else holds the floor: the button is busy (disabled, with the words beside it). */
export function busyLabel(view: MiloFloorView, selfId: string | null): { label: string } | undefined {
  const words = floorWords(view, selfId);
  return words && view.floor?.userId !== selfId ? { label: words } : undefined;
}

/** A refused press, in words for the person (the server's sentence when it sent one). */
export function holdRefusalWords(status: number, body: unknown): string {
  const error = body && typeof body === 'object' ? (body as Record<string, unknown>)['error'] : null;
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 200);
  return status === 409 ? 'Someone else is talking to Milo. Try again when they finish.' : 'Milo could not take that just now.';
}
