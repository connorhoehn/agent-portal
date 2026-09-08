import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

const ITEMS: SubNavItem[] = [
  { path: 'users',    label: 'Users',    hint: 'Identities + tenant grants' },
  { path: 'roles',    label: 'Roles',    hint: 'Cedar permission matrix' },
  { path: 'policies', label: 'Policies', hint: 'AVP Cedar source' },
  { path: 'schema',   label: 'Schema',   hint: 'Entity types + actions' },
  { path: 'test',     label: 'Sandbox',  hint: 'Dry-run authz decisions' },
];

// SubNavLayout's `renderNavItem` is the only way to get a real react-router
// NavLink (its own default nav item is a plain `<a href>` with no active-
// state detection). The composite's doc comment wires active state through a
// computed `style` object merging its `baseStyle` param — this reproduces
// that exact default look via NavLink's `className` callback and Tailwind
// tokens instead, so no inline `style` is needed. Same fix as
// `ingest/IngestLayout.tsx`; queued once for the library in
// docs/ui-components-queue.md rather than per-directory.
function navItemClassName(isActive: boolean): string {
  return isActive
    ? 'block px-[14px] py-2 border-l-[3px] border-l-primary bg-surface-hover text-text-primary no-underline cursor-pointer'
    : 'block px-[14px] py-2 border-l-[3px] border-transparent text-text-secondary no-underline cursor-pointer';
}

function IdentityLayout() {
  return (
    <SubNavLayout
      title="Identity Management"
      items={ITEMS}
      renderNavItem={(item, children) => (
        <NavLink to={item.path} className={({ isActive }) => navItemClassName(isActive)}>
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

export default IdentityLayout;
