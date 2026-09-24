// Build → Distillation: one module frame over the three destinations of
// docs/distillation-redesign-spec.md §1 — Knowledge / Review / Activity as
// horizontal tabs in a ScopeHeader, flush over a ViewportFillRegion, no
// second rail.
//
// The header carries live data only: Review's pending count (distill:review)
// and Activity's warning dot (distill:levels health — the server's verdict,
// never inferred), a repository selector (`?repo=`, carried across tabs) in
// the `controls` slot, and "Open Library ↗".
import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ScopeHeader, ViewportFillRegion, type ScopeHeaderTab } from '@connorhoehnslalom/ui-components';
import { Select, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';

/** What the module hands its tabs through the route outlet. */
export interface DistillationOutletContext {
  refreshReview: () => void;
  refreshLevels: () => void;
}
import { useFetch } from '../../hooks/useFetch';
import { tabForPath, tabHref, type DistillationTab } from './distillationRoutes';
import { queueCounts } from './reviewQueueModel';
import { activityDot } from './tierFlowModel';
import type { FacetsResponse, ReviewSampleWithTarget, TierLevelsResponse } from './types';

export default function DistillationModule() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const crumbs = useShellBreadcrumbItems();
  const active = tabForPath(location.pathname) ?? 'knowledge';
  const repo = params.get('repo') || null;

  const review = useDistillationChannel<{ samples?: ReviewSampleWithTarget[]; counts?: { pending: number } }>('distill:review');
  const levels = useDistillationChannel<TierLevelsResponse>('distill:levels');
  const facets = useFetch<FacetsResponse>('/api/distillation/facets', 0);

  // The live count frame wins over the snapshot's own list when present.
  const pending = review.data?.counts?.pending
    ?? (review.data?.samples ? queueCounts(review.data.samples).pending : undefined);
  const dot = useMemo(
    () => (levels.data ? activityDot(levels.data.levels ?? [], levels.data.health) : null),
    [levels.data],
  );

  const tabs: ScopeHeaderTab[] = [
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'review', label: 'Review', count: pending },
    { id: 'activity', label: 'Activity', dot: dot ?? undefined },
  ];

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
        <ScopeHeader
          breadcrumbs={crumbs}
          title="Distillation"
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
          tabs={tabs}
          activeTab={active}
          onTabChange={(id) => navigate(tabHref(id as DistillationTab, repo))}
          data-testid="distillation-header"
        />
        <Stack gap="none" className="min-h-0 flex-1">
          {/* Tabs refresh the header's live counts after their own writes (a
              verdict changes Review's pending count) without waiting for the
              channel or the poll. */}
          <Outlet context={{ refreshReview: review.refresh, refreshLevels: levels.refresh } satisfies DistillationOutletContext} />
        </Stack>
      </Stack>
    </ViewportFillRegion>
  );
}
