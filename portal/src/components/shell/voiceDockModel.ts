// The voice dock's footer rules, pure so `node --test` checks them
// (docs/voice-navigator-spec.md §5, §8):
//   - the dock renders only with the `voiceNavigator` flag on AND
//     can('VoiceNavigate') settled true; otherwise the footer is exactly what
//     it was before the dock existed (nothing mounted, no hook run);
//   - Ctrl+Shift+Space toggles the session, never while typing into a field
//     with a modifier-less Space (the chord needs both modifiers anyway).

export interface VoiceDockGate {
  flag: boolean;
  /** The capability probe settled. */
  ready: boolean;
  allowed: boolean;
  /** A session exists (the shell is signed in). */
  signedIn: boolean;
}

export function voiceDockVisible(g: VoiceDockGate): boolean {
  return g.flag && g.signedIn && g.ready && g.allowed;
}

/** Ctrl+Shift+Space (§5), registered beside the palette's ⌘K. */
export function isVoiceHotkey(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code?: string; key?: string }): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'Space' || e.key === ' ');
}

/** The silent context the voice gets when the user moves by hand (§1 "P3 context"). */
export function pageContextNote(pathname: string): string {
  return `The user is now on the portal page ${pathname}.`;
}
