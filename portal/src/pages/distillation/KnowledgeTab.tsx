// Distillation → Knowledge (spec §1): explorer · record · optional Sources.
//
//   rail    SearchInput (scoped to the view, and saying so) · view Select
//           "Guides & findings 11 / Patterns 22 / Run notes 304" · filter
//           popover (WorkListFilters over GET /facets) · GroupedList rows ·
//           footer "N of M loaded" + cursor Load more
//   pane    KnowledgeRecord on EditorShell, with the explain-only composer
//   aside   ContextColumn → SourcesPanel (List | Graph)
//
// All state lives in the URL (distillationRoutes.parseKnowledge), so every
// migrated link lands with its selection and filters, and following a source
// pushes history — Back returns to the record and filters you left.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ContextColumn, ExplorerLayout, WorkListFilters, type ContextColumnState, type WorkListFilterFacet,
} from '@connorhoehnslalom/ui-components';
import {
  Button, EmptyState, FileKindMark, FilterPopover, GroupedList, Inline, LinkIcon, LoadingState, SearchInput,
  Select, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import { useFetch } from '../../hooks/useFetch';
import {
  knowledgeHref, levelForView, parseKnowledge, viewForLevel, type KnowledgeState, type KnowledgeView,
} from './distillationRoutes';
import { KnowledgeRecord } from './KnowledgeRecord';
import {
  LIFECYCLE_OPTIONS, VIEWS, VIEW_LABEL, VIEW_NOUN, explorerGroups, explorerRows, loadedLabel, searchPlaceholder,
  searchScopeNote,
} from './knowledgeModel';
import { SourcesPanel, useItemSources } from './SourcesPanel';
import { tierCount } from './tierFlowModel';
import type { FacetsResponse, Item, TierLevelsResponse } from './types';
import { useKnowledgeItems } from './useKnowledgeItems';

const LAST_ITEM_KEY = 'orgiq.distillation.knowledge.last';

function readLast(): Partial<Record<KnowledgeView, string>> {
  try { return JSON.parse(sessionStorage.getItem(LAST_ITEM_KEY) ?? '{}') as Partial<Record<KnowledgeView, string>>; } catch { return {}; }
}
function writeLast(v: Partial<Record<KnowledgeView, string>>) {
  try { sessionStorage.setItem(LAST_ITEM_KEY, JSON.stringify(v)); } catch { /* session-only nicety */ }
}

/** A single-select facet on the multi-select filter panel: the newest pick wins. */
function single(sel: string[]): string | null {
  return sel.length > 0 ? sel[sel.length - 1] : null;
}

export default function KnowledgeTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = parseKnowledge(location.search);
  const stateRef = useRef(state);
  stateRef.current = state;
  const level = levelForView(state.view);

  const go = useCallback((patch: Partial<KnowledgeState>, opts: { push?: boolean } = {}) => {
    navigate(knowledgeHref({ ...stateRef.current, ...patch }), { replace: !opts.push });
  }, [navigate]);

  // ── Search: typed locally, written to ?q= after a pause ──────────────────
  const [query, setQuery] = useState(state.q ?? '');
  useEffect(() => { setQuery(state.q ?? ''); }, [state.q, state.view]);
  useEffect(() => {
    const next = query.trim() || null;
    if (next === stateRef.current.q) return undefined;
    const t = setTimeout(() => go({ q: next, item: null }), 300);
    return () => clearTimeout(t);
  }, [query, go]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const feed = useKnowledgeItems({ level, repo: state.repo, initiative: state.initiative, q: state.q });
  const facets = useFetch<FacetsResponse>(`/api/distillation/facets?level=${level}`, 0);
  const levels = useDistillationChannel<TierLevelsResponse>('distill:levels');

  const clientFilters = { kind: state.kind, lifecycle: state.view === 'guides' ? state.lifecycle : null };
  const clientFiltered = !!(clientFilters.kind || clientFilters.lifecycle);
  const rows = useMemo(
    () => explorerRows(feed.items, clientFilters, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed.items, clientFilters.kind, clientFilters.lifecycle, nowMs],
  );

  // ── Selection: ?item=, restored per view, first valid row on entry ──────
  const lastRef = useRef(readLast());
  useEffect(() => {
    if (!state.item) return;
    lastRef.current = { ...lastRef.current, [state.view]: state.item };
    writeLast(lastRef.current);
  }, [state.item, state.view]);
  useEffect(() => {
    // An open Sources panel with nothing selected is the lineage deep link's
    // "choose an item" prompt — do not pick one for the reader.
    if (state.item || state.panel === 'sources' || feed.loading || rows.length === 0) return;
    const remembered = lastRef.current[state.view];
    const pick = remembered && rows.some((r) => r.id === remembered) ? remembered : rows[0].id;
    go({ item: pick });
  }, [state.item, state.panel, state.view, feed.loading, rows, go]);

  const record = useFetch<Item>(state.item ? `/api/distillation/items/${encodeURIComponent(state.item)}` : null, 0);
  const item = record.data && record.data.id === state.item ? record.data : null;
  // A deep link can name a record from another tier; the explorer follows it.
  useEffect(() => {
    if (item && levelForView(state.view) !== item.level) go({ view: viewForLevel(item.level), kind: null, lifecycle: null, q: null });
  }, [item, state.view, go]);
  const sources = useItemSources(item ? item.id : null);

  /** Follow a link from the record or the inspector. Within Knowledge the
   *  scope (repo, initiative) and the open inspector carry over; view-only
   *  filters carry only when the view does not change. Pushed, so Back
   *  returns to exactly where the reader was. */
  const openHref = useCallback((href: string) => {
    if (!href.startsWith('/iq/distillation/knowledge')) { navigate(href); return; }
    const s = stateRef.current;
    const target = parseKnowledge(href.slice(href.indexOf('?') + 1));
    const sameView = target.view === s.view;
    navigate(knowledgeHref({
      ...target,
      repo: s.repo,
      initiative: s.initiative,
      panel: s.panel,
      sourceView: s.sourceView,
      q: sameView ? s.q : null,
      kind: sameView ? s.kind : null,
      lifecycle: sameView ? s.lifecycle : null,
    }));
  }, [navigate]);

  // ── Sources column ───────────────────────────────────────────────────────
  const [wide, setWide] = useState(false);
  const columnState: ContextColumnState = state.panel === 'sources' ? (wide ? 'wide' : 'open') : 'collapsed';
  const subject = useMemo(
    () => (item ? { id: item.id, kind: item.level === 'L2' ? 'artifact' : item.level === 'L1' ? 'cluster' : 'observation', title: item.title } : null),
    [item],
  );

  const tierCounts = useMemo(() => {
    const by = new Map((levels.data?.levels ?? []).map((l) => [l.level, tierCount(l)]));
    return { guides: by.get('L2') ?? null, patterns: by.get('L1') ?? null, notes: by.get('L0') ?? null };
  }, [levels.data]);

  const filterFacets: WorkListFilterFacet[] = [
    {
      id: 'repo', label: 'Repository',
      options: (facets.data?.repos ?? []).map((o) => ({ value: o.value, label: o.label, count: o.count })),
      selected: state.repo ? [state.repo] : [],
      onChange: (sel) => go({ repo: single(sel), item: null }),
    },
    {
      id: 'initiative', label: 'Initiative',
      options: (facets.data?.initiatives ?? []).map((o) => ({ value: o.value, label: o.label, count: o.count })),
      selected: state.initiative ? [state.initiative] : [],
      onChange: (sel) => go({ initiative: single(sel), item: null }),
    },
    {
      id: 'kind', label: state.view === 'guides' ? 'Type' : 'Kind',
      options: (facets.data?.kinds ?? []).map((o) => ({ value: o.value, label: o.label.charAt(0).toUpperCase() + o.label.slice(1), count: o.count })),
      selected: state.kind ? [state.kind] : [],
      onChange: (sel) => go({ kind: single(sel), item: null }),
    },
    ...(state.view === 'guides' ? [{
      id: 'lifecycle', label: 'Lifecycle',
      options: LIFECYCLE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      selected: state.lifecycle ? [state.lifecycle] : [],
      onChange: (sel: string[]) => go({ lifecycle: single(sel), item: null }),
    }] : []),
  ];
  const activeFilters = [state.repo, state.initiative, state.kind, state.view === 'guides' ? state.lifecycle : null].filter(Boolean).length;

  const railHeader = (
    <Stack gap="xs" className="px-3 pb-2">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={searchPlaceholder(state.view)}
        aria-label={searchPlaceholder(state.view)}
        size="sm"
        data-testid="knowledge-search"
      />
      <T className="text-[11px] text-text-tertiary">{searchScopeNote(state.view, state.repo)}</T>
      <Inline gap="xs" align="center" wrap={false}>
        <Select
          aria-label="Knowledge view"
          size="sm"
          wrapperClassName="min-w-0 flex-1"
          value={state.view}
          onChange={(e) => go({ view: e.target.value as KnowledgeView, item: null, kind: null, lifecycle: null, q: null })}
          options={VIEWS.map((v) => ({ value: v, label: tierCounts[v] != null ? `${VIEW_LABEL[v]} ${tierCounts[v]}` : VIEW_LABEL[v] }))}
          data-testid="knowledge-view"
        />
        <FilterPopover
          trigger="icon"
          size="sm"
          label="Filter"
          activeCount={activeFilters}
          onClear={() => go({ repo: null, initiative: null, kind: null, lifecycle: null, item: null })}
          panelLabel={`Filter ${VIEW_NOUN[state.view]}`}
        >
          <Stack gap="sm">
            <WorkListFilters facets={filterFacets} data-testid="knowledge-filters" />
            <T className="text-[11px] text-text-tertiary">
              Repository and initiative filter on the server; {state.view === 'guides' ? 'type and lifecycle apply' : 'kind applies'} to the loaded rows.
            </T>
          </Stack>
        </FilterPopover>
      </Inline>
    </Stack>
  );

  const railBody = feed.error ? (
    <Stack className="p-3">
      <UnavailableNotice error={feed.error} what={VIEW_NOUN[state.view]} source="Distillation items are read from Aurora" onRetry={feed.retry} />
    </Stack>
  ) : feed.loading ? (
    <LoadingState label={`Loading ${VIEW_NOUN[state.view]}…`} />
  ) : rows.length === 0 ? (
    <EmptyState
      size="sm"
      title={activeFilters > 0 || state.q ? 'No matches' : `No ${VIEW_NOUN[state.view]} yet`}
      description={clientFiltered && feed.hasMore
        ? `None of the ${feed.items.length} loaded rows match — load more to keep looking.`
        : activeFilters > 0 || state.q
          ? 'Nothing in this view matches the search or filters.'
          : 'This fills in as agent sessions run and their notes are compacted up the tiers.'}
      actionLabel={activeFilters > 0 || state.q ? 'Clear search and filters' : undefined}
      onAction={activeFilters > 0 || state.q
        ? () => { setQuery(''); go({ q: null, repo: null, initiative: null, kind: null, lifecycle: null, item: null }); }
        : undefined}
    />
  ) : (
    <GroupedList
      size="sm"
      groups={explorerGroups(rows).map((g) => ({ id: g.id, title: g.title, count: g.count }))}
      rows={rows.map((r) => ({
        id: r.id,
        groupId: r.groupId,
        icon: <FileKindMark kind={r.fileKind} size="sm" variant="glyph" />,
        title: r.title,
        subline: r.subline,
        ariaLabel: r.ariaLabel,
      }))}
      currentId={state.item}
      onOpenRow={(row) => go({ item: row.id })}
      storageKey={`distillation.knowledge.${state.view}.groups`}
      data-testid="knowledge-list"
    />
  );

  const railFooter = feed.loading || feed.error ? undefined : (
    <Inline gap="sm" align="center" justify="between" className="px-3 py-2">
      <T className="text-[12px] text-text-tertiary" data-testid="knowledge-loaded">
        {loadedLabel(state.view, feed.items.length, rows.length, feed.total, feed.hasMore, clientFiltered)}
      </T>
      {feed.hasMore && (
        <Button size="sm" variant="secondary" disabled={feed.loadingMore} onClick={feed.loadMore}>
          {feed.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </Inline>
  );

  const aside = state.item || state.panel === 'sources' ? (
    <ContextColumn
      state={columnState}
      onStateChange={(next) => {
        setWide(next === 'wide');
        go({ panel: next === 'collapsed' ? null : 'sources' }, { push: true });
      }}
      label="Sources column"
      activeId="sources"
      onActivate={() => go({ panel: 'sources' }, { push: true })}
      roomy
      data-testid="knowledge-sources-column"
      panels={[{
        id: 'sources',
        label: 'Sources',
        icon: <LinkIcon size={18} />,
        badge: sources.data?.sources?.length,
        content: subject ? (
          <SourcesPanel
            subject={subject}
            view={state.sourceView}
            onViewChange={(v) => go({ sourceView: v })}
            onOpen={openHref}
          />
        ) : (
          <EmptyState size="sm" title="Choose an item to trace its sources" description="Pick a guide, pattern or run note from the list; its evidence opens here." />
        ),
      }]}
    />
  ) : undefined;

  let pane;
  if (!state.item) {
    pane = (
      <EmptyState
        title={state.panel === 'sources' ? 'Choose an item to trace its sources' : feed.loading ? 'Loading…' : 'Nothing selected'}
        description={state.panel === 'sources'
          ? 'Lineage opens from a record: pick one from the list and its Sources graph opens beside it.'
          : 'Pick a record from the list.'}
      />
    );
  } else if (record.error) {
    pane = (
      <Stack className="p-6">
        <UnavailableNotice error={record.error} what="this record" source="Distillation items are read from Aurora" onRetry={record.refresh} />
      </Stack>
    );
  } else if (!item) {
    pane = <LoadingState label="Loading record…" />;
  } else {
    pane = (
      <KnowledgeRecord
        key={item.id}
        item={item}
        sourceCount={sources.data?.sources ? sources.data.sources.length : null}
        onOpenSources={() => go({ panel: 'sources' }, { push: true })}
        onOpen={openHref}
      />
    );
  }

  return (
    <ExplorerLayout
      railWidth="ml"
      railTitle="Knowledge"
      railLabel="knowledge explorer"
      railHeader={railHeader}
      rail={railBody}
      railFooter={railFooter}
      panePadding="none"
      asidePlacement="beside"
      aside={aside}
      className="min-h-0 flex-1"
      data-testid="distillation-knowledge"
    >
      {pane}
    </ExplorerLayout>
  );
}
