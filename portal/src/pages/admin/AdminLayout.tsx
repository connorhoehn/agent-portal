import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';
import { KBHealthBadge } from '../../components/kb/KBHealthBadge.js';

const NAV_ITEMS: SubNavItem[] = [
  { path: 'knowledge-base', label: 'Knowledge Base',  hint: 'Documents + sources' },
  { path: 'ingest',         label: 'Ingest',          hint: 'Crawl + sync' },
  { path: 'observability',  label: 'Observability',   hint: 'Traces, metrics, drift' },
  { path: 'capabilities',   label: 'Capabilities',    hint: 'Memory, browser, code' },
  { path: 'identity',       label: 'Identity',        hint: 'Roles + policies' },
];

function AdminLayout() {
  return (
    <SubNavLayout
      title="Admin"
      items={NAV_ITEMS}
      storageKey="admin-subnav"
      railHeader={<KBHealthBadge />}
    />
  );
}

export default AdminLayout;
