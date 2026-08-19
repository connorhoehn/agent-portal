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

import { useEffect, useSyncExternalStore } from 'react';
import { Rnd } from 'react-rnd';
import { DevboxTerminal } from './DevboxTerminal';
import {
  subscribeDock, getDock, closeShell, focusShell, cycleShell, selectShellByIndex,
  setMode, toggleDock, toggleFloating, setGeometry, MAX_SHELLS,
} from '../../lib/terminalDock';

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
        if (e.shiftKey) toggleFloating(); else toggleDock();
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
            <button
              key={s.id}
              onClick={() => focusShell(s.id)}
              onMouseDown={(e) => e.stopPropagation()}
              title={`${s.label} · ⌥${i + 1}`}
              className={`group flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono cursor-pointer border-none transition-colors ${
                active ? 'bg-[#0d1117] text-[#e6edf3]' : 'bg-transparent text-[#8b949e] hover:text-[#e6edf3]'}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-[#7ee787]' : 'bg-[#30363d]'}`} />
              {s.label}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Close ${s.label}`}
                onClick={(e) => { e.stopPropagation(); closeShell(s.id); }}
                className="opacity-0 group-hover:opacity-100 text-[#8b949e] hover:text-[#f85149] px-0.5"
              >
                ×
              </span>
            </button>
          );
        })}

        <div className="flex-1" />

        {dock.shells.length >= MAX_SHELLS && (
          <span className="text-[10px] text-[#f0883e] mr-1" title="AgentCore allows 10 shells per runtime">
            max shells
          </span>
        )}
        <button onClick={toggleFloating} title="Float / dock (⌘⇧')"
          className="text-[11px] px-1.5 py-0.5 text-[#8b949e] hover:text-[#e6edf3] bg-transparent border-none cursor-pointer">
          {floating ? '▣' : '▢'}
        </button>
        <button onClick={() => setMode('hidden')} title="Hide (⌘') — shells keep running"
          className="text-[11px] px-1.5 py-0.5 text-[#8b949e] hover:text-[#e6edf3] bg-transparent border-none cursor-pointer">
          ▾
        </button>
      </div>

      {/* Every shell stays mounted. Hiding with CSS keeps the socket attached
          and the scrollback intact when you switch tabs. */}
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
            />
          </div>
        ))}
      </div>
    </div>
  );

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
