// Store for the terminal dock — the herd of shells that floats above the app.
//
// Lives outside the router so terminals survive navigation. That is the whole
// point: you open a shell, keep working, switch pages, and the shell is still
// there with its socket attached and its scrollback intact. Rendering
// terminals inside a page would unmount them on every route change; the shell
// itself would survive server-side (that is what shellId is for), but you
// would pay a reconnect and lose the local buffer every time you clicked a
// link.
//
// Follows the house pattern — useSyncExternalStore, no state library — the
// same as toastStore and canaryStore.

export type DockMode = 'hidden' | 'docked' | 'floating';

export interface DockShell {
  /** Stable per-tab id; also the AgentCore shellId, so reattach works. */
  id: string;
  sessionId: string;
  /** Box label for the tab, e.g. devbox-1. */
  label: string;
}

export interface DockGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Height of the docked panel; kept separate from the floating window's. */
  dockHeight: number;
}

interface DockState {
  mode: DockMode;
  shells: DockShell[];
  activeId: string | null;
  geometry: DockGeometry;
}

const STORAGE_KEY = 'orgiq.terminalDock.v1';

const DEFAULT_GEOMETRY: DockGeometry = {
  x: 120, y: 120, width: 860, height: 480, dockHeight: 360,
};

function initial(): DockState {
  const base: DockState = { mode: 'hidden', shells: [], activeId: null, geometry: DEFAULT_GEOMETRY };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<DockState>;
    return {
      // Never restore as visible: a terminal springing open on load, before
      // anyone asked for one, is startling and costs a shell slot.
      mode: 'hidden',
      shells: Array.isArray(saved.shells) ? saved.shells.slice(0, MAX_SHELLS) : [],
      activeId: saved.activeId ?? null,
      geometry: { ...DEFAULT_GEOMETRY, ...(saved.geometry ?? {}) },
    };
  } catch {
    return base;
  }
}

/** AgentCore allows 10 concurrent shells per runtime; stop short of the wall. */
export const MAX_SHELLS = 8;

let state: DockState = initial();
const listeners = new Set<() => void>();

function emit(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      shells: state.shells, activeId: state.activeId, geometry: state.geometry,
    }));
  } catch { /* private mode, quota — the dock still works, it just forgets */ }
  for (const l of listeners) l();
}

function set(patch: Partial<DockState>): void {
  state = { ...state, ...patch };
  emit();
}

export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDock(): DockState {
  return state;
}

/**
 * Open a shell for a box, or focus it if one is already open.
 *
 * Reusing the existing tab rather than stacking duplicates matters: each tab
 * is a real PTY against a quota of ten, and two tabs on one shellId would
 * fight — the second connection kicks the first with close code 4000.
 */
export function openShell(box: { sessionId: string; label: string; id: string }): string {
  const existing = state.shells.find((s) => s.sessionId === box.sessionId);
  if (existing) {
    set({ activeId: existing.id, mode: state.mode === 'hidden' ? 'docked' : state.mode });
    return existing.id;
  }
  if (state.shells.length >= MAX_SHELLS) {
    // Refuse rather than let the service reject the upgrade with an opaque
    // close code the operator cannot interpret.
    set({ mode: state.mode === 'hidden' ? 'docked' : state.mode });
    return state.activeId ?? '';
  }
  const shell: DockShell = {
    id: `portal-${box.id}-${Date.now().toString(36)}`,
    sessionId: box.sessionId,
    label: box.label,
  };
  set({
    shells: [...state.shells, shell],
    activeId: shell.id,
    mode: state.mode === 'hidden' ? 'docked' : state.mode,
  });
  return shell.id;
}

export function closeShell(id: string): void {
  const remaining = state.shells.filter((s) => s.id !== id);
  set({
    shells: remaining,
    activeId: state.activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : state.activeId,
    mode: remaining.length === 0 ? 'hidden' : state.mode,
  });
}

export function focusShell(id: string): void {
  set({ activeId: id });
}

/** Cycle tabs, tmux-style. `delta` of 1 is next, -1 is previous. */
export function cycleShell(delta: number): void {
  if (state.shells.length < 2) return;
  const i = state.shells.findIndex((s) => s.id === state.activeId);
  const next = state.shells[(i + delta + state.shells.length) % state.shells.length];
  if (next) set({ activeId: next.id });
}

export function selectShellByIndex(index: number): void {
  const shell = state.shells[index];
  if (shell) set({ activeId: shell.id });
}

export function setMode(mode: DockMode): void {
  set({ mode });
}

/** Show/hide without discarding the shells — the sockets stay attached. */
export function toggleDock(): void {
  if (state.mode === 'hidden') {
    set({ mode: state.shells.length ? 'docked' : 'docked' });
  } else {
    set({ mode: 'hidden' });
  }
}

export function toggleFloating(): void {
  set({ mode: state.mode === 'floating' ? 'docked' : 'floating' });
}

export function setGeometry(patch: Partial<DockGeometry>): void {
  set({ geometry: { ...state.geometry, ...patch } });
}
