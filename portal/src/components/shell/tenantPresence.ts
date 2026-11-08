// The tenant lobby's presence (`<tenant>:lobby`, manifest `presenceLobby`), as
// the shell's other surfaces read it. TenantLobby (TenantDirectMessages.tsx)
// owns the one announcement for a session without a Social grant and publishes
// here who it shows online; the voice dock reads it at call time (activity
// `online`), never through a second presence subscription. No React: a value
// and its listeners.

export interface TenantLobbyPerson { userId: string; name: string }

export interface TenantLobbyPresence {
  lobby: string;
  /** The people the footer counts online (the lobby's roster within the shared directory), the caller left out. */
  online: readonly TenantLobbyPerson[];
}

let current: TenantLobbyPresence | null = null;
const listeners = new Set<() => void>();

export const tenantLobbyPresence = {
  get: (): TenantLobbyPresence | null => current,
  set(next: TenantLobbyPresence | null): void {
    if (next === current) return;
    current = next;
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
