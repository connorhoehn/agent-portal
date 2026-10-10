// Build → Distillation: one module frame over the three destinations of
// docs/distillation-redesign-spec.md §1 — Knowledge / Review / Activity.
//
// Navigation is a vertical sub-nav (SubNavLayout, as the Overview and Tiers
// mockups draw it): groups Knowledge / Review / Activity, each listing the
// views inside it with live counts — Guides & findings / Patterns / Run notes,
// Pending / Reviewed, Runs (warning accent while a tier is behind) / Tier
// graph. The IA doc's horizontal tabs were dropped for it: one navigation,
// not two. Every destination's content column is the same cascade
// (docs/layout-cascade.md): the module hands the crumbs, the repository
// facet (`?repo=`, carried by every rail link) and "Agent library ↗" down
// (`scope` in the outlet context). A destination with a list (Knowledge's
// explorer, the review queue, the promotion candidates, the runs) draws
// `ListRailLayout` (the library list rail): the list is a flush list rail stacked beside this
// section rail — the Initiatives rail's structure — with the repository in
// its filter popover beside its search, and the content column (the trail
// as a `ScopeHeader variant="crumbs"` band, the title, the record) after it.
// The content header carries no repository button. Flush over a
// ViewportFillRegion.
import { useMemo } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ViewportFillRegion, type BreadcrumbItem, type WorkListFilterFacet } from '@connorhoehnslalom/ui-components';
import {
  Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem,
} from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { SectionContent } from '../../components/shell/SectionContent';
import { DistillationOverview } from './DistillationOverview';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { activeNavId, moduleNav } from './moduleNavModel';
import { queueCounts } from './reviewQueueModel';
import { activityDot, tierCount } from './tierFlowModel';
import type { PromotionCandidate } from '../promotions/types';
import type { FacetsResponse, ReviewSampleWithTarget, TierLevelsResponse } from './types';

/** What the module hands its tabs through the route outlet. */
export interface DistillationOutletContext {
  refreshReview: () => void;
  refreshPromotions: () => void;
  refreshLevels: () => void;
  /** The module's crumbs, the repository facet for a list rail's filter
   *  popover, and the Library link (only where it leads somewhere: Knowledge,
   *  where guides become assets, and Asset promotions). */
  scope: {
    breadcrumbs: BreadcrumbItem[];
    repoFacet: WorkListFilterFacet;
    link: { label: string; href: string };
  };
}

const LIBRARY_LINK = { label: 'Agent library ↗', href: '/iq/library' };

export default function DistillationModule() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const crumbs = useShellBreadcrumbItems();
  const repo = params.get('repo') || null;
  const { can, ready } = useCapabilities();
  const canReview = ready && can('ManageBots');

  const review = useDistillationChannel<{ samples?: ReviewSampleWithTarget[]; counts?: { pending: number; decided?: number } }>('distill:review');
  const promotions = useFetch<{ candidates: PromotionCandidate[] }>('/api/promotions', 30_000);
  const promotionCount = promotions.data?.candidates.filter((c) => (c.status === 'candidate' || c.status === 'approved') && (!repo || c.observations.some((o) => o.repo === repo))).length;
  const levels = useDistillationChannel<TierLevelsResponse>('distill:levels');
  const facets = useFetch<FacetsResponse>('/api/distillation/facets', 0);

  // The live count frame wins over the snapshot's own list when present.
  const counts = review.data?.samples ? queueCounts(repo ? review.data.samples.filter((sample) => !sample.target?.repo || sample.target.repo === repo) : review.data.samples) : null;
  const pending = repo ? counts?.pending : review.data?.counts?.pending ?? counts?.pending;
  const decided = repo ? counts?.decided : review.data?.counts?.decided ?? counts?.decided;
  const dot = useMemo(
    () => (levels.data ? activityDot(levels.data.levels ?? [], levels.data.health) : null),
    [levels.data],
  );
  const digest = (lv: 'L0' | 'L1' | 'L2') => levels.data?.levels?.find((l) => l.level === lv)?.digest ?? null;
  const tier = (lv: 'L0' | 'L1' | 'L2') => {
    const row = levels.data?.levels?.find((l) => l.level === lv);
    return row ? tierCount(row) : null;
  };

  const entries = moduleNav(
    { L0: tier('L0'), L1: tier('L1'), L2: tier('L2'), pending, decided, promotions: promotionCount, health: dot },
    repo,
    canReview,
  );
  const activeId = params.get('nav') === 'distillation' ? null : activeNavId(location.pathname, location.search);
  const items: SubNavItem[] = entries.map((e) => ({
    path: e.path,
    label: e.label,
    group: e.group,
    // No hint line: the mockups' rail is single-line entries, and a hint under
    // every item doubled its height. The hint becomes the link's tooltip below.
    ...(e.count != null ? { count: e.count } : {}),
    ...(e.accent ? { accent: e.accent } : {}),
  }));

  const repoLabels = new Map((facets.data?.repos ?? []).map((r) => [r.value, r.label]));
  for (const candidate of promotions.data?.candidates ?? []) {
    for (const observation of candidate.observations) {
      if (observation.repo && !repoLabels.has(observation.repo)) repoLabels.set(observation.repo, observation.repo);
    }
  }
  // A deep link can name a repository before either source lists it.
  if (repo && !repoLabels.has(repo)) repoLabels.set(repo, repo);
  const repoOptions = [...repoLabels].map(([value, label]) => ({ value, label }));

  // The repository scope lives in each list rail's filter popover, beside its
  // search (never as a button in the content header). Same `?repo=` param;
  // a new scope drops the selection made inside the old one.
  const repoFacet: WorkListFilterFacet = {
    id: 'repo', label: 'Repository',
    options: repoOptions,
    selected: repo ? [repo] : [],
    onChange: (sel) => {
      const value = sel.length > 0 ? sel[sel.length - 1] : null;
      const next = new URLSearchParams(params);
      if (value) next.set('repo', value); else next.delete('repo');
      next.delete('item'); next.delete('sample'); next.delete('run');
      setParams(next, { replace: true });
    },
  };
  const atModule = location.pathname.startsWith('/iq/distillation/knowledge') && params.get('nav') === 'distillation';
  const moduleHref = `/iq/distillation/knowledge?${new URLSearchParams({ nav: 'distillation', ...(repo ? { repo } : {}) })}`;
  const breadcrumbs = crumbs.map((crumb) => crumb.label === 'Distillation' ? {
    label: crumb.label,
    href: moduleHref,
    onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(moduleHref);
    },
  } : crumb);

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
          {/* The content column (docs/layout-cascade.md): a destination with
              a list draws ListRailLayout (the list rail flush beside this
              rail, then trail → title → record); the module's own landing is
              SectionContent over an overview of the three tiers, never a
              placeholder. */}
          {atModule ? (
            <SectionContent
              breadcrumbs={[{ label: 'Build' }, { label: 'Distillation' }]}
              link={LIBRARY_LINK}
              title="Distillation"
              description="What the fleet has learned from its runs: notes compact into patterns, patterns into reusable guides."
              data-testid="distillation-landing"
            >
              <DistillationOverview
                repo={repo}
                counts={{ guides: tier('L2'), patterns: tier('L1'), notes: tier('L0') }}
                versions={{ guides: digest('L2'), patterns: digest('L1'), notes: digest('L0') }}
                pending={pending}
                canPlay={canReview}
                onDemoChanged={() => { levels.refresh(); review.refresh(); }}
              />
            </SectionContent>
          ) : (
            // Tabs refresh the rail's live counts after their own writes (a
            // verdict changes Review's pending count) without waiting for the
            // channel or the poll.
            <Outlet
              context={{
                refreshReview: review.refresh,
                refreshPromotions: promotions.refresh,
                refreshLevels: levels.refresh,
                scope: { breadcrumbs, repoFacet, link: LIBRARY_LINK },
              } satisfies DistillationOutletContext}
            />
          )}
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
