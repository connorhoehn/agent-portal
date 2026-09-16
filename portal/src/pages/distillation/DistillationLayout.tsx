// Build → Distillation. The fleet's shared memory as a live store under
// write pressure — many concurrent sessions write typed observations
// (`lab_experiences`); a background compactor merges them upward, LSM-tree
// style: L0 raw write head → L1 deduped clusters → L2 stable artifacts that
// feed the Library. Almost none of it is reviewed by design; people sample a
// small, tunable slice instead (Review sample), and whether that rate is
// right is itself a live question (the sampling verdict), not a constant.
//
// This used to be one page: a stat strip and tier cards, then — after one
// scroll, with nothing marking the seam — a compaction job ledger. Nothing on
// the page linked anywhere: no artifact, no fact, no lineage, no reviewable
// queue. `DistillationLayout` gives it the same nested-rail shape
// `ObservabilityLayout` uses so each of those becomes a real route instead of
// a scroll position: Memory (what's in the store), Knowledge (what it
// produced, with provenance), Operations (running it and keeping it honest).
import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';

const ITEMS: SubNavItem[] = [
  { group: 'Memory', path: 'overview', label: 'Overview', hint: 'Tier health, ingest, sampling' },
  { group: 'Memory', path: 'tiers', label: 'Tiers', hint: 'L0 observations · L1 clusters · L2 artifacts' },
  { group: 'Knowledge', path: 'artifacts', label: 'Artifacts', hint: 'L2 artifacts, with Library links' },
  { group: 'Knowledge', path: 'lineage', label: 'Lineage', hint: 'Observation → cluster → artifact → library item' },
  { group: 'Operations', path: 'compactions', label: 'Compactions', hint: 'Job history + Compact L0→L1 / L1→L2' },
  { group: 'Operations', path: 'review', label: 'Review sample', hint: 'The human sample queue + calibration' },
];

/** The two Operations hints promise verbs (Compact, agree/disagree) gated on
 *  ManageBots; a role without it opens a read-only ledger, so its rail should
 *  say so rather than advertise the verb. */
const READ_ONLY_HINTS: Record<string, string> = {
  compactions: 'Job history',
  review: 'The human sample queue + calibration (read-only for your role)',
};

function DistillationLayout() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageBots');
  const items = canManage
    ? ITEMS
    : ITEMS.map((i) => (READ_ONLY_HINTS[i.path] ? { ...i, hint: READ_ONLY_HINTS[i.path] } : i));
  return (
    <SubNavLayout
      title="Distillation"
      items={items}
      storageKey="distillation"
      contentAs="section"
      contentLabel="Distillation"
      renderNavItem={(item, children) => (
        <NavLink
          to={item.path}
          className={({ isActive }) => (isActive ? activeNavItemClassName : inactiveNavItemClassName)}
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

// Reproduces SubNavLayout's own default active/inactive nav-item look
// (see the library's `renderNavItem` doc comment) as Tailwind classes on
// NavLink's `className` prop instead of a computed `style` object — a real
// router integration still needs `renderNavItem`, but nothing here needs an
// inline style to get it.

export default DistillationLayout;
