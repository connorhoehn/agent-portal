import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

// The '?' next to the rail title opens a short orientation modal — what each
// surface is for and how a story moves through the desk.
function HelpButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Newsroom help"
        onClick={() => setOpen(true)}
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          color: 'var(--color-text-tertiary)',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          padding: 0,
        }}
      >
        ?
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Newsroom help"
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            paddingTop: '16vh',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 520, maxWidth: '92vw',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              overflow: 'hidden',
              boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>How the Newsroom works</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close help"
                style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 14 }}
              >
                ✕
              </button>
            </div>
            <div style={{ padding: '14px 18px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
              <p style={{ margin: '0 0 10px' }}>
                The newsroom is the second tenant on this platform — the same agents,
                knowledge pipeline and governance, serving a different business. A story
                moves through it like this:
              </p>
              <ol style={{ margin: '0 0 10px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li><b>Pitches</b> — the backlog. The desk approves, kills, or files each one.</li>
                <li><b>Researcher</b> — the research agent gathers sources and citations for a story.</li>
                <li><b>Articles</b> — drafts and published pieces, with entities and clusters extracted.</li>
                <li><b>Headlines</b> — A/B variants for any draft; <b>Briefs</b> turn the day into a digest.</li>
                <li><b>Beat coverage</b> — the heatmap that shows where the desk is thin.</li>
              </ol>
              <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
                Reporters and editors hold the desk actions (pitch decisions, publishing);
                org roles can read but not decide. ⌘K jumps to any page.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const NAV_ITEMS: SubNavItem[] = [
  { path: 'home',       label: 'Home',          hint: 'Today at a glance' },
  { path: 'articles',   label: 'Articles',      hint: 'Browse + filter' },
  { path: 'beats',      label: 'Beat coverage', hint: 'Heatmap by topic' },
  { path: 'researcher', label: 'Researcher',    hint: 'Story research agent' },
  { path: 'briefs',     label: 'Briefs',        hint: 'Generated digests' },
  { path: 'headlines',  label: 'Headlines',     hint: 'A/B variants for any draft' },
  { path: 'pitches',    label: 'Pitches',       hint: 'Story backlog' },
];

function NewsroomLayout() {
  return (
    <SubNavLayout
      title="Newsroom"
      items={NAV_ITEMS}
      titleAction={<HelpButton />}
      renderNavItem={(item, children, baseStyle) => (
        <NavLink
          to={item.path}
          style={({ isActive }) =>
            isActive
              ? { ...baseStyle, borderLeft: '3px solid var(--color-primary)', background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }
              : baseStyle
          }
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

export default NewsroomLayout;
