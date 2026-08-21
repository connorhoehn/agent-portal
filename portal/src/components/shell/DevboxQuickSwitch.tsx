// ⌘I — devbox quick-switch overlay, the devbox sibling of the ⌘K palette.
// Lists the named devboxes (each its own AgentCore runtime session = its own
// microVM + persistent workspace), jumps to one, or provisions a new one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCapabilities } from '../../lib/capabilities';
import { createBox, loadBoxes, onBoxesChanged, type DevboxBox } from '../../lib/devboxRegistry';

const mono = 'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

export function DevboxQuickSwitch() {
  const navigate = useNavigate();
  // Provisioning a computer POSTs /api/devbox (ManageDevbox).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const [open, setOpen] = useState(false);
  const [boxes, setBoxes] = useState<DevboxBox[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => setBoxes(loadBoxes()), []);

  useEffect(() => {
    refresh();
    return onBoxesChanged(refresh);
  }, [refresh]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return boxes;
    return boxes.filter((b) =>
      b.label.toLowerCase().includes(q) || b.sessionId.toLowerCase().includes(q));
  }, [boxes, query]);

  // Rows: matching boxes + the "new devbox" action (ManageDevbox only).
  const rows = useMemo(() => matches.length + (canManage ? 1 : 0), [matches, canManage]);

  const go = useCallback((box: DevboxBox) => {
    setOpen(false);
    navigate(`/admin/devbox?box=${box.id}`);
  }, [navigate]);

  const provision = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const box = await createBox(`computer-${loadBoxes().length + 1}`);
      go(box);
    } finally {
      setBusy(false);
    }
  }, [busy, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setHighlight(0);
        setQuery('');
        setOpen((v) => !v);
        return;
      }
      if (!open) return;

      if (e.key === 'Escape') { setOpen(false); }
      else if (e.key === 'ArrowDown') { setHighlight((h) => (h + 1) % rows); }
      else if (e.key === 'ArrowUp') { setHighlight((h) => (h - 1 + rows) % rows); }
      else if (e.key === 'Tab') {
        // Tab and shift-Tab walk the list, because that is what people press
        // when a thing looks like a switcher.
        setHighlight((h) => (h + (e.shiftKey ? -1 : 1) + rows) % rows);
      }
      else if (e.key === 'Enter') {
        if (highlight < matches.length) { const b = matches[highlight]; if (b) go(b); }
        else if (canManage) void provision();
      }
      else if (e.key === 'Backspace') { setQuery((q) => q.slice(0, -1)); setHighlight(0); }
      else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setQuery((q) => q + e.key);
        setHighlight(0);
      }

      // Nothing escapes while the overlay is up.
      //
      // This used to listen in bubble phase and only preventDefault the four
      // keys it handled. xterm's own handler sits on its textarea and runs
      // first, so every other keystroke was typed into the terminal underneath
      // — the overlay looked focused and wasn't, and there was no way to
      // filter or even type without corrupting whatever shell was behind it.
      e.preventDefault();
      e.stopPropagation();
    };
    // Capture phase: xterm must not see these at all.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, rows, highlight, matches, go, provision, canManage]);

  // Take DOM focus off the terminal while the overlay is up, so the browser
  // agrees with what the screen shows.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/40 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        ref={overlayRef}
        tabIndex={-1}
        className="w-[440px] max-w-[90vw] rounded-lg border border-border bg-surface shadow-xl overflow-hidden outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary">COMPUTERS</span>
          <span className="text-[10px] text-text-tertiary">⌘I · ↑↓ / tab · ⏎ · esc</span>
          <div className="flex-1" />
          {query
            ? <span className={`text-[11px] text-text-primary ${mono}`}>{query}</span>
            : <span className="text-[10px] text-text-tertiary">type to filter</span>}
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {matches.map((box, i) => (
            <div
              key={box.id}
              onClick={() => go(box)}
              onMouseEnter={() => setHighlight(i)}
              className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer border-b border-border ${highlight === i ? 'bg-surface-hover' : ''}`}
            >
              <span className="text-[13px] font-semibold text-text-primary">{box.label}</span>
              <span className={`text-[11px] text-text-tertiary ${mono}`}>…{box.sessionId.slice(-10)}</span>
              <div className="flex-1" />
              <span className="text-[10px] text-text-tertiary">{new Date(box.createdAt).toLocaleDateString()}</span>
            </div>
          ))}
          {canManage && (
            <div
              onClick={() => void provision()}
              onMouseEnter={() => setHighlight(matches.length)}
              className={`px-4 py-2.5 flex items-center gap-2 cursor-pointer ${highlight === matches.length ? 'bg-surface-hover' : ''}`}
            >
              <span className="text-[13px] font-semibold text-primary">{busy ? '⏳ provisioning…' : '+ New computer'}</span>
              <span className="text-[11px] text-text-tertiary">fresh microVM workspace</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
