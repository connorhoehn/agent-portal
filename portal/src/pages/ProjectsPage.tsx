import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  CatalogGrid,
  EmptyState,
  FilterChip,
  PageSection,
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonCard,
  StatStrip,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch';
import { UnavailableNotice } from '../components/UnavailableNotice';
import { useSession } from '../lib/auth';
import { useUrlState } from '../lib/useUrlState';
import { InitiativeCard } from './projects/InitiativeCard';
import { ProjectTable } from './projects/ProjectTable';
import { SprintsLens } from './projects/SprintsLens';
import {
  SPEND_MONTH,
  SORT_OPTIONS,
  STATUS_LABELS,
  compareProjects,
  filterByStatus,
  matchesQuery,
  programTotals,
  usd,
  visibleStatusOptions,
  type ProjectSortKey,
} from './projects/projectFormat';
import type { ProjectSummary } from './projects/types';

// The program dashboard: every initiative with its people, its live agent
// activity, its delivery progress and its money — the SAFe-style "one wall for
// the whole program" view. This file is the shell: fetch (polled — the live
// column has to move), scope/filter/sort state, the KPI strip, and which child
// list is mounted. Card, row, and every derivation live in ./projects/.

type ViewMode = 'grid' | 'list';
type Scope = 'all' | 'mine';

const VIEW_OPTIONS = [
  { value: 'grid', label: 'Cards' },
  { value: 'list', label: 'List' },
];

/** Live-ish: agents start and finish runs on the order of minutes, so the
 *  activity column refreshes itself rather than waiting for a reload. */
const POLL_MS = 15_000;

// Same cadence TiersPage.tsx set for this exact pattern.
const SEARCH_DEBOUNCE_MS = 250;

function ProjectsPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  // ?lens= — the page's two zooms on the same program: the initiatives wall
  // (default) and their sprints. Sprints are a lens here, not a place: the old
  // standalone /iq/sprints redirects in. Deeper sprint/PI planning is a future
  // tool, deliberately not more stacking on this page.
  const [searchParams, setSearchParams] = useSearchParams();
  const lens = searchParams.get('lens') === 'sprints' ? 'sprints' : 'initiatives';
  const switchLens = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v === 'sprints') next.set('lens', 'sprints'); else next.delete('lens');
    setSearchParams(next, { replace: true });
  };

  // Leadership and the program owner land on the whole program; an SME lands
  // on their own slice — the same default /api/sprints resolves.
  const isLeader = session?.role === 'org-leader' || session?.role === 'hr-admin'
    || session?.role === 'program-owner' || session?.role === 'admin';
  // Filters live in the URL — `?scope=&status=&sort=&q=` — so a filtered
  // program wall is a shareable link and survives a reload the way `?lens=`
  // already did above. `scope`'s default still depends on the session
  // (leaders default to everyone, everyone else to their own slice), so an
  // absent `?scope=` resolves through `isLeader` rather than a fixed literal.
  const [scope, setScope] = useUrlState<Scope>(
    'scope',
    (raw) => (raw === 'all' || raw === 'mine' ? raw : (isLeader ? 'all' : 'mine')),
    (v) => v,
  );
  const [statusFilter, setStatusFilter] = useUrlState<string>(
    'status',
    (raw) => raw ?? 'all',
    (v) => (v === 'all' ? null : v),
  );
  const [query, setQuery] = useUrlState<string>(
    'q',
    (raw) => raw ?? '',
    (v) => (v ? v : null),
  );
  const { searchText, onSearchChange, cancelPending: cancelSearchPending } =
    useDebouncedSearch(query, setQuery, SEARCH_DEBOUNCE_MS);
  const [sortKey, setSortKey] = useUrlState<ProjectSortKey>(
    'sort',
    (raw) => (SORT_OPTIONS.some((o) => o.value === raw) ? (raw as ProjectSortKey) : 'activity'),
    (v) => (v === 'activity' ? null : v),
  );
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('projects-view') as ViewMode) ?? 'grid'; } catch { return 'grid'; }
  });

  function switchView(mode: string) {
    setViewMode(mode as ViewMode);
    try { localStorage.setItem('projects-view', mode); } catch { /* ignore */ }
  }

  const { data, isLoading, error, degraded, refresh } = useFetch<ProjectSummary[]>(
    lens === 'initiatives' ? `/api/graph/projects?limit=100&scope=${scope}` : null, POLL_MS);
  const projectsFailure = error ?? degraded;

  const projects = useMemo(() => data ?? [], [data]);
  const totals = useMemo(() => programTotals(projects), [projects]);
  const statusOptions = useMemo(() => visibleStatusOptions(projects), [projects]);
  const filtered = useMemo(
    () => filterByStatus(projects, statusFilter)
      .filter(p => matchesQuery(p, query))
      .sort((a, b) => compareProjects(a, b, sortKey)),
    [projects, statusFilter, query, sortKey],
  );

  const openProject = (project: ProjectSummary) => navigate(`/iq/projects/${project.id}`);

  // Loading is handled inline, below, in the list body — the title, KPI
  // strip and toolbar stay mounted (see the shared list-page pattern comment
  // at the CatalogGrid/skeleton branch) so the page doesn't jump when data
  // arrives. Only a hard failure with nothing to show bails out of the frame
  // entirely, since there's nothing for the toolbar to filter.
  if (lens === 'initiatives' && projectsFailure && !data) {
    return (
      <UnavailableNotice
        error={projectsFailure}
        what="initiatives"
        source="Initiatives are read from the org graph"
        onRetry={refresh}
      />
    );
  }

  const velocityPct = totals.pointsTotal > 0
    ? Math.round((totals.pointsDone / totals.pointsTotal) * 100)
    : null;

  return (
    <PageSection
      title="Initiatives"
      actions={
        <>
          <SegmentedControl
            size="sm"
            value={lens}
            onChange={switchLens}
            options={[
              { label: 'Initiatives', value: 'initiatives' },
              { label: 'Sprints', value: 'sprints' },
            ]}
          />
          <SegmentedControl options={VIEW_OPTIONS} value={viewMode} onChange={switchView} size="sm" />
        </>
      }
    >
      {lens === 'sprints' ? <SprintsLens view={viewMode} /> : <>
      {/* ── Program rollup — one compact strip, not a wall of tiles ────── */}
      <StatStrip
        aria-label="Program rollup"
        items={[
          {
            label: 'Agents active',
            value: totals.agentsActive,
            ...(totals.agentsActive > 0 ? { tone: 'accent' as const } : {}),
            // Describes the SAME number the tile shows — how many
            // initiatives those active runs are spread across — not the
            // unrelated count of initiatives whose status happens to be
            // active/in_progress (that lives on its own tile below).
            hint: totals.agentsActiveInitiatives > 0
              ? `on ${totals.agentsActiveInitiatives} initiative${totals.agentsActiveInitiatives === 1 ? '' : 's'}`
              : 'none running',
          },
          {
            label: 'Active initiatives',
            value: totals.inFlight,
            hint: totals.planning > 0
              ? `${totals.planning} planning`
              : `${projects.length} total`,
          },
          {
            label: 'Open work',
            value: totals.openStories + totals.openBugs,
            ...(totals.criticalCount > 0 ? { tone: 'danger' as const } : {}),
            hint: totals.criticalCount > 0
              ? `${totals.criticalCount} critical`
              : `${totals.openStories} stories · ${totals.openBugs} bugs`,
          },
          {
            label: 'Delivered',
            value: velocityPct != null ? `${velocityPct}%` : '—',
            hint: totals.pointsTotal > 0 ? `${totals.pointsDone}/${totals.pointsTotal} pts` : 'nothing estimated',
          },
          {
            label: `Spend · ${SPEND_MONTH.split(' ')[0]}`,
            value: usd(totals.spendUsd),
            ...(totals.allocatedUsd > 0 && totals.spendUsd > totals.allocatedUsd ? { tone: 'danger' as const } : {}),
            hint: totals.allocatedUsd > 0 ? `of ${usd(totals.allocatedUsd)} allocated` : 'no allocations',
          },
        ]}
      />

      {/* ── Filters — on the list they filter. Labeled groups + divided
             separators (the KBRegistry composition): "Show" scopes to the
             person, "Status" filters the rows, search matches text, and the
             sort verb sits alone in the end slot. Without the labels the row
             read as two unrelated "All" buttons. */}
      <Toolbar
        size="md"
        aria-label="Initiative filters"
        end={
          <ToolbarGroup aria-label="Sort">
            <ToolbarLabel>Sort</ToolbarLabel>
            <Select
              size="sm"
              value={sortKey}
              onChange={e => setSortKey(e.target.value as ProjectSortKey)}
              options={SORT_OPTIONS}
              aria-label="Sort initiatives"
            />
          </ToolbarGroup>
        }
      >
        <ToolbarGroup aria-label="Scope">
          <ToolbarLabel>Show</ToolbarLabel>
          <SegmentedControl
            size="sm"
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              { label: 'Everyone', value: 'all' },
              { label: 'Mine', value: 'mine' },
            ]}
          />
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Status">
          <ToolbarLabel>Status</ToolbarLabel>
          {statusOptions.map(s => (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} size="sm">
              {STATUS_LABELS[s] ?? s}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Search">
          <SearchInput
            value={searchText}
            onChange={onSearchChange}
            placeholder="Name, owner, SME, repo…"
            aria-label="Search initiatives"
            className="w-[190px]"
            inputClassName="h-7 text-[12px]"
          />
        </ToolbarGroup>
      </Toolbar>

      {/* List-page pattern: the frame above (title, KPI strip, toolbar) stays
          mounted through every state. First load fills the body with
          skeleton cards instead of blanking the page; a background refetch
          (isLoading true but `data` already populated) leaves the existing
          list on screen and swaps it in place when the new page lands — it
          never re-shows the skeleton or drops back to a bare loader. */}
      {isLoading && !data ? (
        <CatalogGrid columns={3} dense>
          {[1, 2, 3, 4, 5, 6].map(i => <SkeletonCard key={i} height={190} />)}
        </CatalogGrid>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={scope === 'mine' && projects.length === 0 ? 'Nothing linked to you' : 'No matching initiatives'}
          description={scope === 'mine' && projects.length === 0
            ? 'No initiative lists you as owner or contributor — or your sign-in is not linked to a person in the org graph (Identity → Users fixes that).'
            : 'No initiative matches the current filters.'}
          actionLabel={scope === 'mine' && projects.length === 0 ? 'Show all initiatives' : 'Clear filters'}
          onAction={() => {
            if (scope === 'mine' && projects.length === 0) { setScope('all'); return; }
            cancelSearchPending();
            setStatusFilter('all'); setQuery('');
          }}
        />
      ) : viewMode === 'list' ? (
        <ProjectTable projects={filtered} onOpen={openProject} />
      ) : (
        // Fixed column count, never auto-fit: `auto-fit minmax()` stretches two
        // lopsided cards across half the screen.
        <CatalogGrid columns={3} dense>
          {filtered.map(project => (
            <InitiativeCard key={project.id} project={project} onClick={() => openProject(project)} />
          ))}
        </CatalogGrid>
      )}
      </>}
    </PageSection>
  );
}

export default ProjectsPage;
