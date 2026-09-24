// Build → Distillation: one module frame over the three destinations of
// docs/distillation-redesign-spec.md §1 — Knowledge / Review / Activity.
//
// Navigation is a vertical sub-nav (SubNavLayout, as the Overview and Tiers
// mockups draw it): groups Knowledge / Review / Activity, each listing the
// views inside it with live counts — Guides & findings / Patterns / Run notes,
// Pending / Reviewed, Runs (warning accent while a tier is behind) / Tier
// graph. The IA doc's horizontal tabs were dropped for it: one navigation,
// not two. The ScopeHeader above the content names the destination and keeps
// the repository selector (`?repo=`, carried by every rail link) and "Open
// Library ↗". Flush over a ViewportFillRegion.
import { useMemo } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';
import { ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import {
  Select, Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem,
} from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { activeNavId, destinationTitle, moduleNav } from './moduleNavModel';
import { queueCounts } from './reviewQueueModel';
import { activityDot, tierCount } from './tierFlowModel';
import type { FacetsResponse, ReviewSampleWithTarget, TierLevelsResponse } from './types';

/** What the module hands its tabs through the route outlet. */
export interface DistillationOutletContext {
  refreshReview: () => void;
  refreshLevels: () => void;
}

export default function DistillationModule() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const crumbs = useShellBreadcrumbItems();
  const repo = params.get('repo') || null;
  const { can, ready } = useCapabilities();
  const canReview = ready && can('ManageBots');

  const review = useDistillationChannel<{ samples?: ReviewSampleWithTarget[]; counts?: { pending: number; decided?: number } }>('distill:review');
  const levels = useDistillationChannel<TierLevelsResponse>('distill:levels');
  const facets = useFetch<FacetsResponse>('/api/distillation/facets', 0);

  // The live count frame wins over the snapshot's own list when present.
  const counts = review.data?.samples ? queueCounts(review.data.samples) : null;
  const pending = review.data?.counts?.pending ?? counts?.pending;
  const decided = review.data?.counts?.decided ?? counts?.decided;
  const dot = useMemo(
    () => (levels.data ? activityDot(levels.data.levels ?? [], levels.data.health) : null),
    [levels.data],
  );
  const tier = (lv: 'L0' | 'L1' | 'L2') => {
    const row = levels.data?.levels?.find((l) => l.level === lv);
    return row ? tierCount(row) : null;
  };

  const entries = moduleNav(
    { L0: tier('L0'), L1: tier('L1'), L2: tier('L2'), pending, decided, health: dot },
    repo,
    canReview,
  );
  const activeId = activeNavId(location.pathname, location.search);
  const items: SubNavItem[] = entries.map((e) => ({
    path: e.path,
    label: e.label,
    group: e.group,
    // No hint line: the mockups' rail is single-line entries, and a hint under
    // every item doubled its height. The hint becomes the link's tooltip below.
    ...(e.count != null ? { count: e.count } : {}),
    ...(e.accent ? { accent: e.accent } : {}),
  }));

  const repoOptions = [
    { value: '', label: 'All repositories' },
    ...(facets.data?.repos ?? []).map((r) => ({ value: r.value, label: r.label })),
    // A deep link can name a repo the facets do not list; keep it selectable.
    ...(repo && !(facets.data?.repos ?? []).some((r) => r.value === repo) ? [{ value: repo, label: repo }] : []),
  ];

  return (
    <ViewportFillRegion bottomGap={0} data-testid="distillation-module">
      {/* data-shell-flush: the shell drops its padding ring and breadcrumb
          row; the header prints the trail. */}
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        <SubNavLayout
          title="Distillation"
          items={items}
          storageKey="distillation-rail"
          railLabel="Distillation navigation"
          contentAs="section"
          contentLabel="Distillation"
          renderNavItem={(item, children) => {
            const entry = entries.find((e) => e.path === item.path);
            return (
              <Link
                to={item.path}
                aria-current={entry?.id === activeId ? 'page' : undefined}
                title={entry?.hint}
                className={entry?.id === activeId ? activeNavItemClassName : inactiveNavItemClassName}
                data-testid={entry ? `distillation-nav-${entry.id}` : undefined}
              >
                {children}
              </Link>
            );
          }}
        >
          <Stack gap="none" className="h-full min-h-0">
            <ScopeHeader
              breadcrumbs={crumbs}
              title={destinationTitle(location.pathname)}
              link={{ label: 'Open Library ↗', href: '/iq/library' }}
              controls={(
                <Select
                  aria-label="Repository"
                  size="sm"
                  value={repo ?? ''}
                  options={repoOptions}
                  onChange={(e) => {
                    const next = new URLSearchParams(params);
                    if (e.target.value) next.set('repo', e.target.value); else next.delete('repo');
                    // A new scope drops the selection made inside the old one.
                    next.delete('item'); next.delete('sample'); next.delete('run');
                    setParams(next, { replace: true });
                  }}
                  data-testid="distillation-repo"
                />
              )}
              data-testid="distillation-header"
            />
            <Stack gap="none" className="min-h-0 flex-1">
              {/* Tabs refresh the header's live counts after their own writes (a
                  verdict changes Review's pending count) without waiting for the
                  channel or the poll. */}
              <Outlet context={{ refreshReview: review.refresh, refreshLevels: levels.refresh } satisfies DistillationOutletContext} />
            </Stack>
          </Stack>
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
