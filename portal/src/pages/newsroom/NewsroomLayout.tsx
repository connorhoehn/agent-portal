import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

// Placeholder badge rendered on nav items that are not yet built.
// The '?' button titleAction is a no-op until the Newsroom help modal
// is wired by a future agent.
function HelpButton() {
  return (
    <button
      type="button"
      aria-label="Newsroom help"
      onClick={() => {
        // TODO(N2): open a help / onboarding modal for the Newsroom section
      }}
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
