import type { CSSProperties, ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';

// Shared "section with left-rail" layout used by Ingest, Capabilities, and
// Observability. Pattern mirrors the InvokePage session sidebar — slim rail
// (220px), section title at top, NavLink items with active highlight, content
// rendered via <Outlet />. Sub-routes are owned by App.tsx.

export interface SubNavItem {
  /** Path relative to the section root, e.g. "summary" or "crawl". */
  path: string;
  label: string;
  /** Optional small badge (e.g. live count) shown right-aligned. */
  count?: number | string;
  /** Optional dim subtitle below the label. */
  hint?: string;
}

interface SubNavLayoutProps {
  /** Section title shown at top of the rail. */
  title: string;
  items: SubNavItem[];
  /** Optional content rendered above the nav items (e.g. a [+ New] button). */
  railHeader?: ReactNode;
  /** Override the default rail width. */
  railWidth?: number;
}

export function SubNavLayout({
  title,
  items,
  railHeader,
  railWidth = 220,
}: SubNavLayoutProps) {
  return (
    <div style={layout}>
      <aside style={{ ...rail, width: railWidth }}>
        <div style={railHead}>
          <span style={railTitle}>{title}</span>
        </div>
        {railHeader && <div style={railHeaderSlot}>{railHeader}</div>}
        <nav style={navList}>
          {items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === ''}
              style={({ isActive }) => navItemStyle(isActive)}
            >
              <div style={navLabelRow}>
                <span style={navLabel}>{item.label}</span>
                {item.count !== undefined && (
                  <span style={navCount}>{item.count}</span>
                )}
              </div>
              {item.hint && <div style={navHint}>{item.hint}</div>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main style={content}>
        <Outlet />
      </main>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const layout: CSSProperties = {
  display: 'flex',
  height: '100%',
  minHeight: 0,
};

const rail: CSSProperties = {
  flex: '0 0 auto',
  borderRight: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const railHead: CSSProperties = {
  padding: '14px 16px',
  borderBottom: '1px solid var(--color-border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const railTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const railHeaderSlot: CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--color-border)',
};

const navList: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 0',
};

function navItemStyle(isActive: boolean): CSSProperties {
  return {
    display: 'block',
    padding: '8px 14px',
    borderLeft: isActive ? '3px solid var(--color-primary)' : '3px solid transparent',
    background: isActive ? 'var(--color-surface-hover)' : undefined,
    color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

const navLabelRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const navLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const navCount: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  color: 'var(--color-text-tertiary)',
  background: 'var(--color-surface)',
  padding: '1px 6px',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
};

const navHint: CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  marginTop: 2,
};

const content: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'auto',
};
