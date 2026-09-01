import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  CatalogGrid,
  EmptyState,
  ErrorState,
  FilterChip,
  PageSection,
  SegmentedControl,
  SkeletonCard,
  Toolbar,
  ToolbarGroup,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { InitiativeCard } from './projects/InitiativeCard';
import { ProjectTable } from './projects/ProjectTable';
import {
  SPEND_MONTH,
  STATUS_LABELS,
  filterByStatus,
  visibleStatusOptions,
} from './projects/projectFormat';
import type { ProjectSummary } from './projects/types';

// The shell: fetch, filter state, view state, and which child is mounted.
// Card, row, status pill and every derivation live in ./projects/.

type ViewMode = 'grid' | 'list';

const VIEW_OPTIONS = [
  { value: 'grid', label: 'Cards' },
  { value: 'list', label: 'List' },
];

function ProjectsPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useFetch<ProjectSummary[]>('/api/graph/projects?limit=100');
  const [statusFilter, setStatusFilter] = useState('all');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('projects-view') as ViewMode) ?? 'grid'; } catch { return 'grid'; }
  });

  function switchView(mode: string) {
    setViewMode(mode as ViewMode);
    try { localStorage.setItem('projects-view', mode); } catch { /* ignore */ }
  }

  const projects = useMemo(() => data ?? [], [data]);
  const statusOptions = useMemo(() => visibleStatusOptions(projects), [projects]);
  const filtered = useMemo(() => filterByStatus(projects, statusFilter), [projects, statusFilter]);

  const openProject = (project: ProjectSummary) => navigate(`/iq/projects/${project.id}`);

  if (isLoading) {
    return (
      <CatalogGrid columns={3} dense>
        {[1, 2, 3, 4, 5, 6].map(i => <SkeletonCard key={i} height={190} />)}
      </CatalogGrid>
    );
  }

  if (error) {
    return <ErrorState title="Failed to load projects" description={error} />;
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Run `python schema/seed.py` to seed Aurora."
      />
    );
  }

  return (
    <PageSection
      title="Projects"
      description={`Initiatives: who runs each one, the work in flight, and what agents have spent delivering it so far in ${SPEND_MONTH}.`}
      // The header holds only the view verb. Filters belong with the list they
      // filter, not stacked into the page title row.
      actions={<SegmentedControl options={VIEW_OPTIONS} value={viewMode} onChange={switchView} size="sm" />}
    >
      <Toolbar aria-label="Project filters">
        <ToolbarGroup>
          {statusOptions.map(s => (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} size="sm">
              {STATUS_LABELS[s] ?? s}
            </FilterChip>
          ))}
        </ToolbarGroup>
      </Toolbar>

      {filtered.length === 0 ? (
        <EmptyState
          title="No matching projects"
          description="No projects match the selected filter."
          actionLabel="Clear filter"
          onAction={() => setStatusFilter('all')}
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
    </PageSection>
  );
}

export default ProjectsPage;
