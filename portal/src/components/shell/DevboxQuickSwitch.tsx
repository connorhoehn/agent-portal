// ⌘I — devbox quick-switch overlay, the devbox sibling of the ⌘K palette.
// Lists the named devboxes (each its own AgentCore runtime session = its own
// microVM + persistent workspace), jumps to one, or provisions a new one.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { createBox, loadBoxes, onBoxesChanged, type DevboxBox } from '../../lib/devboxRegistry';

const mono = 'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

export function DevboxQuickSwitch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [boxes, setBoxes] = useState<DevboxBox[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setBoxes(loadBoxes()), []);

  useEffect(() => {
    refresh();
    return onBoxesChanged(refresh);
  }, [refresh]);

  // Rows: existing boxes + the "new devbox" action.
  const rows = useMemo(() => boxes.length + 1, [boxes]);

  const go = useCallback((box: DevboxBox) => {
    setOpen(false);
    navigate(`/admin/devbox?box=${box.id}`);
  }, [navigate]);

  const provision = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const box = await createBox();
      go(box);
    } finally {
      setBusy(false);
    }
  }, [busy, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setHighlight(0);
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % rows); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + rows) % rows); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlight < boxes.length) go(boxes[highlight]);
        else void provision();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, rows, highlight, boxes, go, provision]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/40 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[440px] max-w-[90vw] rounded-lg border border-border bg-surface shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary">DEVBOXES</span>
          <span className="text-[10px] text-text-tertiary">⌘I · ↑↓ · ⏎ · esc</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {boxes.map((box, i) => (
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
          <div
            onClick={() => void provision()}
            onMouseEnter={() => setHighlight(boxes.length)}
            className={`px-4 py-2.5 flex items-center gap-2 cursor-pointer ${highlight === boxes.length ? 'bg-surface-hover' : ''}`}
          >
            <span className="text-[13px] font-semibold text-primary">{busy ? '⏳ provisioning…' : '+ New devbox'}</span>
            <span className="text-[11px] text-text-tertiary">fresh microVM workspace</span>
          </div>
        </div>
      </div>
    </div>
  );
}
