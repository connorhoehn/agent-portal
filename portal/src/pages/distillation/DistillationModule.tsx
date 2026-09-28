// Build → Distillation: one module frame over the three destinations of
// docs/distillation-redesign-spec.md §1 — Knowledge / Review / Activity.
//
// Navigation is a vertical sub-nav (SubNavLayout, as the Overview and Tiers
// mockups draw it): groups Knowledge / Review / Activity, each listing the
// views inside it with live counts — Guides & findings / Patterns / Run notes,
// Pending / Reviewed, Runs (warning accent while a tier is behind) / Tier
// graph. The IA doc's horizontal tabs were dropped for it: one navigation,
// not two. On Review and Activity the ScopeHeader above the content names the
// destination and keeps the repository selector (`?repo=`, carried by every
// rail link) and "Open Library ↗". Knowledge has no title band: its record's
// own headline is the page title, so the module hands the crumbs, the selector
// and the link down (`scope` in the outlet context) and Knowledge hangs them
// at the top of its content pane (`ScopeHeader variant="crumbs"`), the guide
// record mockup (docs/distillation-guide-record-spec.md). Flush over a
// ViewportFillRegion.
import { useMemo, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ScopeHeader, ViewportFillRegion, type BreadcrumbItem } from '@connorhoehnslalom/ui-components';
import {
  EmptyState, Select, Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem,
} from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { activeNavId, destinationTitle, moduleNav } from './moduleNavModel';
import { queueCounts } from './reviewQueueModel';
import { activityDot, tierCount } from './tierFlowModel';
import type { PromotionCandidate } from '../promotions/types';
import type { FacetsResponse, ReviewSampleWithTarget, TierLevelsResponse } from './types';

/** What the module hands its tabs through the route outlet. */
export interface DistillationOutletContext {
  refreshReview: () => void;
  refreshPromotions: () => void;
  refreshLevels: () => void;
  /** The module's crumbs, repository selector and Library link, for a tab
   *  that draws them itself (Knowledge, at the top of its content pane). */
  scope: {
    breadcrumbs: BreadcrumbItem[];
    controls: ReactNode;
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
  const repoOptions = [
    { value: '', label: 'All repositories' },
    ...[...repoLabels].map(([value, label]) => ({ value, label })),
  ];

  const repoSelect = (
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
  );
  // Knowledge draws its own crumb line (see the header comment).
  const onKnowledge = location.pathname.startsWith('/iq/distillation/knowledge');
  const onPromotions = location.pathname.startsWith('/iq/distillation/review') && params.get('view') === 'promotions';
  const atModule = onKnowledge && params.get('nav') === 'distillation';
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
          <Stack gap="none" className="h-full min-h-0">
            {((!onKnowledge && !onPromotions) || atModule) && (
              <ScopeHeader
                breadcrumbs={atModule ? [{ label: 'Build' }, { label: 'Distillation' }] : breadcrumbs}
                title={atModule ? 'Distillation' : destinationTitle(location.pathname)}
                link={LIBRARY_LINK}
                controls={repoSelect}
                data-testid="distillation-header"
              />
            )}
            <Stack gap="none" className="min-h-0 flex-1">
              {/* Tabs refresh the header's live counts after their own writes (a
                  verdict changes Review's pending count) without waiting for the
                  channel or the poll. */}
              {atModule ? <EmptyState size="sm" title="Explore distillation" description="Choose Guides & findings, Patterns or Run notes to open Knowledge, or browse Review and Activity." /> : <Outlet
                context={{
                  refreshReview: review.refresh,
                  refreshPromotions: promotions.refresh,
                  refreshLevels: levels.refresh,
                  scope: { breadcrumbs, controls: repoSelect, link: LIBRARY_LINK },
                } satisfies DistillationOutletContext}
              />}
            </Stack>
          </Stack>
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
