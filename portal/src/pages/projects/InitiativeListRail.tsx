// The Initiatives explorer column (F3–F10, M1–M2): "Initiatives 14" with ⋯
// and «, tabs Initiatives | Sprints, Everyone | Mine, "Find an initiative…",
// status groups of rows ("Nora DaSilva · 2 agents"), and a footer.
//
// A hook rather than a component because the frame's rail is several slots
// (title, count, actions, header, body, footer) and because the list route's
// pane reads the same list: `useInitiativeListRail()` returns the slots to
// spread into `<InitiativesExplorer>` plus the read and the URL state behind
// them, so the page never fetches the list twice or keeps a second copy of
// `?scope=`.
//
// URL state (shared by both routes): `?scope=all|mine` (default by role —
// leaders land on everyone, everyone else on their own slice), `?q=`,
// `?status=`, `?sort=`, and on the list route `?lens=sprints`.
//
// Honest numbers: counts come from `initiativeListModel` — the rows we hold,
// "N+" when the capped page came back full (then no header count at all), and
// a failed read shows the failure, never "Nothing linked yet".

import { useMemo, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  DropdownMenu,
  EmptyState,
  GroupedList,
  LoadingState,
  MoreIcon,
  SearchInput,
  SegmentedControl,
  Stack,
  T,
  Tabs,
  type DropdownMenuSection,
  type GroupedListRow,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useSession } from '../../lib/auth';
import { useUrlState } from '../../lib/useUrlState';
import type { ExplorerRailSlots } from './InitiativesExplorer';
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

export type InitiativeScope = 'all' | 'mine';
export type InitiativeLens = 'initiatives' | 'sprints';

/** The list read's page size; a full page means "there may be more". */
export const INITIATIVE_LIST_LIMIT = 100;

/** Agents start and finish runs on the order of minutes, so the "· 2 agents"
 *  sublines refresh themselves rather than waiting for a reload. */
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
}

export interface InitiativeListRail {
  /** Spread into `<InitiativesExplorer>`. */
  slots: ExplorerRailSlots;
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

function sprintSubline(s: Sprint): string {
  const parts: string[] = [];
  if (s.orgProjectName) parts.push(s.orgProjectName);
  if (s.pointsTotal > 0) parts.push(`${s.pointsDone} / ${s.pointsTotal} points`);
  return parts.join(' · ');
}

export function useInitiativeListRail(opts: InitiativeListRailOptions = {}): InitiativeListRail {
  const navigate = useNavigate();
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const lens: InitiativeLens = opts.sprints && searchParams.get('lens') === 'sprints' ? 'sprints' : 'initiatives';

  const isLeader = LEADER_ROLES.has(session?.role ?? '');
  const [scope, setScope] = useUrlState<InitiativeScope>(
    'scope',
    (raw) => (raw === 'all' || raw === 'mine' ? raw : (isLeader ? 'all' : 'mine')),
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

  const clearFilters = () => { cancelPending(); setStatusFilter('all'); setQuery(''); };

  // Rows carry scope and search along, so opening one keeps the column as it was.
  const keep = new URLSearchParams();
  for (const k of ['scope', 'q', 'status', 'sort']) {
    const v = searchParams.get(k);
    if (v) keep.set(k, v);
  }
  const suffix = keep.toString() ? `?${keep.toString()}` : '';

  const switchLens = (next: string) => {
    if (next === lens) return;
    if (!opts.sprints) {
      navigate(next === 'sprints' ? '/iq/projects?lens=sprints' : `/iq/projects${suffix}`);
      return;
    }
    const params = new URLSearchParams(searchParams);
    if (next === 'sprints') params.set('lens', 'sprints'); else params.delete('lens');
    setSearchParams(params, { replace: true });
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

  const header = (
    <Stack gap="md">
      <Tabs
        variant="underline"
        size="md"
        value={lens}
        onValueChange={switchLens}
        items={[{ id: 'initiatives', label: 'Initiatives' }, { id: 'sprints', label: 'Sprints' }]}
        aria-label="Initiatives lens"
      />
      {lens === 'initiatives' ? (
        <>
          <SegmentedControl
            fullWidth
            value={scope}
            onChange={(v) => setScope(v as InitiativeScope)}
            options={[{ value: 'all', label: 'Everyone' }, { value: 'mine', label: 'Mine' }]}
            aria-label="Whose initiatives"
          />
          <SearchInput
            size="md"
            value={searchText}
            onChange={onSearchChange}
            placeholder="Find an initiative…"
            aria-label="Find an initiative"
            className="w-full"
          />
        </>
      ) : null}
    </Stack>
  );

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
      body = <Padded><EmptyState align="start" size="sm" title="No sprints here" description="Nothing matches this view's scope and window." /></Padded>;
      footer = '0 sprints';
    } else {
      const rows: GroupedListRow[] = sprints.map((s) => ({
        id: s.id,
        groupId: SPRINT_GROUPS.some((g) => g.id === s.status) ? s.status : 'active',
        title: s.name,
        subline: sprintSubline(s) || undefined,
      }));
      body = (
        <GroupedList
          size="md"
          currentStyle="bar"
          groupCountStyle="plain"
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
          <EmptyState
            align="start"
            size="sm"
            title={copy.title}
            description={copy.body}
            testId="initiative-rail-empty"
            {...(copy.action ? { actions: [{ label: `${copy.action.label} →`, variant: 'link' as const, onClick: () => setScope('all') }] } : {})}
          />
        </Padded>
      );
    } else if (model.state === 'no-match') {
      body = (
        <Padded>
          <EmptyState
            align="start"
            size="sm"
            title={RAIL_NO_MATCH.title}
            description={RAIL_NO_MATCH.body}
            actions={[{ label: 'Clear search and filters', variant: 'link', onClick: clearFilters }]}
          />
        </Padded>
      );
    } else {
      const hrefOf = new Map(model.groups.flatMap((g) => g.rows.map((r) => [r.id, r.href] as const)));
      body = (
        <GroupedList
          // Remount when the scope changes so each scope starts from its own
          // default open groups rather than the last one's.
          key={scope}
          size="md"
          currentStyle="bar"
          groupCountStyle="plain"
          currentId={opts.currentId ?? null}
          groups={model.groups.map((g) => ({ id: g.id, title: g.title, count: g.count, defaultOpen: g.defaultOpen }))}
          rows={model.groups.flatMap((g) => g.rows.map((r) => ({
            id: r.id,
            groupId: r.groupId,
            title: r.title,
            ...(r.subline ? { subline: r.subline } : {}),
          })))}
          onOpenRow={(row) => {
            const href = hrefOf.get(row.id);
            if (href) navigate(`${href}${suffix}`);
          }}
          data-testid="initiative-rail-list"
        />
      );
    }
  }

  const slots: ExplorerRailSlots = {
    railTitle: 'Initiatives',
    ...(lens === 'initiatives' && count != null ? { railCount: count } : {}),
    railActions: lens === 'initiatives' ? (
      <DropdownMenu
        trigger={<MoreIcon size={18} />}
        triggerLabel="Initiative list options"
        triggerClassName="h-8 w-8 border-transparent px-0 py-0 text-text-secondary"
        align="end"
        sections={menu}
      />
    ) : undefined,
    railHeader: header,
    rail: body,
    railFooter: footer ? <T className="text-[13px] text-text-secondary" data-testid="initiative-rail-footer">{footer}</T> : undefined,
    collapsible: true,
    railLabel: 'initiatives',
  };

  return {
    slots,
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
