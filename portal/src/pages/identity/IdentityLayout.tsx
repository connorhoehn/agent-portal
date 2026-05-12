import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';

const ITEMS: SubNavItem[] = [
  { path: 'roles',    label: 'Roles',    hint: 'Cedar permission matrix' },
  { path: 'policies', label: 'Policies', hint: 'AVP Cedar source' },
  { path: 'schema',   label: 'Schema',   hint: 'Entity types + actions' },
  { path: 'test',     label: 'Sandbox',  hint: 'Dry-run authz decisions' },
];

function IdentityLayout() {
  return <SubNavLayout title="Identity Management" items={ITEMS} />;
}

export default IdentityLayout;
