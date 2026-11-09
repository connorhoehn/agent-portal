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

/** A turn as the dock's inline strip takes it (the controller's VoiceTurnView). */
export interface DockTurn { id: string; role: 'you' | 'assistant'; text: string; at: number | string; toolCalls?: Array<{ name: string; status: 'running' | 'done' | 'refused' | 'failed'; summary: string }> }

/**
 * The dock's transcript controls (G26, ui-components 2.510.6): CC flips
 * `transcriptOpen`, and the dock renders the strip inline in a row above its
 * own (never a popover or a dialog), at the footer scale; the strip's extras
 * row carries the keep switch and, where the log exists, the history control.
 */
export function dockTranscriptProps(i: {
  open: boolean; toggle(): void; turns: readonly DockTurn[]; keep: boolean; setKeep(on: boolean): void; openLog?: (() => void) | null;
}) {
  return {
    transcriptOpen: i.open,
    onToggleTranscript: i.toggle,
    turns: i.turns as DockTurn[],
    keepTranscript: i.keep,
    onKeepTranscriptChange: i.setKeep,
    ...(i.openLog ? { onOpenLog: i.openLog } : {}),
  };
}

/** Where the history control goes: the session last minted, else the log's latest. */
export function voiceLogHref(sessionId: string | null, paths: { list: string; session(id: string): string }): string {
  return sessionId ? paths.session(sessionId) : paths.list;
}
