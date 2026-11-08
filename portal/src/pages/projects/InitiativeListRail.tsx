// The Initiatives explorer column (v2, docs/design/initiative-v2-plan.md
// R1–R7): "INITIATIVES 11" with ⋯ and «, "Find an initiative…" directly under
// it, the scope list "All initiatives / My initiatives / Sprints", then status
// groups ("IN PROGRESS … 9") of title-only rows, and a footer. There is no +:
// nothing creates an initiative by hand (they come from ingestion), so a +
// would be a button with no action (V2).
//
// A hook rather than a component because the rail is one value of the library
// rail model (`ListRail`: title, count, actions, header, body, footer, label)
// and because the list route's pane reads the same list:
// `useInitiativeListRail()` returns the rail to hand to `<InitiativesExplorer>`
// plus the read and the URL state behind it, so the page never fetches the
// list twice or keeps a second copy of `?scope=`.
//
// URL state (shared by both routes): `?scope=all|mine` (default by role —
// leaders land on everyone, everyone else on their own slice), `?q=`,
// `?status=`, `?sort=`, and on the list route `?lens=sprints`.
//
// Honest numbers: counts come from `initiativeListModel` — the rows we hold,
// "N+" when the capped page came back full (then no header count at all), and
// a failed read shows the failure, never "Nothing linked yet".

import { landingScope } from './initiativeNavigation';
import { useMemo, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  DropdownMenu,
  EmptyState,
  GroupedList,
  LoadingState,
  MoreIcon,
  SearchInput,
  Stack,
  T,
  type DropdownMenuSection,
  type GroupedListRow,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useSession } from '../../lib/auth';
import { useUrlState } from '../../lib/useUrlState';
import type { ListRail } from '@connorhoehn/ui-components';
import {
  RAIL_NO_MATCH,
  buildInitiativeList,
  railEmptyCopy,
  type InitiativeListModel,
} from './initiativeListModel';
import {
  SORT_OPTIONS,
  STATUS_LABELS,
  visibleStatusOptions,
  type ProjectSortKey,
} from './projectFormat';
import type { ProjectSummary } from './types';
import type { Sprint, SprintsResponse } from '../sprints/types';
import { initiativeHref, initiativeListHref } from './initiativeNavigation';

export type InitiativeScope = 'all' | 'mine';
export type InitiativeLens = 'initiatives' | 'sprints';

/** The list read's page size; a full page means "there may be more". */
export const INITIATIVE_LIST_LIMIT = 100;

/** Initiatives change status (and so group) on the order of minutes, so the
 *  list refreshes itself rather than waiting for a reload. */
const POLL_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 250;

export const LEADER_ROLES = new Set(['org-leader', 'hr-admin', 'program-owner', 'admin']);

/** The Sprints lens's rail (list route only): the same read the lens pane shows. */
export interface SprintRailInput {
  data: SprintsResponse | null | undefined;
  error: string | null;
  openId: string | null;
  onOpen: (id: string) => void;
}

export interface InitiativeListRailOptions {
  /** The initiative the route has open — marked with the bar, its group opened. */
  currentId?: string | null;
  /**
   * The list route passes its sprints read so the Sprints tab lists sprints in
   * the rail. Without it (the detail route) choosing Sprints goes to
   * `/iq/projects?lens=sprints`.
   */
  sprints?: SprintRailInput | null;
  /**
   * Scope when `?scope=` is absent. The list route leaves it unset (leaders
   * default to Everyone, members to Mine); the detail route passes 'all' so
   * the initiative on screen is always in the rail, whoever is looking.
   */
  defaultScope?: InitiativeScope;
}

export interface InitiativeListRail {
  /** The list rail (`<InitiativesExplorer rail>`). */
  rail: ListRail;
  lens: InitiativeLens;
  scope: InitiativeScope;
  setScope: (next: InitiativeScope) => void;
  /** The list read, as fetched (`null` data while the first read is pending). */
  list: {
    data: ProjectSummary[] | null;
    error: string | null;
    isLoading: boolean;
    refresh: () => void;
  };
  model: InitiativeListModel;
  query: string;
  statusFilter: string;
  sort: ProjectSortKey;
  /** Clears search and the status filter (the "no match" action). */
  clearFilters: () => void;
}

const SPRINT_GROUPS = [
  { id: 'active', title: 'Active' },
  { id: 'planned', title: 'Planned', defaultOpen: false },
  { id: 'done', title: 'Done', defaultOpen: false },
] as const;

/** "Observability Platform · 0 / 21 pts". The short unit keeps the line
 *  inside the 264px rail (with "points", "Real-time Analytics Pipeline" cut
 *  at 215px); the full line rides along as the hover title in case a longer
 *  initiative name still clips. */
function sprintSubline(s: Sprint): string {
  const parts: string[] = [];
  if (s.orgProjectName) parts.push(s.orgProjectName);
  if (s.pointsTotal > 0) parts.push(`${s.pointsDone} / ${s.pointsTotal} pts`);
  return parts.join(' · ');
}

export function useInitiativeListRail(opts: InitiativeListRailOptions = {}): InitiativeListRail {
  const navigate = useNavigate();
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const lens: InitiativeLens = opts.sprints && searchParams.get('lens') === 'sprints' ? 'sprints' : 'initiatives';

  const isLeader = LEADER_ROLES.has(session?.role ?? '');
  const [scope] = useUrlState<InitiativeScope>(
    'scope',
    (raw) => (raw === 'all' || raw === 'mine' ? raw : (opts.defaultScope ?? landingScope(searchParams) ?? (isLeader ? 'all' : 'mine'))),
    (v) => v,
  );
  const [statusFilter, setStatusFilter] = useUrlState<string>('status', (raw) => raw ?? 'all', (v) => (v === 'all' ? null : v));
  const [query, setQuery] = useUrlState<string>('q', (raw) => raw ?? '', (v) => (v ? v : null));
  const [sort, setSort] = useUrlState<ProjectSortKey>(
    'sort',
    (raw) => (SORT_OPTIONS.some((o) => o.value === raw) ? (raw as ProjectSortKey) : 'activity'),
    (v) => (v === 'activity' ? null : v),
  );
  const { searchText, onSearchChange, cancelPending } = useDebouncedSearch(query, setQuery, SEARCH_DEBOUNCE_MS);

  const { data, isLoading, error, degraded, refresh } = useFetch<ProjectSummary[]>(
    // Not read while the Sprints lens has the column.
    lens === 'initiatives' ? `/api/graph/projects?limit=${INITIATIVE_LIST_LIMIT}&scope=${scope}` : null,
    POLL_MS,
    { share: true },
  );
  const failure = error ?? degraded ?? null;

  const model = useMemo(() => buildInitiativeList({
    rows: data,
    // A failed poll over rows we already hold keeps the rows; only a read
    // that never produced any is the error state.
    error: data ? null : failure,
    scope,
    limit: INITIATIVE_LIST_LIMIT,
    query,
    statusFilter,
    sort,
    currentId: opts.currentId ?? null,
  }), [data, failure, scope, query, statusFilter, sort, opts.currentId]);

  const setScope = (next: InitiativeScope) => navigate(initiativeListHref(searchParams, next));
  const clearFilters = () => {
    cancelPending();
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete('q');
      params.delete('status');
      return params;
    }, { replace: true });
  };

  const statusOptions = visibleStatusOptions(data ?? []);
  const menu: DropdownMenuSection[] = [
    {
      label: 'Sort',
      items: SORT_OPTIONS.map((o) => ({ label: o.label, checked: o.value === sort, onSelect: () => setSort(o.value) })),
    },
    {
      label: 'Status',
      items: statusOptions.map((s) => ({
        label: STATUS_LABELS[s] ?? s,
        checked: s === statusFilter,
        onSelect: () => setStatusFilter(s),
      })),
    },
  ];

  const header = lens === 'initiatives' ? (
    <SearchInput
      size="md"
      value={searchText}
      onChange={onSearchChange}
      placeholder="Find an initiative…"
      aria-label="Find an initiative"
      className="w-full"
    />
  ) : null;

  let body: ReactNode;
  let footer: string | null = null;
  let count: number | undefined;

  if (lens === 'sprints' && opts.sprints) {
    const sp = opts.sprints;
    const sprints = sp.data?.sprints ?? [];
    if (sp.error && !sp.data) {
      body = <Padded><UnavailableNotice error={sp.error} what="sprints" source="Sprints are read from Aurora" /></Padded>;
    } else if (!sp.data) {
      body = <LoadingState label="Loading sprints…" />;
    } else if (sprints.length === 0) {
      body = <Padded><EmptyState align="start" title="No sprints here" description="Nothing matches this view's scope and window." /></Padded>;
      footer = '0 sprints';
    } else {
      const rows: GroupedListRow[] = sprints.map((s) => ({
        id: s.id,
        groupId: SPRINT_GROUPS.some((g) => g.id === s.status) ? s.status : 'active',
        title: s.name,
        ...(sprintSubline(s) ? { subline: <T title={sprintSubline(s)}>{sprintSubline(s)}</T> } : {}),
      }));
      body = (
        <GroupedList
          size="md"
          currentStyle="bar"
          groupHeading="label"
          groupCountAlign="end"
          hideEmptyGroups
          currentId={sp.openId}
          groups={SPRINT_GROUPS.map((g) => ({ ...g, count: rows.filter((r) => r.groupId === g.id).length }))}
          rows={rows}
          onOpenRow={(row) => sp.onOpen(row.id)}
          data-testid="sprint-rail-list"
        />
      );
      footer = `${sprints.length} ${sprints.length === 1 ? 'sprint' : 'sprints'}`;
    }
  } else if (model.state === 'loading') {
    body = <LoadingState label="Loading initiatives…" />;
  } else if (model.state === 'error') {
    body = (
      <Padded>
        <UnavailableNotice
          error={model.error}
          what="initiatives"
          source="Initiatives are read from the org graph"
          onRetry={refresh}
          data-testid="initiative-rail-error"
        />
      </Padded>
    );
  } else {
    footer = model.footer;
    // The header count is the rows we hold; a capped page has no honest
    // total, so it goes without one and the footer says "100+".
    count = /\+$/.test(model.count) ? undefined : Number(model.count);
    if (model.state === 'empty') {
      const copy = railEmptyCopy(scope);
      body = (
        <Padded>
          <Stack gap="xs" data-testid="initiative-rail-empty">
            <T size="sm" className="font-medium leading-5">{copy.title}</T>
            <T size="sm" wrap className="leading-5 text-text-secondary">{copy.body}</T>
            {copy.action && <Button variant="link" size="sm" className="self-start px-0 text-left text-sm font-medium leading-5" onClick={() => setScope('all')}>{copy.action.label} →</Button>}
          </Stack>
        </Padded>
      );
    } else if (model.state === 'no-match') {
      body = (
        <Padded>
          <EmptyState
            align="start"
            title={RAIL_NO_MATCH.title}
            description={RAIL_NO_MATCH.body}
            actions={[{ label: 'Clear search and filters', variant: 'link', onClick: clearFilters }]}
          />
        </Padded>
      );
    } else {
      body = (
        <GroupedList
          // Remount when the scope changes so each scope starts from its own
          // default open groups rather than the last one's.
          key={scope}
          size="md"
          currentStyle="bar"
          groupHeading="label"
          groupCountAlign="end"
          rowStyle="plain"
          currentId={opts.currentId ?? null}
          groups={model.groups.map((g) => ({ id: g.id, title: g.title, count: g.count, defaultOpen: g.defaultOpen }))}
          // Title-only rows (V6). GroupedList puts the full name in the
          // title's `title=`, so a name clipped at 264px stays readable.
          rows={model.groups.flatMap((g) => g.rows.map((r) => ({ id: r.id, groupId: r.groupId, title: r.title })))}
          onOpenRow={(row) => {
            navigate(initiativeHref(row.id, searchParams, scope));
          }}
          data-testid="initiative-rail-list"
        />
      );
    }
  }

  const rail: ListRail = {
    title: lens === 'sprints' ? 'Sprints' : scope === 'all' ? 'All initiatives' : 'My initiatives',
    ...(lens === 'initiatives' && count != null ? { count } : {}),
    ...(lens === 'initiatives' ? {
      actions: (
        <DropdownMenu
          trigger={<MoreIcon size={18} />}
          triggerLabel="Initiative list options"
          triggerClassName="h-8 w-8 border-transparent px-0 py-0 text-text-secondary"
          align="end"
          sections={menu}
        />
      ),
    } : {}),
    header,
    body,
    ...(footer ? { footer: <T size="sm" className="text-text-secondary" data-testid="initiative-rail-footer">{footer}</T> } : {}),
    label: lens === 'sprints' ? 'sprints' : 'initiatives',
  };

  return {
    rail,
    lens,
    scope,
    setScope,
    list: { data: data ?? null, error: failure, isLoading, refresh },
    model,
    query,
    statusFilter,
    sort,
    clearFilters,
  };
}

/** The rail's own inset for a message (the list rows carry their own). */
function Padded({ children }: { children: ReactNode }) {
  return <Stack gap="none" className="px-5 py-3">{children}</Stack>;
}
