import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';

// TODO(T5): wire post-merge —
//   1. portal/src/App.tsx: wrap the /admin/* routes with <Route path="admin" element={<Page element={<AdminLayout />} />}>
//      and move existing /admin/<X> routes inside as children. Index route should
//      <Navigate to="observability/summary" replace /> (or pick a reasonable landing).
//   2. portal/src/components/shell/Layout.tsx: when T6 adds tenant filtering, admin items
//      collapse into a single { path: '/admin', label: 'Admin', requireRoles: ['hr-admin', 'admin'] }
//      entry instead of 5 separate entries.

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
    />
  );
}

export default AdminLayout;
