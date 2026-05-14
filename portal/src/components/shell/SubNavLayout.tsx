import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';

// Shared "section with left-rail" layout. Pattern mirrors the InvokePage
// session sidebar — slim rail, section title at top, NavLink items with
// active highlight, content rendered via <Outlet />. Sub-routes are owned
// by App.tsx.
//
// If any item has a `group`, the layout renders collapsible group sections
// (state persisted to localStorage). If no items have groups, the layout
// renders as a flat list (backwards-compatible with the existing Ingest,
// Capabilities, and Identity uses).

export interface SubNavItem {
  /** Path relative to the section root, e.g. "summary" or "crawl". */
  path: string;
  label: string;
  /** Optional small badge (e.g. live count) shown right-aligned. */
  count?: number | string;
  /** Optional dim subtitle below the label. */
  hint?: string;
  /** Optional group heading. When set on any item, the layout renders
   *  collapsible sections by group. Items without a group go into an
   *  un-headered first section. */
  group?: string;
}

interface SubNavLayoutProps {
  /** Section title shown at top of the rail. */
  title: string;
  items: SubNavItem[];
  /** Optional element rendered next to the title (e.g. a help "?" button). */
  titleAction?: ReactNode;
  /** Optional content rendered above the nav items (e.g. a [+ New] button). */
  railHeader?: ReactNode;
  /** Override the default rail width. */
  railWidth?: number;
  /** Storage key prefix for collapsed-section persistence (default 'subnav'). */
  storageKey?: string;
}

export function SubNavLayout({
  title,
  items,
  titleAction,
  railHeader,
  railWidth = 220,
  storageKey = 'subnav',
}: SubNavLayoutProps) {
  // Bucket items by group while preserving original order. Items with no
  // `group` go into the leading anonymous bucket.
  const groups = useMemo(() => {
    const out: Array<{ name: string | null; items: SubNavItem[] }> = [];
    const byName = new Map<string, number>();
    for (const item of items) {
      const g = item.group ?? null;
      if (g === null) {
        if (out.length === 0 || out[0].name !== null) {
          out.unshift({ name: null, items: [] });
          // reindex byName since we shifted
          byName.forEach((v, k) => byName.set(k, v + 1));
        }
        out[0].items.push(item);
        continue;
      }
      let idx = byName.get(g);
      if (idx === undefined) {
        idx = out.length;
        byName.set(g, idx);
        out.push({ name: g, items: [] });
      }
      out[idx].items.push(item);
    }
    return out;
  }, [items]);

  const isGrouped = groups.some((g) => g.name !== null);

  return (
    <div style={layout}>
      <aside style={{ ...rail, width: railWidth }}>
        <div style={railHead}>
          <span style={railTitle}>{title}</span>
          {titleAction}
        </div>
        {railHeader && <div style={railHeaderSlot}>{railHeader}</div>}
        <nav style={navList}>
          {isGrouped ? (
            groups.map((g) =>
              g.name === null ? (
                <FlatItems key="__ungrouped" items={g.items} />
              ) : (
                <GroupSection
                  key={g.name}
                  name={g.name}
                  items={g.items}
                  storageKey={`${storageKey}.${title}.${g.name}`}
                />
              ),
            )
          ) : (
            <FlatItems items={items} />
          )}
        </nav>
      </aside>
      <main style={content}>
        <Outlet />
      </main>
    </div>
  );
}

function FlatItems({ items }: { items: SubNavItem[] }) {
  return (
    <>
      {items.map((item) => (
        <ItemLink key={item.path} item={item} />
      ))}
    </>
  );
}

function GroupSection({
  name,
  items,
  storageKey,
}: {
  name: string;
  items: SubNavItem[];
  storageKey: string;
}) {
  // Persist collapsed state per (title, group) — researcher's choice survives
  // page navigation. Default: open.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage?.getItem(storageKey) === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (collapsed) window.localStorage?.setItem(storageKey, '1');
    else window.localStorage?.removeItem(storageKey);
  }, [collapsed, storageKey]);

  return (
    <section style={groupSection}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        style={groupHeader}
        aria-expanded={!collapsed}
      >
        <span style={groupCaret} aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span style={groupTitle}>{name}</span>
        <span style={groupCount}>{items.length}</span>
      </button>
      {!collapsed && (
        <div>
          {items.map((item) => (
            <ItemLink key={item.path} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function ItemLink({ item }: { item: SubNavItem }) {
  return (
    <NavLink
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
  padding: '4px 0',
};

const groupSection: CSSProperties = {
  borderBottom: '1px solid var(--color-border)',
};

const groupHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '8px 12px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-tertiary)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  textAlign: 'left',
};

const groupCaret: CSSProperties = {
  fontSize: 10,
  width: 10,
  display: 'inline-block',
};

const groupTitle: CSSProperties = {
  flex: 1,
};

const groupCount: CSSProperties = {
  fontSize: 9,
  fontWeight: 500,
  color: 'var(--color-text-tertiary)',
  background: 'var(--color-bg)',
  padding: '1px 5px',
  borderRadius: 6,
  border: '1px solid var(--color-border)',
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
