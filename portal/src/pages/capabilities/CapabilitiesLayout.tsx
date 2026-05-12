import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';

const ITEMS: SubNavItem[] = [
  { path: 'summary',          label: 'Summary',          hint: 'Health overview' },
  { path: 'guardrails',       label: 'Guardrails',       hint: 'PII & content policy' },
  { path: 'code-interpreter', label: 'Code Interpreter', hint: 'Sandbox executions' },
  { path: 'browser',          label: 'Browser',          hint: 'Headless sessions' },
  { path: 'memory',           label: 'Memory',           hint: 'Session store' },
];

function CapabilitiesLayout() {
  return <SubNavLayout title="Capabilities" items={ITEMS} />;
}

export default CapabilitiesLayout;
