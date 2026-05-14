import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';

// TODO(T4): wire post-merge —
//   1. portal/src/App.tsx: replace the flat <Route path="iq/search" .../> etc.
//      with a wrapping <Route path="iq" element={<Page element={<IqLayout />} />}>
//        <Route index element={<Navigate to="agents" replace />} />
//        <Route path="search" element={<Page element={<SearchPage />} />} />
//        ...
//      </Route>
//      Note: leaves the redirects (`/scores` -> `/iq/scores`) intact at top level.

const NAV_ITEMS: SubNavItem[] = [
  { path: 'agents',    label: 'Architecture',  hint: 'A2A agent topology',     group: 'Operate' },
  { path: 'invoke',    label: 'Agent Tools',   hint: 'Multi-agent debug',      group: 'Operate' },
  { path: 'search',    label: 'Search',        hint: 'Org-search agent chat',  group: 'Discover' },
  { path: 'explore',   label: 'Explore',       hint: 'Force-directed graph',   group: 'Discover' },
  { path: 'scores',    label: 'Scores',        hint: 'Influence + expertise',  group: 'Insights' },
  { path: 'decisions', label: 'Decisions',     hint: 'Org-level calls',        group: 'Insights' },
  { path: 'projects',  label: 'Projects',      hint: 'Contributions + status', group: 'Insights' },
];

function IqLayout() {
  return (
    <SubNavLayout
      title="OrgIQ"
      items={NAV_ITEMS}
      storageKey="iq-subnav"
    />
  );
}

export default IqLayout;
