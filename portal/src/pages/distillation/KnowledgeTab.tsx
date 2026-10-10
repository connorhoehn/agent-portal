// Distillation → Knowledge (spec §1): crumbs · title · explorer · record.
//
//   frame   ListRailLayout (docs/layout-cascade.md): the explorer is a
//           flush list rail beside the module's section rail (the
//           Initiatives rail's structure); the content column after it opens
//           with the module crumbs + Agent library, then the view's title
//           ("Guides & findings"), then the record
//   list    caption + live tier count ("GUIDES & FINDINGS 11") ·
//           SearchInput + filter popover on one row (WorkListFilters over
//           GET /facets), the scope hint under it · GroupedList rows (caps
//           group labels, no row icons, barred current row) · footer "N of M
//           loaded" + cursor Load more. No view selector: the module's
//           sub-nav already chooses the view.
//   pane    KnowledgeRecord on EditorShell with the explain-only composer
//   aside   ContextColumn → SourcesPanel (List | Graph), only while Sources
//           is open — closing it removes the column rather than leaving a
//           strip (docs/distillation-guide-record-spec.md)
//
// All state lives in the URL (distillationRoutes.parseKnowledge), so every
// migrated link lands with its selection and filters, and following a source
// pushes history — Back returns to the record and filters you left.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUrlDraft } from './useUrlDraft';
import { useLocation, useNavigate, useOutletContext } from 'react-router';
import {
  ContextColumn, WorkListFilters, type ContextColumnState,
  type WorkListFilterFacet,
  ListRailLayout,
} from '@connorhoehnslalom/ui-components';
import {
  Button, EmptyState, FilterPopover, GroupedList, Inline, LinkIcon, LiveRegion, LoadingState, SearchInput, Stack, StatusPill, T,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import { useFetch } from '../../hooks/useFetch';
import { SectionHeader } from '../../components/shell/SectionContent';
import type { DistillationOutletContext } from './DistillationModule';
import {
  knowledgeHref, levelForView, parseKnowledge, viewForLevel, type KnowledgePatch,
} from './distillationRoutes';
import { KnowledgeRecord } from './KnowledgeRecord';
import {
  LIFECYCLE_OPTIONS, VIEW_LABEL, VIEW_NOUN, explorerGroups, explorerRows, freshAnnouncement, loadedLabel, searchPlaceholder,
  searchScopeNote,
} from './knowledgeModel';
import { SourcesPanel, useItemSources } from './SourcesPanel';
import { tierCount } from './tierFlowModel';
import type { FacetsResponse, Item, TierLevelsResponse } from './types';
import { useKnowledgeItems } from './useKnowledgeItems';

/** A single-select facet on the multi-select filter panel: the newest pick wins. */
function single(sel: string[]): string | null {
  return sel.length > 0 ? sel[sel.length - 1] : null;
}

export default function KnowledgeTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const { scope } = useOutletContext<DistillationOutletContext>();
  const state = parseKnowledge(location.search);
  const stateRef = useRef(state);
  stateRef.current = state;
  const level = levelForView(state.view);

  const go = useCallback((patch: KnowledgePatch, opts: { push?: boolean } = {}) => {
    navigate(knowledgeHref({ ...stateRef.current, ...patch }), { replace: !opts.push });
  }, [navigate]);

  // ── Search: typed locally, written to ?q= after a pause ──────────────────
  // useUrlDraft, not a resync-on-every-?q= effect: that effect trimmed the
  // box to the committed value, so "Aurora " + a pause + "Data" read
  // "AuroraData". A different view always takes the URL's query.
  const [query, setQuery] = useUrlDraft(state.q ?? '', (value) => go({ q: value || null, item: null }), { debounceMs: 300, resetKey: state.view });

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const levels = useDistillationChannel<TierLevelsResponse>('distill:levels');
  // Each tier's digest (the levels frame or poll): a list, a record and its
  // runs re-read themselves when the tier they show moves.
  const digests = useMemo(() => {
    const by = new Map((levels.data?.levels ?? []).map((l) => [l.level, l.digest ?? null]));
    return { L0: by.get('L0') ?? null, L1: by.get('L1') ?? null, L2: by.get('L2') ?? null };
  }, [levels.data]);
  const storeVersion = digests.L0 && digests.L1 && digests.L2 ? `${digests.L0}.${digests.L1}.${digests.L2}` : null;
  const feed = useKnowledgeItems({ level, repo: state.repo, initiative: state.initiative, q: state.q, version: digests[level] });
  const facets = useFetch<FacetsResponse>(`/api/distillation/facets?level=${level}`, 0);

  // Arrivals are announced once each: the count that came in since the last
  // announcement, not the running total.
  const [arrivals, setArrivals] = useState('');
  const announced = useRef(0);
  useEffect(() => {
    const added = feed.fresh.size - announced.current;
    announced.current = feed.fresh.size;
    setArrivals(added > 0 ? freshAnnouncement(added, state.view) : '');
  }, [feed.fresh, state.view]);

  const clientFilters = { kind: state.kind, lifecycle: state.view === 'guides' ? state.lifecycle : null };
  const clientFiltered = !!(clientFilters.kind || clientFilters.lifecycle);
  const rows = useMemo(
    () => explorerRows(feed.items, clientFilters, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed.items, clientFilters.kind, clientFilters.lifecycle, nowMs],
  );

  // Selection belongs to the URL. Returning to a parent must leave the
  // record closed instead of immediately selecting it again.

  const record = useFetch<Item>(state.item ? `/api/distillation/items/${encodeURIComponent(state.item)}` : null, 0);
  const item = record.data && record.data.id === state.item ? record.data : null;
  // The open record follows its own tier: a publish, a new member or a new
  // "when this helps" line shows without a reload.
  const recordDigest = item ? digests[item.level] : null;
  const seenRecordDigest = useRef(recordDigest);
  const refreshRecord = record.refresh;
  useEffect(() => {
    if (recordDigest === seenRecordDigest.current) return;
    const first = seenRecordDigest.current === null;
    seenRecordDigest.current = recordDigest;
    if (!first) refreshRecord();
  }, [recordDigest, refreshRecord]);
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

  const viewCount = tierCounts[state.view];
  const railHeader = (
    <Stack gap="xs">
      <Inline gap="xs" align="center" wrap={false}>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={searchPlaceholder(state.view)}
          aria-label={searchPlaceholder(state.view)}
          className="min-w-0 flex-1"
          data-testid="knowledge-search"
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
      <T className="text-[12px] text-text-tertiary">{searchScopeNote(state.view, state.repo)}</T>
      <LiveRegion message={arrivals} data-testid="knowledge-arrivals" />
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
      // md: the rail scale every other rail draws (ui-components 2.397.0
      // railType) — 15px titles beside the 15px module rail, not 14px.
      size="md"
      groupHeading="label"
      currentStyle="bar"
      groups={explorerGroups(rows).map((g) => ({ id: g.id, title: g.title, count: g.count }))}
      rows={rows.map((r) => ({
        id: r.id,
        groupId: r.groupId,
        title: r.title,
        subline: r.subline,
        ariaLabel: feed.fresh.has(r.id) ? `New: ${r.ariaLabel ?? r.title}` : r.ariaLabel,
        ...(feed.fresh.has(r.id) ? { pill: <StatusPill tone="info" label="New" size="sm" data-testid="knowledge-row-new" /> } : {}),
      }))}
      currentId={state.item}
      onOpenRow={(row) => go({ item: row.id, tab: null, run: null }, { push: true })}
      storageKey={`distillation.knowledge.${state.view}.groups`}
      data-testid="knowledge-list"
    />
  );

  const railFooter = feed.loading || feed.error ? undefined : (
    <Inline gap="sm" align="center" justify="between">
      <T className="text-[13px] text-text-secondary" data-testid="knowledge-loaded">
        {loadedLabel(state.view, feed.items.length, rows.length, feed.total, feed.hasMore, clientFiltered)}
      </T>
      {feed.hasMore && (
        <Button size="sm" variant="secondary" disabled={feed.loadingMore} onClick={feed.loadMore}>
          {feed.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </Inline>
  );

  const aside = state.panel === 'sources' ? (
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
    // With no record open the pane says what to do; the view's name is the
    // page title above the explorer.
    pane = (
      <Stack gap="md" className="w-full max-w-3xl px-6 pb-6">
        <EmptyState
          title={state.panel === 'sources' ? 'Choose an item to trace its sources' : feed.loading ? 'Loading…' : 'Nothing selected'}
          description={state.panel === 'sources'
            ? 'Lineage opens from a record: pick one from the list and its Sources graph opens beside it.'
            : 'Pick a record from the list.'}
        />
      </Stack>
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
        tab={state.tab}
        runId={state.run}
        onTabChange={(tab) => go({ tab, run: null })}
        onViewRun={(run) => go({ tab: 'runs', run }, { push: true })}
        version={storeVersion}
      />
    );
  }

  const trail = state.item ? [...scope.breadcrumbs.slice(0, -1), {
    label: 'Knowledge',
    href: knowledgeHref({ ...state, item: null, tab: null, run: null, panel: null }),
    onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go({ item: null, tab: null, run: null, panel: null }, { push: true });
    },
  }, { label: item?.title ?? 'Record' }] : scope.breadcrumbs;

  // The explorer is a flush list rail beside the section rail; the content
  // column after it opens with the trail and the view's title
  // (docs/layout-cascade.md). The repository is the rail's filter.
  return (
    <ListRailLayout
      header={<SectionHeader breadcrumbs={trail} link={scope.link} title={VIEW_LABEL[state.view]} />}
      list={{
        title: VIEW_LABEL[state.view],
        ...(viewCount != null ? { count: viewCount } : {}),
        header: railHeader,
        body: railBody,
        footer: railFooter,
        label: 'knowledge explorer',
      }}
      aside={aside}
      data-testid="distillation-knowledge"
    >
      {pane}
    </ListRailLayout>
  );
}
