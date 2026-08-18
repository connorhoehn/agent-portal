import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { KBHealthBadge } from '../../components/kb/KBHealthBadge.js';

const NAV_ITEMS: SubNavItem[] = [
  { path: 'knowledge-base', label: 'Knowledge Base',  hint: 'Documents + sources' },
  { path: 'ingest',         label: 'Ingest',          hint: 'Crawl + sync' },
  { path: 'observability',  label: 'Observability',   hint: 'Traces, metrics, drift' },
  { path: 'capabilities',   label: 'Capabilities',    hint: 'Memory, browser, code' },
  { path: 'devbox',         label: 'Devbox',          hint: 'Claude Code microVM' },
  { path: 'identity',       label: 'Identity',        hint: 'Roles + policies' },
];

function AdminLayout() {
  return (
    <SubNavLayout
      title="Admin"
      items={NAV_ITEMS}
      storageKey="admin-subnav"
      railHeader={<KBHealthBadge />}
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

export default AdminLayout;
