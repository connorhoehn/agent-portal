// Hands-free Milo's floor in the browser (middleware handsfree/surface.ts): the hold button's words, a refusal in words, and the
// ring on the tile of whoever has Milo's ear. Pure, so node:test reads it. The floor itself is pushed (lib/miloFloor.ts:
// realtime-modules `useAssistantFloor`); the bar is the library's `AssistantBar`.

/** The hold button's own limit (the run caps a hold at 30 s too, types.ts HANDSFREE.holdMaxMs). */
export const HOLD_MAX_MS = 30_000;
export const HOLD_LABEL = 'Hold to talk to Milo';
export const HOLD_TALKING_LABEL = 'Talking to Milo, release to send';
/** The words on the tile ring of whoever has Milo's ear, read by screen readers and shown as the tile's tooltip. */
export const FLOOR_TILE_LABEL = 'Talking to Milo';

/** The call's chat channel, where Milo's voice and the floor frames ride (middleware meeting-assistant/voice.ts `voiceChannel`). */
export const miloChannel = (callId: string): string => `orgiq:huddle:${callId}`;

/** The tile ring for the floor's holder (or routed person), for every viewer; undefined with nobody on the floor. */
export function floorHighlightFor(floor: { userId: string } | null | undefined): ((userId: string) => { label: string } | undefined) | undefined {
  if (!floor) return undefined;
  const holder = floor.userId;
  return (userId) => (userId === holder ? { label: FLOOR_TILE_LABEL } : undefined);
}

/** A refused press, in words for the person (the server's sentence when it sent one). */
export function holdRefusalWords(status: number, body: unknown): string {
  const error = body && typeof body === 'object' ? (body as Record<string, unknown>)['error'] : null;
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 200);
  return status === 409 ? 'Someone else is talking to Milo. Try again when they finish.' : 'Milo could not take that just now.';
}
