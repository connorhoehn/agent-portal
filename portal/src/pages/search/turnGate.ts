// One turn at a time on one transcript, and a `?prompt=` deep link asked once.
//
// useAgentStream (realtime-modules) appends every TEXT_MESSAGE_CONTENT delta to
// a single in-progress message and has no guard against a second sendMessage
// while the first is still streaming, so two runs on one transcript interleave
// word by word ("Here's anHere's an overview overview…").
// `isStreaming` cannot be that guard: it is React state, and two sends
// issued in one tick — an effect re-run, a double click — both read `false`.

export interface TurnGate {
  /** A token for the turn that may start now, or null while one is in flight. */
  tryBegin(): number | null;
  /** The turn holding `token` finished. A stale token (see `release`) is ignored. */
  end(token: number): void;
  /** The stream in flight was abandoned (new session, history load): free the gate now. */
  release(): void;
  busy(): boolean;
}

export function createTurnGate(): TurnGate {
  let current: number | null = null;
  let issued = 0;
  return {
    tryBegin() {
      if (current !== null) return null;
      issued += 1;
      current = issued;
      return current;
    },
    end(token) { if (current === token) current = null; },
    release() { current = null; },
    busy: () => current !== null,
  };
}

/**
 * Prompts already asked, keyed by the history entry that carried them. The
 * deep-link effect re-runs whenever its inputs settle (the org graph it reads
 * names from arrives a render later) and the router strips `?prompt=` in a
 * transition, so the effect can see the same param twice; a remount of the
 * page within one entry must not ask again either. In memory only: a reload
 * sees a URL the first ask already stripped, and a fresh navigation to the
 * same prompt is a new entry with a new key — a deliberate second ask.
 */
const asked = new Set<string>();

export function claimDeepLinkPrompt(entryKey: string, prompt: string | null, ledger: Set<string> = asked): boolean {
  if (!prompt) return false;
  const key = `${entryKey}\u0000${prompt}`;
  if (ledger.has(key)) return false;
  ledger.add(key);
  return true;
}
