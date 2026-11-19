// Where an interview room's call is drawn, per viewer: docked in the Call side pane (larger tiles), floating in the
// bottom-right gallery, or minimised to a pill. Each state's own header offers the other two; the pill restores to
// floating. The call's media has exactly one holder in every state: the pane's or the gallery's `CallBlock` claims the
// call's one media sink (the library portals the dock, and its tiles' media elements, into it); minimised, nothing
// claims it and the shell's mounted, hidden `CallMediaOutlet` holds it, so the remote voices keep playing.
export type RoomCallMode = 'docked' | 'floating' | 'minimised';

export const ROOM_CALL_MODES: readonly RoomCallMode[] = ['docked', 'floating', 'minimised'];

/** Who holds the call's media in a state: the pane's block, the gallery's block, or the shell's hidden outlet. */
export type RoomCallSink = 'pane' | 'gallery' | 'outlet';

export function roomCallSink(mode: RoomCallMode): RoomCallSink {
  return mode === 'docked' ? 'pane' : mode === 'floating' ? 'gallery' : 'outlet';
}

/** The page's `CallBlock` claims for a state (the outlet holds the media when there are none). */
export function roomCallClaims(mode: RoomCallMode): number {
  return roomCallSink(mode) === 'outlet' ? 0 : 1;
}

/** The actions a state's own header offers, in order: the label is the button's accessible name. */
export function roomCallActions(mode: RoomCallMode): readonly { to: RoomCallMode; label: string }[] {
  if (mode === 'docked') return [{ to: 'floating', label: 'Float the call' }, { to: 'minimised', label: 'Minimise' }];
  if (mode === 'floating') return [{ to: 'docked', label: 'Dock the call' }, { to: 'minimised', label: 'Minimise' }];
  return [{ to: 'floating', label: 'Show the call' }];
}

/** A stored choice, or the fallback for anything else (nothing stored, an older value, a blocked store). */
export function parseRoomCallMode(stored: string | null | undefined, fallback: RoomCallMode): RoomCallMode {
  return (ROOM_CALL_MODES as readonly string[]).includes(stored ?? '') ? stored as RoomCallMode : fallback;
}

export function readRoomCallMode(key: string, fallback: RoomCallMode): RoomCallMode {
  try { return parseRoomCallMode(window.localStorage.getItem(key), fallback); } catch { return fallback; }
}

export function writeRoomCallMode(key: string, mode: RoomCallMode): void {
  try { window.localStorage.setItem(key, mode); } catch { /* a blocked store forgets */ }
}
