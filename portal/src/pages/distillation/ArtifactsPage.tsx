// Distillation → Artifacts. The L2 catalog — the only place a person can
// actually see a runbook or insight the fleet distilled, check it against
// its evidence, and follow it into the Library item it became. Everything
// downstream of "L2 artifacts — 40" being a bare number on the old page
// starts here.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Button, Chip, DataTable, DetailSection, Drawer, EmptyState, EventRow, FilterChip, Inline, LoadingState,
  MarkdownView, MetaLine, PageSection, SearchInput, Stack, StackDiagram, Toolbar, ToolbarGroup, ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { LineageFrame } from './LineageFrame';
import { T } from './Text';
import {
  ARTIFACT_STATUS_LABEL, ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE, OUTCOME_LABEL,
  OUTCOME_SEVERITY, artifactFactCount, evidenceLabel, factsFromLineage, runsLabel, stepTonesForRun,
  stepsFromLineage, stepsLabel,
} from './distillationFormat';
import type {
  ApplicationsResponse, Artifact, ArtifactsResponse, ArtifactStatus, ArtifactType, Lineage,
} from './types';

const TYPE_FILTERS: Array<{ value: ArtifactType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'runbook', label: 'Runbook' },
  { value: 'insight', label: 'Insight' },
  { value: 'convention', label: 'Convention' },
  { value: 'decision', label: 'Decision' },
  { value: 'procedure', label: 'Procedure' },
];

const STATUS_FILTERS: Array<{ value: ArtifactStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'retired', label: 'Retired' },
];

export default function DistillationArtifactsPage() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') ?? 'all') as ArtifactType | 'all';
  const status = (params.get('status') ?? 'all') as ArtifactStatus | 'all';
  const [query, setQuery] = useState('');
  // `?open=<id>` opens the drawer on arrival — the Overview's repertoire
  // rows land here — and closing it drops the param so a reload does not
  // reopen a drawer the reader already dismissed.
  const [openId, setOpenId] = useState<string | null>(params.get('open'));
  const closeDrawer = () => {
    setOpenId(null);
    if (params.has('open')) {
      const next = new URLSearchParams(params);
      next.delete('open');
      setParams(next, { replace: true });
    }
  };

  const setFacet = (key: 'type' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(key); else next.set(key, value);
    // A facet change is a new list; the drawer that a deep link opened does
    // not survive it, and neither does the `open` param — otherwise the
    // drawer vanished when the filter dropped its artifact and popped back
    // unasked when the filter brought it back.
    next.delete('open');
    setOpenId(null);
    setParams(next, { replace: true });
  };

  // The route validates `type`/`status` against the enums and 400s on
  // anything else — "all" is the page's filter state, not a wire value, so
  // it is omitted rather than sent.
  const qs = new URLSearchParams();
  if (type !== 'all') qs.set('type', type);
  if (status !== 'all') qs.set('status', status);
  const url = `/api/distillation/artifacts${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  const { data, isLoading, error } = useFetch<ArtifactsResponse>(url, 60_000);

  const artifacts = useMemo(() => {
    const all = data?.artifacts ?? [];
    if (!query.trim()) return all;
    const q = query.trim().toLowerCase();
    return all.filter((a) => a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q));
  }, [data, query]);

  const open = artifacts.find((a) => a.id === openId) ?? data?.artifacts.find((a) => a.id === openId) ?? null;

  // Five columns, not seven: at 1440px the prior "Facts"/"Last compaction"
  // columns pushed the wrapper's scrollWidth (1467) past its clientWidth
  // (924), forcing the table's own horizontal scroll on every laptop-width
  // view (defect #5). Both move into a MetaLine under the title/summary
  // instead — evidence count and last-compaction time are still visible on
  // every row, just not as their own columns — and the type/status chips,
  // the Library link, and the clusters count (the columns worth sorting or
  // scanning as a column) stay.
  //
  // Reopened defect #5: `DataTableColumn.width` only styles the `<th>` — the
  // table has no `table-fixed`/`colgroup`, so with auto layout the browser
  // still sizes each column to its widest CELL content, and an untruncated
  // title/summary is that widest content. `truncate` alone doesn't help
  // without a width to truncate AGAINST, so the title column itself must
  // cap the pixel width of its rendered content, not just declare a `<th>`
  // hint. Budget at the audited 924px wrapper (1440px viewport): Type 92 +
  // Status 112 + Library 108 + Clusters 76 = 388px fixed, leaving the title
  // column capped at 460px (848px total, 76px of margin for table borders
  // and layout rounding).
  const TITLE_MAX = 'max-w-[460px]';
  const columns: DataTableColumn<Artifact>[] = [
    {
      key: 'title', header: 'Artifact', sortable: true,
      getFilterText: (a) => `${a.title} ${a.summary}`,
      render: (a) => (
        <Stack gap="none" className={`min-w-0 ${TITLE_MAX}`}>
          {/* A real Button, not just the row's onClick: DataTable's row-click
              is a bare <tr onClick> with no tabIndex/keydown/role, so a
              keyboard user tabbing through the filter bar skipped straight
              past every row with no way to open one (defect #13,
              org-leader/DEFECTS.md #13). This is the row's one focusable,
              Enter/Space-activatable control; the row click stays as a
              mouse convenience alongside it — same pattern as
              `library/LibraryPage.tsx` and `promotions/PromotionsPage.tsx`. */}
          <Button
            variant="ghost"
            size="sm"
            className={`block truncate ${TITLE_MAX} justify-start border-none bg-transparent p-0 text-left text-[13px] font-semibold text-text-primary hover:bg-transparent hover:underline`}
            title={a.title}
            onClick={(e) => { e.stopPropagation(); setOpenId(a.id); }}
          >
            {a.title}
          </Button>
          <T className={`block truncate ${TITLE_MAX} text-[11px] text-text-tertiary`} title={a.summary}>{a.summary}</T>
          <MetaLine
            size="xs"
            className={TITLE_MAX}
            items={[evidenceLabel(artifactFactCount(a)), `updated ${relativeTime(a.updated_at)}`]}
          />
        </Stack>
      ),
    },
    {
      key: 'type', header: 'Type', sortable: true, width: '92px',
      render: (a) => <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>,
    },
    {
      key: 'status', header: 'Status', sortable: true, width: '112px',
      render: (a) => <Chip tone={ARTIFACT_STATUS_TONE[a.status]} size="xs" dot="static">{ARTIFACT_STATUS_LABEL[a.status]}</Chip>,
    },
    {
      key: 'library', header: 'Library', width: '108px',
      render: (a) => a.library_item_id
        ? <Link to={`/iq/library/${encodeURIComponent(a.library_item_id)}`} className="text-primary no-underline hover:underline">Open →</Link>
        : <T className="text-[11px] text-text-tertiary">not published</T>,
    },
    {
      key: 'clusters', header: 'Clusters', align: 'right', width: '76px',
      compare: (a, b) => a.cluster_ids.length - b.cluster_ids.length,
      render: (a) => <T className="tabular-nums text-[12px] text-text-secondary">{a.cluster_ids.length}</T>,
    },
  ];

  return (
    <PageSection
      title="Artifacts"
      description="L2 artifacts with their clusters, evidence and the Library item each became."
    >
      <Toolbar size="md" aria-label="Artifact filters">
        <ToolbarGroup aria-label="Type">
          <ToolbarLabel>Type</ToolbarLabel>
          {TYPE_FILTERS.map((f) => (
            <FilterChip key={f.value} active={type === f.value} onClick={() => setFacet('type', f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Status">
          <ToolbarLabel>Status</ToolbarLabel>
          {STATUS_FILTERS.map((f) => (
            <FilterChip key={f.value} active={status === f.value} onClick={() => setFacet('status', f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup divided aria-label="Search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Title or summary…"
            aria-label="Search artifacts"
            className="w-[220px]"
          />
        </ToolbarGroup>
      </Toolbar>

      {error ? (
        <EmptyState title="Could not load artifacts" description={error} />
      ) : isLoading && !data ? (
        <LoadingState label="Loading artifacts…" />
      ) : artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts"
          description="No artifact matches these filters."
          actionLabel="Clear filters"
          onAction={() => { setParams(new URLSearchParams(), { replace: true }); setQuery(''); }}
        />
      ) : (
        <DataTable<Artifact>
          data={artifacts}
          columns={columns}
          keyField={(a) => a.id}
          onRowClick={(a) => setOpenId(a.id)}
          pageSize={25}
          emptyMessage="No artifacts"
        />
      )}

      <Drawer open={open != null} onClose={closeDrawer} aria-label="Artifact detail" width={720}>
        {open && <ArtifactDrawerBody artifact={open} />}
      </Drawer>
    </PageSection>
  );
}

/** The artifact-side mirror of the Library's "Distilled from" section — this
 *  artifact was PUBLISHED AS a real Library asset. Resolves the asset's name
 *  rather than showing the bare id, same reasoning as the Library section
 *  showing the artifact's title rather than its id. */
function PublishedAs({ libraryItemId }: { libraryItemId: string }) {
  const { data } = useFetch<{ asset: { name: string } }>(`/api/library/${encodeURIComponent(libraryItemId)}`, 0);
  if (!data?.asset) return null;
  return (
    <Inline gap="xs" align="center">
      <T className="text-[11px] text-text-tertiary">Published as</T>
      <Link to={`/iq/library/${encodeURIComponent(libraryItemId)}`} className="text-[11px] text-primary no-underline hover:underline">
        {data.asset.name}
      </Link>
    </Inline>
  );
}

/** The two sections only a procedure has: its steps in order, toned by the
 *  latest run (proven up to the step it failed on, blamed there, unknown
 *  after), and the replay ledger those tones come from. Steps are facts
 *  with an ordinal, so they arrive through the same lineage fetch the
 *  drawer already makes; the runs are their own read. */
function ProcedureSections({ artifact: a, lineage }: { artifact: Artifact; lineage: Lineage | null }) {
  const { data: runsData, isLoading: runsLoading } =
    useFetch<ApplicationsResponse>(`/api/distillation/procedures/${encodeURIComponent(a.id)}/applications`, 0);
  const runs = runsData?.applications ?? [];
  const latest = runs[0] ?? null;
  const steps = lineage ? stepsFromLineage(lineage) : [];
  const tones = stepTonesForRun(steps, latest);
  const evidenceOf = (id: string) => (lineage?.edges ?? []).filter((e) => e.relation === 'supports' && e.to === id).length;

  return (
    <>
      <DetailSection title="Steps" hint={steps.length > 0 ? stepsLabel(steps.length) : undefined}>
        {steps.length === 0 ? (
          <T className="text-[11px] text-text-tertiary">{lineage ? 'No ordered steps on this procedure.' : 'Loading steps…'}</T>
        ) : (
          <StackDiagram
            orientation="vertical"
            connector="arrow"
            data-testid="procedure-steps"
            layers={steps.map((s, i) => ({
              id: s.id,
              label: `${s.ordinal}. ${s.label}`,
              description: typeof s.meta['confidence'] === 'number'
                ? `confidence ${Math.round((s.meta['confidence'] as number) * 100)}%`
                : undefined,
              tone: tones[i] ?? 'neutral',
              meta: <Chip tone="neutral" size="xs">{evidenceLabel(evidenceOf(s.id))}</Chip>,
            }))}
          />
        )}
      </DetailSection>

      <DetailSection title="Runs" hint={runsData ? runsLabel({
        total: runs.length,
        succeeded: runs.filter((r) => r.outcome === 'succeeded').length,
        failed: runs.filter((r) => r.outcome === 'failed').length,
        abandoned: runs.filter((r) => r.outcome === 'abandoned').length,
      }) : undefined}>
        {runsLoading && !runsData ? (
          <T className="text-[11px] text-text-tertiary">Loading runs…</T>
        ) : runs.length === 0 ? (
          <T className="text-[11px] text-text-tertiary">Never run to completion — this procedure is unproven until a session applies it.</T>
        ) : (
          <Stack gap="none" data-testid="procedure-runs">
            {runs.map((r) => {
              const stoppedAt = r.failed_at_step_id ? steps.find((s) => s.id === r.failed_at_step_id) : undefined;
              const where = stoppedAt ? ` — stopped at step ${stoppedAt.ordinal}: ${stoppedAt.label}` : '';
              return (
                <EventRow
                  key={r.id}
                  timestamp={relativeTime(r.applied_at)}
                  type={OUTCOME_LABEL[r.outcome]}
                  severity={OUTCOME_SEVERITY[r.outcome]}
                  summary={`${r.session_id} · ${r.box_id}${where}${r.note ? ` — ${r.note}` : ''}`}
                />
              );
            })}
          </Stack>
        )}
      </DetailSection>
    </>
  );
}

function ArtifactDrawerBody({ artifact: a }: { artifact: Artifact }) {
  const navigate = useNavigate();
  const { data: lineage, isLoading: lineageLoading, error: lineageError } =
    useFetch<Lineage>(`/api/distillation/items/${encodeURIComponent(a.id)}/lineage?depth=2`, 0);
  const isProcedure = a.type === 'procedure';

  return (
    <Stack gap="lg">
      <Stack gap="xs" as="header">
        <Inline gap="xs" wrap align="center">
          <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>
          <Chip tone={ARTIFACT_STATUS_TONE[a.status]} size="xs" dot="static">{ARTIFACT_STATUS_LABEL[a.status]}</Chip>
          <T className="text-[15px] font-semibold text-text-primary">{a.title}</T>
        </Inline>
        <T className="text-[12px] text-text-secondary">{a.summary}</T>
        <T className="text-[11px] text-text-tertiary">
          {a.cluster_ids.length} cluster{a.cluster_ids.length === 1 ? '' : 's'} · {artifactFactCount(a)} fact{artifactFactCount(a) === 1 ? '' : 's'}
          {a.reviewed_by ? ` · reviewed by ${a.reviewed_by}` : ''}
        </T>
        {a.library_item_id && <PublishedAs libraryItemId={a.library_item_id} />}
      </Stack>

      <Inline gap="xs">
        {a.library_item_id && (
          <Button size="sm" variant="secondary" onClick={() => navigate(`/iq/library/${encodeURIComponent(a.library_item_id!)}`)}>
            Open in Library
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => navigate(`/iq/distillation/lineage?focus=${encodeURIComponent(a.id)}`)}>
          Open lineage
        </Button>
      </Inline>

      <DetailSection first title="Body">
        <MarkdownView markdown={a.body_markdown} />
      </DetailSection>

      {isProcedure && <ProcedureSections artifact={a} lineage={lineage ?? null} />}

      {(() => {
        // A fact's content only exists in lineage — `Artifact.facts` is bare
        // IDs (there is no `GET /facts/:id`) — so this section waits on the
        // same lineage fetch the mini-lineage below already needs. A
        // procedure's steps are facts too; they are listed once, as steps.
        const stepIds = new Set(isProcedure && lineage ? stepsFromLineage(lineage).map((s) => s.id) : []);
        const facts = lineage ? factsFromLineage(lineage).filter((f) => !stepIds.has(f.id)) : [];
        if (lineageLoading && !lineage) return <DetailSection title="Facts"><T className="text-[11px] text-text-tertiary">Loading facts…</T></DetailSection>;
        if (facts.length === 0) return null;
        return (
          <DetailSection title="Facts" hint={`${facts.length} fact${facts.length === 1 ? '' : 's'}`}>
            <Stack gap="xs">
              {facts.map((f) => (
                <Stack key={f.id} gap="xs" className="rounded-md border border-border px-3 py-2">
                  <T className="text-[12.5px] text-text-primary">{f.statement}</T>
                  <Inline gap="xs" align="center">
                    <Chip tone="neutral" size="xs">{evidenceLabel(f.evidenceCount)}</Chip>
                    <T className="text-[10px] text-text-tertiary">confidence {Math.round(f.confidence * 100)}%</T>
                  </Inline>
                </Stack>
              ))}
            </Stack>
          </DetailSection>
        );
      })()}

      <DetailSection title="Distilled from" hint="mini-lineage — observations → cluster → this artifact">
        <LineageFrame lineage={lineage ?? null} loading={lineageLoading} error={lineageError} focusId={a.id} compact />
      </DetailSection>
    </Stack>
  );
}
