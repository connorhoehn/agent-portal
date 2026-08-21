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

import { loadBoxes } from './devboxRegistry';
import { toastError } from './toastStore';

/**
 * Layouts, because "several terminals" means different things:
 *   docked   — one pane pinned to the bottom, tabbed. Working in one shell.
 *   floating — a draggable window parked over the page.
 *   grid     — every shell tiled and visible at once, tmux-style. Watching.
 *   stack    — a narrow column down the right, all visible, page still usable.
 */
export type DockMode = 'hidden' | 'docked' | 'floating' | 'grid' | 'stack';

/**
 * What a shell is doing, as far as the client can tell.
 *
 * The PTY does not announce "busy" — there is no such frame. This is inferred
 * from output timing, which is honest as long as it is labelled as activity
 * rather than as process state: a command that prints nothing looks idle, and
 * that is a limit worth knowing rather than papering over.
 */
export type ShellStatus = 'connecting' | 'ready' | 'busy' | 'detached' | 'error';

export interface DockShell {
  /** Stable per-tab id; also the AgentCore shellId, so reattach works. */
  id: string;
  sessionId: string;
  /**
   * Directory to start in.
   *
   * A PTY opens at `/`, which is right for a bare box and wrong when the shell
   * was opened from a specific codebase — landing at the filesystem root with
   * no git and no checkout in sight is a shell you have to orient yourself in
   * before you can use it.
   */
  cwd?: string;
  /** Computer label for the tab, e.g. computer-1. */
  label: string;
  status: ShellStatus;
  /** Output arrived while you were looking at a different tab. */
  unread: boolean;
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
      // Drop tabs whose box no longer exists. A restored tab pointing at a
      // deleted session can never connect — it would sit there failing, and
      // the operator has no way to tell it apart from a service problem.
      shells: (Array.isArray(saved.shells) ? saved.shells : [])
        .filter((s): s is DockShell => {
          if (!s || typeof s.sessionId !== 'string') return false;
          try { return loadBoxes().some((b) => b.sessionId === s.sessionId); } catch { return false; }
        })
        .map((s) => ({ ...s, status: 'connecting' as ShellStatus, unread: false }))
        .slice(0, MAX_SHELLS),
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
export function openShell(box: { sessionId: string; label: string; id: string; cwd?: string }): string {
  const existing = state.shells.find((s) => s.sessionId === box.sessionId);
  if (existing) {
    set({
      activeId: existing.id,
      mode: state.mode === 'hidden' ? 'docked' : state.mode,
      ...(box.cwd && box.cwd !== existing.cwd
        ? { shells: state.shells.map((s) => (s.id === existing.id ? { ...s, cwd: box.cwd } : s)) }
        : {}),
    });
    return existing.id;
  }
  if (state.shells.length >= MAX_SHELLS) {
    // Refuse rather than let the service reject the upgrade with an opaque
    // close code the operator cannot interpret — but say so. Silently doing
    // nothing when a button is pressed reads as a broken button.
    toastError(null, 'Too many terminals open',
      `${MAX_SHELLS} is the limit here (AgentCore allows 10 per runtime). Close one first.`);
    set({ mode: state.mode === 'hidden' ? 'docked' : state.mode });
    return state.activeId ?? '';
  }
  const shell: DockShell = {
    id: `portal-${box.id}-${Date.now().toString(36)}`,
    sessionId: box.sessionId,
    label: box.label,
    ...(box.cwd ? { cwd: box.cwd } : {}),
    status: 'connecting',
    unread: false,
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
  // Looking at a tab clears its unread marker — that is what unread means.
  set({
    activeId: id,
    shells: state.shells.map((s) => (s.id === id ? { ...s, unread: false } : s)),
  });
}

/**
 * Report what a shell is doing.
 *
 * `sawOutput` marks the tab unread when it is not the one being looked at, so
 * a grid or a stack shows which pane moved while your attention was elsewhere.
 */
export function reportShellStatus(id: string, status: ShellStatus, sawOutput = false): void {
  let changed = false;
  const shells = state.shells.map((s) => {
    if (s.id !== id) return s;
    const unread = sawOutput && state.activeId !== id ? true : s.unread;
    if (s.status === status && s.unread === unread) return s;
    changed = true;
    return { ...s, status, unread };
  });
  if (changed) set({ shells });
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

/**
 * Show/hide without discarding the shells — the sockets stay attached.
 *
 * With no shells open the dock renders nothing, so the hotkey used to look
 * broken. Opening one for the most recent box makes ⌘' always do something:
 * it is the "give me a terminal" key, not the "reveal a panel" key.
 */
export function toggleDock(): void {
  if (state.mode !== 'hidden') { set({ mode: 'hidden' }); return; }

  if (state.shells.length === 0) {
    const boxes = (() => { try { return loadBoxes(); } catch { return []; } })();
    const box = boxes[boxes.length - 1];
    if (!box) {
      toastError(null, 'No computer to attach to', 'Create one on the Computers page first.');
      return;
    }
    openShell({ id: box.id, label: box.label, sessionId: box.sessionId });
    return;
  }
  set({ mode: 'docked' });
}

export function toggleFloating(): void {
  set({ mode: state.mode === 'floating' ? 'docked' : 'floating' });
}

/** Cycle docked → grid → stack → floating, so one key reaches every layout. */
export function cycleLayout(): void {
  const order: DockMode[] = ['docked', 'grid', 'stack', 'floating'];
  const i = order.indexOf(state.mode);
  set({ mode: order[(i + 1) % order.length] ?? 'docked' });
}

/** True when every shell is visible at once and tabs are not the navigation. */
export function showsAllPanes(mode: DockMode): boolean {
  return mode === 'grid' || mode === 'stack';
}

export function setGeometry(patch: Partial<DockGeometry>): void {
  set({ geometry: { ...state.geometry, ...patch } });
}
