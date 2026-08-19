// The terminal herd — shells that float above the app while you work.
//
// Mounted once in Layout, outside the router outlet, so navigating never
// unmounts a terminal. Tabs are hidden with CSS rather than unmounted for the
// same reason: unmounting drops the socket, and reattaching costs a round trip
// and the local scrollback even though the PTY itself survives server-side.
//
// Two layouts, because the two ways people use a terminal are different:
//   docked   — a panel pinned to the bottom, like an editor's terminal, when
//              the terminal is the thing you are working in.
//   floating — a draggable, resizable window you park over a graph or a
//              dashboard while you keep reading the page underneath.
//
// Keyboard is the point. A terminal you have to go and find with the mouse is
// not a terminal you will use.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Rnd } from 'react-rnd';
import { loadBoxes } from '../../lib/devboxRegistry';
import { DevboxTerminal } from './DevboxTerminal';
import {
  subscribeDock, getDock, closeShell, focusShell, cycleShell, selectShellByIndex,
  setMode, toggleDock, toggleFloating, setGeometry, cycleLayout, showsAllPanes,
  reportShellStatus, openShell, MAX_SHELLS, type ShellStatus,
} from '../../lib/terminalDock';

/** Colour per state. Busy pulses so a moving pane is findable in a grid. */
const STATUS_DOT: Record<ShellStatus, string> = {
  connecting: 'bg-[#8b949e] animate-pulse',
  ready: 'bg-[#7ee787]',
  busy: 'bg-[#f0883e] animate-pulse',
  detached: 'bg-[#8b949e]',
  error: 'bg-[#f85149]',
};

/**
 * Global shortcuts, in capture phase.
 *
 * xterm swallows most keystrokes once focused, so these have to be seen before
 * it gets them or the dock becomes unreachable from inside its own terminal.
 *
 * Command-key bindings, with one constraint worth knowing: the browser
 * reserves a lot of ⌘ combos that a page cannot intercept — ⌘1-9 and ⌘⇧[ ]
 * switch browser tabs, ⌘J opens Downloads, ⌘[ ] are back/forward. So the dock
 * uses ⌘' (free), and numeric tab jumps use ⌥ (Option), which is not taken.
 * Ctrl equivalents stay as aliases so editor muscle memory still works.
 */
function useDockHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;

      // ⌘'  toggle the dock   ·   ⌘⇧'  float / dock
      if (cmd && (e.key === "'" || e.key === '"')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) cycleLayout(); else toggleDock();
        return;
      }

      // ⌘;  next shell   ·   ⌘⇧;  previous
      if (cmd && (e.key === ';' || e.key === ':')) {
        e.preventDefault();
        e.stopPropagation();
        cycleShell(e.shiftKey ? -1 : 1);
        return;
      }

      // ⌥1..9  jump to a tab. Not ⌘1-9 — the browser owns those.
      if (e.altKey && !cmd && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < getDock().shells.length) {
          e.preventDefault();
          e.stopPropagation();
          selectShellByIndex(idx);
        }
        return;
      }

      // ⌃` stays as an alias — it is what editors trained everyone to press.
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) toggleFloating(); else toggleDock();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

export function TerminalDock() {
  const dock = useSyncExternalStore(subscribeDock, getDock, getDock);
  useDockHotkeys();

  if (dock.mode === 'hidden' || dock.shells.length === 0) return null;

  const floating = dock.mode === 'floating';
  const { geometry } = dock;

  const body = (
    <div className="flex flex-col h-full min-h-0 bg-[#0d1117] border border-[#30363d] rounded-lg overflow-hidden shadow-2xl">
      {/* Tab strip — the drag handle when floating. */}
      <div className="dock-drag-handle flex items-center gap-1 px-2 py-1.5 bg-[#161b22] border-b border-[#30363d] select-none"
           style={floating ? { cursor: 'move' } : undefined}>
        {dock.shells.map((s, i) => {
          const active = s.id === dock.activeId;
          return (
            // A row, not a button: the close control is its own button, and
            // nesting one interactive element inside another is invalid HTML
            // and leaves the inner control unreachable by keyboard.
            <div
              key={s.id}
              className={`group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded transition-colors ${
                active ? 'bg-[#0d1117]' : 'bg-transparent hover:bg-[#0d1117]/60'}`}
            >
              <button
                onClick={() => focusShell(s.id)}
                onMouseDown={(e) => e.stopPropagation()}
                title={`${s.label} · ⌥${i + 1}`}
                aria-current={active ? 'true' : undefined}
                className={`flex items-center gap-1.5 text-[11px] font-mono cursor-pointer border-none bg-transparent p-0 ${
                  active ? 'text-[#e6edf3]' : 'text-[#8b949e] hover:text-[#e6edf3]'}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[s.status]}`} title={s.status} />
                {s.label}
                {s.unread && !active && (
                  <span className="w-1 h-1 rounded-full bg-[#58a6ff]" title="new output while you were away" />
                )}
              </button>
              <button
                onClick={() => closeShell(s.id)}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label={`Close ${s.label}`}
                title={`Close ${s.label} — the shell is killed`}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[#8b949e] hover:text-[#f85149] bg-transparent border-none cursor-pointer px-1 leading-none"
              >
                ×
              </button>
            </div>
          );
        })}

        {/* Reach a box that has no shell open yet.
            The tab strip only ever showed shells you had already started, so
            from inside a terminal there was no route to another devbox at all —
            you had to leave, find the page, and click a chip. */}
        <AddShellButton openSessionIds={dock.shells.map((s) => s.sessionId)} />

        <div className="flex-1" />

        {dock.shells.length >= MAX_SHELLS && (
          <span className="text-[10px] text-[#f0883e] mr-1" title="AgentCore allows 10 shells per runtime">
            max shells
          </span>
        )}
        <div className="flex rounded border border-[#30363d] overflow-hidden mr-1">
          {(['docked', 'grid', 'stack', 'floating'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={`${m} layout (⌘⇧' cycles)`}
              className={`px-1.5 py-0.5 text-[10px] cursor-pointer border-none ${
                dock.mode === m ? 'bg-[#30363d] text-[#e6edf3]' : 'bg-transparent text-[#8b949e] hover:text-[#e6edf3]'}`}
            >
              {m === 'docked' ? '▭' : m === 'grid' ? '▦' : m === 'stack' ? '▤' : '▢'}
            </button>
          ))}
        </div>
        <button onClick={toggleFloating} title="Float / dock (⌘⇧')"
          className="text-[11px] px-1.5 py-0.5 text-[#8b949e] hover:text-[#e6edf3] bg-transparent border-none cursor-pointer">
          {floating ? '▣' : '▢'}
        </button>
        <button onClick={() => setMode('hidden')} title="Hide (⌘') — shells keep running"
          className="text-[11px] px-1.5 py-0.5 text-[#8b949e] hover:text-[#e6edf3] bg-transparent border-none cursor-pointer">
          ▾
        </button>
      </div>

      {/* Every shell stays mounted. In tabbed layouts the inactive ones are
          hidden with CSS — never unmounted — so switching does not drop a
          socket. In grid and stack they are all laid out at once. */}
      {showsAllPanes(dock.mode) ? (
        <div
          className={`flex-1 min-h-0 p-1.5 gap-1.5 overflow-auto ${
            dock.mode === 'grid'
              ? 'grid grid-cols-1 md:grid-cols-2 auto-rows-fr'
              : 'flex flex-col'}`}
        >
          {dock.shells.map((s) => (
            <div
              key={s.id}
              onMouseDown={() => focusShell(s.id)}
              className={`min-h-[160px] rounded border overflow-hidden flex flex-col ${
                s.id === dock.activeId ? 'border-[#7ee787]/50' : 'border-[#30363d]'}`}
            >
              <div className="flex items-center gap-1.5 px-2 py-1 bg-[#161b22] border-b border-[#30363d]">
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[s.status]}`} title={s.status} />
                <span className="text-[10px] font-mono text-[#8b949e]">{s.label}</span>
                <div className="flex-1" />
                <button
                  onClick={() => closeShell(s.id)}
                  aria-label={`Close ${s.label}`}
                  className="text-[10px] text-[#8b949e] hover:text-[#f85149] bg-transparent border-none cursor-pointer px-1"
                >
                  ×
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <DevboxTerminal
                  sessionId={s.sessionId}
                  shellId={s.id}
                  label={s.label}
                  chrome={false}
                  fillHeight
                  autoConnect
                  onStatus={(st, sawOutput) => reportShellStatus(s.id, st, sawOutput)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 min-h-0 relative">
          {dock.shells.map((s) => (
            <div
              key={s.id}
              className="absolute inset-0"
              style={{ visibility: s.id === dock.activeId ? 'visible' : 'hidden' }}
              aria-hidden={s.id !== dock.activeId}
            >
              <DevboxTerminal
                sessionId={s.sessionId}
                shellId={s.id}
                label={s.label}
                chrome={false}
                fillHeight
                autoConnect
                onStatus={(st, sawOutput) => reportShellStatus(s.id, st, sawOutput)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // Stack lives down the right edge: narrow enough that the page stays
  // usable beside it, which is the point of stacking rather than docking.
  if (dock.mode === 'stack') {
    return (
      <div className="fixed right-0 top-[64px] bottom-0 z-40 w-[380px] p-2">
        {body}
      </div>
    );
  }

  if (dock.mode === 'grid') {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 px-2 pb-2" style={{ height: '62vh' }}>
        {body}
      </div>
    );
  }

  if (!floating) {

    return (
      <div
        className="fixed left-0 right-0 bottom-0 z-40 px-2 pb-2"
        style={{ height: geometry.dockHeight }}
      >
        {body}
      </div>
    );
  }

  return (
    <Rnd
      className="z-40"
      size={{ width: geometry.width, height: geometry.height }}
      position={{ x: geometry.x, y: geometry.y }}
      minWidth={420}
      minHeight={220}
      bounds="window"
      dragHandleClassName="dock-drag-handle"
      onDragStop={(_e, d) => setGeometry({ x: d.x, y: d.y })}
      onResizeStop={(_e, _dir, ref, _delta, pos) => setGeometry({
        width: ref.offsetWidth, height: ref.offsetHeight, x: pos.x, y: pos.y,
      })}
    >
      {body}
    </Rnd>
  );
}

/**
 * "+" in the tab strip — open a shell on a devbox that does not have one.
 *
 * Boxes already open are listed as disabled rather than hidden, so the menu
 * answers "which boxes exist" and not just "which can I add", and the count
 * does not silently change as you open things.
 */
function AddShellButton({ openSessionIds }: { openSessionIds: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const boxes = (() => { try { return loadBoxes(); } catch { return []; } })();
  if (boxes.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.stopPropagation()}
        title="Open a shell on another devbox"
        aria-label="Open a shell on another devbox"
        aria-expanded={open}
        className="px-1.5 py-1 text-[11px] text-[#8b949e] hover:text-[#e6edf3] bg-transparent border-none cursor-pointer leading-none"
      >
        +
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[190px] rounded border border-[#30363d] bg-[#161b22] shadow-xl overflow-hidden">
          {boxes.map((b) => {
            const already = openSessionIds.includes(b.sessionId);
            return (
              <button
                key={b.id}
                disabled={already}
                onClick={() => {
                  openShell({ id: b.id, label: b.label, sessionId: b.sessionId });
                  setOpen(false);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={`w-full text-left px-3 py-1.5 text-[11px] font-mono border-none bg-transparent ${
                  already
                    ? 'text-[#484f58] cursor-default'
                    : 'text-[#e6edf3] cursor-pointer hover:bg-[#0d1117]'}`}
              >
                {b.label}
                {already && <span className="ml-1.5 text-[10px]">· open</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
