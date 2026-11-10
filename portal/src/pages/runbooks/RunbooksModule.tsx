// Build → Runbooks: one module frame over three destinations
// — Library, Proposals (with the open count) and Briefs. The section rail is a SubNavLayout; each
// destination draws ListRailLayout (a flush list rail beside it, then trail → title → record,
// docs/layout-cascade.md). The Proposals count is polled (no gateway channel is needed to be correct).
import { Link, Outlet, useLocation } from 'react-router';
import { ViewportFillRegion } from '@connorhoehn/ui-components';
import {
  Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem,
} from '@connorhoehn/ui-components/shared';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { useFetch } from '../../hooks/useFetch';
import { briefsHref, proposalsHref, RUNBOOKS } from './runbooksModel';
import type { Proposal } from './types';

/** What the module hands its destinations through the route outlet. */
export interface RunbooksOutletContext {
  breadcrumbs: ReturnType<typeof useShellBreadcrumbItems>;
  /** Open proposals, for the rail; null while unknown. */
  openProposals: number | null;
  refreshProposals: () => void;
}

type NavId = 'library' | 'proposals' | 'briefs';

export default function RunbooksModule() {
  const { pathname } = useLocation();
  const crumbs = useShellBreadcrumbItems();
  const open = useFetch<{ proposals: Proposal[] }>('/api/runbooks/proposals?status=open&limit=200', 30_000);
  const openCount = open.data ? open.data.proposals.length : null;

  const active: NavId = pathname.startsWith(proposalsHref()) ? 'proposals' : pathname.startsWith(briefsHref()) ? 'briefs' : 'library';
  const entries: Array<{ id: NavId; label: string; path: string; hint: string; count?: number; accent?: 'warning' }> = [
    { id: 'library', label: 'Library', path: RUNBOOKS, hint: 'Every runbook, by scope' },
    { id: 'proposals', label: 'Proposals', path: proposalsHref(), hint: 'Edits and new runbooks waiting for a reviewer', ...(openCount != null ? { count: openCount } : {}) },
    { id: 'briefs', label: 'Briefs', path: briefsHref(), hint: 'What each run was told when it started' },
  ];
  const items: SubNavItem[] = entries.map((e) => ({ path: e.path, label: e.label, ...(e.count != null ? { count: e.count } : {}) }));

  return (
    <ViewportFillRegion bottomGap={0} data-testid="runbooks-module">
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        <SubNavLayout
          title="Runbooks"
          items={items}
          storageKey="runbooks-rail"
          railLabel="Runbooks navigation"
          contentAs="section"
          contentLabel="Runbooks"
          renderNavItem={(item, children) => {
            const entry = entries.find((e) => e.path === item.path);
            const current = entry?.id === active;
            return (
              <Link
                to={item.path}
                aria-current={current ? 'page' : undefined}
                title={entry?.hint}
                className={current ? activeNavItemClassName : inactiveNavItemClassName}
                data-testid={entry ? `runbooks-nav-${entry.id}` : undefined}
              >
                {children}
              </Link>
            );
          }}
        >
          <Outlet context={{ breadcrumbs: crumbs, openProposals: openCount, refreshProposals: open.refresh } satisfies RunbooksOutletContext} />
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
