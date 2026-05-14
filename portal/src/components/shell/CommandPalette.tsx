// Global ⌘K command palette. Pressing Cmd+K (Mac) / Ctrl+K (Win/Linux)
// opens a centered overlay. Esc closes it. Up/Down arrows navigate, Enter
// activates. Mounted once in <Layout> so it's reachable from any page.
//
// Three result categories:
//   1. Static page jumps  — hard-coded registry of top-level destinations.
//   2. Recent harness runs — fetched once when the palette is opened.
//   3. UUID match          — if the input parses as a uuid, offer
//                            "Open invocation <id-prefix>".

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

interface PageEntry {
  label: string;
  hint: string;
  path: string;
}

interface RecentRun {
  runId: string;
  label?: string;
  startedAt?: string;
  passRate?: number | null;
  status?: string;
}

interface Result {
  key: string;
  label: string;
  hint: string;
  path: string;
  // Distinguishes ordering / section in the result list.
  kind: 'page' | 'run' | 'uuid';
}

// Top-level destinations across observability and harness. Order roughly
// matches the sub-nav order so muscle-memory keys still work.
const PAGES: PageEntry[] = [
  { label: 'Search',             hint: 'Ask the org-search agent',            path: '/search' },
  { label: 'Explore',            hint: 'Force-directed org graph',            path: '/explore' },
  { label: 'Architecture',       hint: 'A2A agent topology',                  path: '/agents' },
  { label: 'Scores',             hint: 'Per-person influence leaderboard',    path: '/scores' },
  { label: 'On-Call',            hint: 'Live alarms + incident timeline',     path: '/observability/oncall' },
  { label: 'Summary',            hint: 'Health overview',                     path: '/observability/summary' },
  { label: 'Traffic',            hint: 'RPS + heatmap + top users',           path: '/observability/traffic' },
  { label: 'Recent',             hint: 'Last 50 agent calls',                 path: '/observability/invocations' },
  { label: 'Invocations Search', hint: 'Triage by prompt / agent / score',    path: '/observability/invocations/search' },
  { label: 'Capability Events',  hint: 'Browser & code-interpreter events',   path: '/observability/capability-events' },
  { label: 'Agent Metrics',      hint: 'Per-agent stats',                     path: '/observability/agents' },
  { label: 'Sessions',           hint: 'Chat threads',                        path: '/observability/sessions' },
  { label: 'Authz Log',          hint: 'Live AVP / Cedar decisions',          path: '/observability/authz' },
  { label: 'Memory',             hint: 'Memory ops + cold sessions',          path: '/observability/memory' },
  { label: 'Guardrail Rules',    hint: 'Per-rule intervention details',       path: '/observability/guardrail-rules' },
  { label: 'Drift',              hint: 'Schema + judge + embedding drift',    path: '/observability/drift' },
  { label: 'Quality',            hint: 'Judge scores + feedback',             path: '/observability/quality' },
  { label: 'Cost',               hint: 'Spend by agent + deploy markers',     path: '/observability/cost' },
  { label: 'Approvals',          hint: 'Pending HITL decisions',              path: '/observability/approvals' },
  { label: 'Harness',            hint: 'Replay test set + view runs',         path: '/observability/harness' },
  { label: 'Calibration',        hint: 'Judge vs human MAE drift',            path: '/observability/calibration' },
  { label: 'Model Compare',      hint: 'Side-by-side run delta',              path: '/observability/model-compare' },
];

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_RESULTS = 8;

export function CommandPalette() {
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // ── open/close handlers ───────────────────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  // Global Cmd+K / Ctrl+K listener. Capture phase so we beat any nested
  // input that might consume the key (search boxes etc).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isToggle = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isToggle) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  // Auto-close on route change. Otherwise navigating from the palette would
  // leave the overlay visible over the new page.
  useEffect(() => {
    if (open) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Autofocus input on open.
  useEffect(() => {
    if (open) {
      // Defer one tick so the input is in the DOM.
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // Lazy-fetch recent runs the first time the palette opens.
  useEffect(() => {
    if (!open || runsLoaded) return;
    let cancelled = false;
    fetch('/api/observability/harness/runs?limit=5', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (cancelled || !j) return;
        // Accept both `{ runs: [...] }` and bare arrays.
        const raw = Array.isArray(j)
          ? j
          : ((j as { runs?: unknown }).runs ?? []);
        const list = Array.isArray(raw) ? (raw as RecentRun[]) : [];
        setRecentRuns(list.slice(0, 5));
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setRunsLoaded(true); });
    return () => { cancelled = true; };
  }, [open, runsLoaded]);

  // ── result computation ────────────────────────────────────────────────────
  const results = useMemo<Result[]>(() => {
    const q = query.trim();
    const out: Result[] = [];

    // UUID short-circuit: when input matches the uuid shape, offer a single
    // jump to /observability/invocations/<id>. Researchers paste ids from
    // logs constantly — this saves a click.
    if (UUID_RE.test(q)) {
      const prefix = q.slice(0, 8);
      out.push({
        key: `uuid:${q}`,
        kind: 'uuid',
        label: `Open invocation ${prefix} →`,
        hint: q,
        path: `/observability/invocations/${q}`,
      });
      return out;
    }

    const ql = q.toLowerCase();
    const matchesPage = (p: PageEntry) =>
      !ql ||
      p.label.toLowerCase().includes(ql) ||
      p.hint.toLowerCase().includes(ql);

    for (const p of PAGES) {
      if (matchesPage(p)) {
        out.push({
          key: `page:${p.path}`,
          kind: 'page',
          label: p.label,
          hint: p.hint,
          path: p.path,
        });
      }
    }

    for (const r of recentRuns) {
      const label = r.label || r.runId;
      const haystack = `${label} ${r.runId}`.toLowerCase();
      if (!ql || haystack.includes(ql)) {
        out.push({
          key: `run:${r.runId}`,
          kind: 'run',
          label: `Run · ${label}`,
          hint: `${r.status ?? 'run'} · ${r.runId.slice(0, 8)}`,
          path: `/observability/harness/runs/${r.runId}`,
        });
      }
    }

    return out.slice(0, MAX_RESULTS);
  }, [query, recentRuns]);

  // Clamp selectedIndex into range whenever the result list changes.
  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndex]);

  // Reset selection to top when the query changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function activate(idx: number) {
    const r = results[idx];
    if (!r) return;
    // close() runs via the route-change effect, but also fire it here in
    // case the user activates the current route (no change → no effect).
    close();
    navigate(r.path);
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selectedIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  if (!open) return null;

  return (
    <div
      style={backdropStyle}
      onClick={close}
      role="presentation"
    >
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Jump to a page, paste an invocation id, search runs…"
          style={inputStyle}
          spellCheck={false}
          autoComplete="off"
        />
        <div ref={listRef} style={listStyle}>
          {results.length === 0 ? (
            <div style={emptyRowStyle}>No matches. Try a different keyword.</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.key}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => activate(i)}
                style={i === selectedIndex ? rowSelectedStyle : rowStyle}
              >
                <div style={rowLabelStyle}>
                  <span style={kindGlyphStyle}>{kindGlyph(r.kind)}</span>
                  <span>{r.label}</span>
                </div>
                <div style={rowHintStyle}>{r.hint}</div>
              </div>
            ))
          )}
        </div>
        <div style={footerStyle}>
          <span>
            <kbd style={kbdStyle}>↑</kbd>
            <kbd style={kbdStyle}>↓</kbd>
            navigate
          </span>
          <span>
            <kbd style={kbdStyle}>↵</kbd>
            open
          </span>
          <span>
            <kbd style={kbdStyle}>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}

// Small visual hint that lets researchers see the palette exists without
// hunting for a tooltip. Mounted in the top bar; clicking opens the palette
// via a synthetic Cmd+K-style toggle.
export function CommandPaletteHint() {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        // Dispatch a synthetic ⌘K. Easiest way to share the open path with
        // the global keydown listener without exporting setOpen.
        const evt = new KeyboardEvent('keydown', {
          key: 'k',
          metaKey: true,
          bubbles: true,
        });
        document.dispatchEvent(evt);
        setPressed(true);
        window.setTimeout(() => setPressed(false), 120);
      }}
      style={pressed ? hintPressedStyle : hintStyle}
      title="Open command palette"
      aria-label="Open command palette"
    >
      <kbd style={hintKbdStyle}>⌘</kbd>
      <kbd style={hintKbdStyle}>K</kbd>
      <span style={hintLabelStyle}>jump…</span>
    </button>
  );
}

function kindGlyph(kind: Result['kind']): string {
  switch (kind) {
    case 'uuid': return '#';
    case 'run':  return '▸';
    case 'page':
    default:     return '›';
  }
}

// ── styles ──────────────────────────────────────────────────────────────────
const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  zIndex: 1200,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  paddingTop: 96,
};
const panelStyle: CSSProperties = {
  width: '100%',
  maxWidth: 540,
  margin: '0 16px',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md, 8px)',
  boxShadow: '0 20px 50px rgba(0,0,0,0.32)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
const inputStyle: CSSProperties = {
  border: 'none',
  outline: 'none',
  padding: '14px 16px',
  fontSize: 14,
  background: 'transparent',
  color: 'var(--color-text-primary)',
  borderBottom: '1px solid var(--color-border)',
  fontFamily: 'inherit',
};
const listStyle: CSSProperties = {
  maxHeight: 360,
  overflowY: 'auto',
  padding: '4px 0',
};
const rowStyle: CSSProperties = {
  padding: '8px 16px',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
const rowSelectedStyle: CSSProperties = {
  ...rowStyle,
  background: 'var(--color-surface-hover)',
};
const rowLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--color-text-primary)',
  fontWeight: 500,
};
const kindGlyphStyle: CSSProperties = {
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
  width: 10,
  display: 'inline-block',
};
const rowHintStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  paddingLeft: 18,
};
const emptyRowStyle: CSSProperties = {
  padding: '14px 16px',
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  textAlign: 'center',
};
const footerStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  padding: '8px 16px',
  borderTop: '1px solid var(--color-border)',
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  alignItems: 'center',
};
const kbdStyle: CSSProperties = {
  display: 'inline-block',
  padding: '1px 5px',
  marginRight: 4,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 10,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 3,
  color: 'var(--color-text-secondary)',
};
const hintStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
};
const hintPressedStyle: CSSProperties = {
  ...hintStyle,
  background: 'var(--color-surface-hover)',
};
const hintKbdStyle: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 10.5,
  padding: '0 3px',
  borderRadius: 3,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-secondary)',
};
const hintLabelStyle: CSSProperties = {
  marginLeft: 4,
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
};

export default CommandPalette;
