import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

const ITEMS: SubNavItem[] = [
  { path: 'summary',          label: 'Summary',          hint: 'Health overview' },
  { path: 'guardrails',       label: 'Guardrails',       hint: 'PII & content policy' },
  { path: 'prompts',          label: 'Prompts',          hint: 'Managed prompt registry' },
  { path: 'code-interpreter', label: 'Code Interpreter', hint: 'Sandbox executions' },
  { path: 'browser',          label: 'Browser',          hint: 'Headless sessions' },
  { path: 'memory',           label: 'Memory',           hint: 'Session store' },
];

function CapabilitiesLayout() {
  return (
    <SubNavLayout
      title="Capabilities"
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

export default CapabilitiesLayout;
