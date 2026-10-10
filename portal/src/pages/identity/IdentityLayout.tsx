import { NavLink, Outlet } from 'react-router';
import { type SubNavItem, activeNavItemClassName, inactiveNavItemClassName } from '@connorhoehnslalom/ui-components/shared';
import { BuildSectionLayout } from '../../components/shell/BuildSectionLayout';

const ITEMS: SubNavItem[] = [
  { path: 'users',    label: 'Users' },
  { path: 'roles',    label: 'Roles' },
  { path: 'policies', label: 'Policies' },
  { path: 'schema',   label: 'Schema' },
  { path: 'test',     label: 'Sandbox' },
];

// SubNavLayout's `renderNavItem` is the only way to get a real react-router
// NavLink (its own default nav item is a plain `<a href>` with no active-
// state detection). The composite's doc comment wires active state through a
// computed `style` object merging its `baseStyle` param — this reproduces
// that exact default look via NavLink's `className` callback and Tailwind
// tokens instead, so no inline `style` is needed. Same fix as
// `ingest/IngestLayout.tsx`; queued once for the library in
// docs/ui-components-queue.md rather than per-directory.

function IdentityLayout() {
  return (
    <BuildSectionLayout
      title="Identity Management"
      storageKey="identity-subnav"
      items={ITEMS}
      contentLabel="Identity"
      renderNavItem={(item, children) => (
        <NavLink to={item.path} className={({ isActive }) => (isActive ? activeNavItemClassName : inactiveNavItemClassName)}>
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </BuildSectionLayout>
  );
}

export default IdentityLayout;
