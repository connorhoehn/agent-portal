import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

const ITEMS: SubNavItem[] = [
  { path: 'roles',    label: 'Roles',    hint: 'Cedar permission matrix' },
  { path: 'policies', label: 'Policies', hint: 'AVP Cedar source' },
  { path: 'schema',   label: 'Schema',   hint: 'Entity types + actions' },
  { path: 'test',     label: 'Sandbox',  hint: 'Dry-run authz decisions' },
];

function IdentityLayout() {
  return (
    <SubNavLayout
      title="Identity Management"
      items={ITEMS}
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

export default IdentityLayout;
