// InvocationSearchPage — rich filter panel + results table for triage.
//
// Backend: GET /api/observability/invocations/search?... → { invocations, count }
// Polling: 30s, but only when results are loaded (i.e. a query has been run).
//
// Pattern is mirrored on DriftPage / QualityPage: Card/Table primitives,
// `useFetch` hook, defensive parsing, EmptyState component, CostChip +
// PromptVersionChip reused verbatim from Sprint 1.

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  Card,
  Chip,
  FormField,
  Inline,
  Input,
  LoadingState,
  PageSection,
  Select,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { readDegraded } from '../../lib/degraded';
import { T } from './Text';
import { RowEmpty } from './ReadState';

interface InvocationSearchResult {
  invocationId: string;
  agentId: string;
  agentName: string;
  templateId: string | null;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number | null;
  schemaValid: boolean | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  promptVersion: string | null;
  modelId: string | null;
  parentInvocationId: string | null;
  userId: string | null;
  ts: string;
}

interface SearchResponse {
  invocations: InvocationSearchResult[];
  count: number;
}

interface DriftSummaryRow {
  agentId: string;
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const judgeTone = (v: number | null): Tone =>
  v == null ? 'neutral' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

const fmt = (n: number | null | undefined, digits = 2): string =>
  n != null && Number.isFinite(n) ? Number(n).toFixed(digits) : '—';

const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};

function isoLocal(d: Date): string {
  // YYYY-MM-DDThh:mm — what the datetime-local input wants. Truncate the
  // timezone offset so the user sees their wall clock.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function defaultSince(): string {
  return isoLocal(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function defaultUntil(): string {
  return isoLocal(new Date());
}

function toIsoOrEmpty(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

interface FilterState {
  q: string;
  agentId: string;
  mode: 'all' | 'live' | 'sim';
  minScore: string;
  maxScore: string;
  since: string;
  until: string;
  promptVersion: string;
  userId: string;
}

function defaultFilters(): FilterState {
  return {
    q: '',
    agentId: '',
    mode: 'all',
    minScore: '',
    maxScore: '',
    since: defaultSince(),
    until: defaultUntil(),
    promptVersion: '',
    userId: '',
  };
}

/** Every `FilterState` key that maps straight onto a same-named URL param. */
const FILTER_KEYS = ['q', 'agentId', 'mode', 'minScore', 'maxScore', 'since', 'until', 'promptVersion', 'userId'] as const;

/** Applied filters → URL, so a search that was actually run round-trips
 *  through a reload or a copied link — not just the handful of fields a
 *  deep link from TrafficPage's Top-Users table happens to seed. Defaults
 *  (`mode: 'all'`, empty strings) are omitted so an untouched field doesn't
 *  clutter the address bar. */
function filtersToSearchParams(f: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const val = f[key];
    if (!val) continue;
    if (key === 'mode' && val === 'all') continue;
    params.set(key, val);
  }
  return params;
}

/** The inverse: URL → a `FilterState`, layered over the defaults so a param
 *  that was never set (or an unrecognized `mode`) falls back honestly. */
function searchParamsToFilters(sp: URLSearchParams): FilterState {
  const base = defaultFilters();
  const mode = sp.get('mode');
  return {
    q: sp.get('q') ?? base.q,
    agentId: sp.get('agentId') ?? base.agentId,
    mode: mode === 'live' || mode === 'sim' ? mode : base.mode,
    minScore: sp.get('minScore') ?? base.minScore,
    maxScore: sp.get('maxScore') ?? base.maxScore,
    since: sp.get('since') ?? base.since,
    until: sp.get('until') ?? base.until,
    promptVersion: sp.get('promptVersion') ?? base.promptVersion,
    userId: sp.get('userId') ?? base.userId,
  };
}

function buildUrl(f: FilterState): string {
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.agentId) params.set('agentId', f.agentId);
  if (f.mode && f.mode !== 'all') params.set('mode', f.mode);
  if (f.minScore) params.set('minScore', f.minScore);
  if (f.maxScore) params.set('maxScore', f.maxScore);
  const since = toIsoOrEmpty(f.since);
  const until = toIsoOrEmpty(f.until);
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  if (f.promptVersion) params.set('promptVersion', f.promptVersion);
  if (f.userId) params.set('userId', f.userId);
  params.set('limit', '50');
  return `/api/observability/invocations/search?${params.toString()}`;
}

function snip(s: string | null | undefined, max = 80): string {
  if (!s) return '—';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function InvocationSearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep links seed the URL before this component ever mounts — TrafficPage's
  // Top-Users table links here with `?userId=u_alice` etc — so both the
  // working draft and the applied filters can hydrate straight from it, read
  // once here rather than in an effect (the URL is already there on first
  // render; there is nothing to wait for).
  const hasDeepLinkedFilter = FILTER_KEYS.some((k) => searchParams.has(k));
  const initialFilters = hasDeepLinkedFilter ? searchParamsToFilters(searchParams) : defaultFilters();

  // Working filter state (edited freely until Search pressed).
  const [draft, setDraft] = useState<FilterState>(initialFilters);
  // Applied filter state (only this drives the fetch URL — protects against
  // typing-as-you-go thrash). A deep link auto-applies so the researcher
  // lands on a filtered table without having to hit Search; a bare visit
  // starts with nothing applied, same as before.
  const [applied, setApplied] = useState<FilterState | null>(hasDeepLinkedFilter ? initialFilters : null);

  const url = applied ? buildUrl(applied) : '';
  const { data, isLoading, error, degraded } = useFetch<SearchResponse>(url, 30_000);

  const rows = useMemo<InvocationSearchResult[]>(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data as InvocationSearchResult[];
    return Array.isArray(data.invocations) ? data.invocations : [];
  }, [data]);

  const totalCount = data?.count ?? rows.length;

  // Agent options derived from drift summary endpoint (same as QualityPage).
  // Healthy: a bare array. Failed: `{ agents: [], degraded, error }`, because
  // an array cannot carry a marker. Without reading that, a broken drift query
  // just narrows the filter to "(all agents)" and the reader never learns the
  // list they are filtering against is missing.
  const { data: agentsSummary, refresh: refreshAgents } = useFetch<
    DriftSummaryRow[] | { agents?: DriftSummaryRow[]; degraded?: boolean; error?: string }
  >(
    '/api/observability/drift/summary?windowHours=24',
    30_000,
  );
  const agentsDegraded = readDegraded(agentsSummary);
  const agentOptions = useMemo(
    () =>
      Array.isArray(agentsSummary) ? agentsSummary.map((a) => a.agentId).sort() : [],
    [agentsSummary],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setApplied({ ...draft });
    // The filters that were actually run, not just the handful a deep link
    // seeded — this used to only ever be read on mount, so hitting Search
    // again with a changed field left the URL describing the PREVIOUS
    // search. `replace` because refining a search is an edit to the same
    // view, not a new page for Back to step through.
    setSearchParams(filtersToSearchParams(draft), { replace: true });
  }

  function onClear() {
    const fresh = defaultFilters();
    setDraft(fresh);
    setApplied(null);
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  function update<K extends keyof FilterState>(key: K, val: FilterState[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  return (
    <PageSection
      title="Search Invocations"
      description={
        applied
          ? `30s refresh · ${rows.length} loaded of ${totalCount}`
          : 'Filter to triage by prompt / agent / score'
      }
      actions={
        <Link
          to="/admin/observability/invocations"
          className="text-[12px] text-primary no-underline hover:underline"
        >
          ← Recent activity
        </Link>
      }
    >
      {agentsDegraded && (
        <UnavailableNotice
          error={agentsDegraded}
          what="the agent filter list"
          source="The agent list comes from the drift rollup in Aurora"
          onRetry={refreshAgents}
          className="mb-4"
        />
      )}

      <Card padding="md">
        <form onSubmit={onSubmit}>
          <Stack gap="md">
            <Inline gap="md" wrap>
              <FormField label="Search prompt" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="text"
                    value={draft.q}
                    onChange={(e) => update('q', e.target.value)}
                    placeholder="substring match…"
                  />
                )}
              </FormField>

              <FormField label="Agent" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Select
                    {...field}
                    value={draft.agentId}
                    onChange={(e) => update('agentId', e.target.value)}
                    options={[
                      { value: '', label: 'All' },
                      ...agentOptions.map((a) => ({ value: a, label: a })),
                    ]}
                  />
                )}
              </FormField>

              <FormField label="Mode" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Select
                    {...field}
                    value={draft.mode}
                    onChange={(e) => update('mode', e.target.value as FilterState['mode'])}
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'live', label: 'Live' },
                      { value: 'sim', label: 'Sim' },
                    ]}
                  />
                )}
              </FormField>

              <FormField label="Min judge score" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="number"
                    value={draft.minScore}
                    onChange={(e) => update('minScore', e.target.value)}
                    placeholder="0.00"
                    step={0.05}
                    min={0}
                    max={1}
                  />
                )}
              </FormField>

              <FormField label="Max judge score" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="number"
                    value={draft.maxScore}
                    onChange={(e) => update('maxScore', e.target.value)}
                    placeholder="1.00"
                    step={0.05}
                    min={0}
                    max={1}
                  />
                )}
              </FormField>

              <FormField label="Since" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="datetime-local"
                    value={draft.since}
                    onChange={(e) => update('since', e.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Until" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="datetime-local"
                    value={draft.until}
                    onChange={(e) => update('until', e.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Prompt version" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="text"
                    value={draft.promptVersion}
                    onChange={(e) => update('promptVersion', e.target.value)}
                    placeholder="sha (full or partial)"
                  />
                )}
              </FormField>

              <FormField label="User id" className="flex-1 min-w-[180px]">
                {({ labelId: _labelId, ...field }) => (
                  <Input
                    {...field}
                    type="text"
                    value={draft.userId}
                    onChange={(e) => update('userId', e.target.value)}
                    placeholder="optional"
                  />
                )}
              </FormField>
            </Inline>
            <Inline gap="sm">
              <Button type="submit" variant="primary" size="sm">
                Search
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={onClear}>
                Clear
              </Button>
            </Inline>
          </Stack>
        </form>
      </Card>

      <Card padding="md">
        {!applied && (
          <RowEmpty text="Use filters above to find invocations. Try widening the time range or removing filters." />
        )}
        {applied && error && (
          <RowEmpty
            text={`Search failed: ${error}. The backend may not have the search endpoint yet.`}
          />
        )}
        {applied && !error && rows.length === 0 && (
          isLoading ? (
            <LoadingState label="Searching…" />
          ) : (
            <SmartEmptyState
              // `error` is handled by the branch above, but `degraded` was not:
              // a search the server could not run came back as a 200 whose body
              // says so, and this rendered "No invocations match" — a claim
              // about the corpus made from a query that never ran.
              degraded={degraded}
              degradedWhat="the invocation search"
              degradedSource="Search runs against observability.invocation_traces in Aurora"
              title="No invocations match"
              detail="Try widening the time range or removing filters."
            />
          )
        )}
        {applied && !error && rows.length > 0 && (
          <>
            <T as="div" className="text-[11px] text-text-tertiary mb-2">
              Showing {rows.length} of {totalCount}
            </T>
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Agent</TableTh>
                  <TableTh>When</TableTh>
                  <TableTh>Prompt</TableTh>
                  <TableTh>Response</TableTh>
                  <TableTh>Score</TableTh>
                  <TableTh>Cost</TableTh>
                  <TableTh>Prompt ver.</TableTh>
                  <TableTh>Duration</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.invocationId}
                    onClick={() =>
                      navigate(`/admin/observability/invocations/${r.invocationId}`)
                    }
                    className="cursor-pointer"
                  >
                    <TableTd className="text-[12px] font-medium whitespace-nowrap">
                      {r.agentName || r.agentId}
                    </TableTd>
                    <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                      {new Date(r.ts).toLocaleString()}
                    </TableTd>
                    <TableTd className="text-[12px] max-w-[280px] truncate" title={r.promptSnippet}>
                      {snip(r.promptSnippet, 100)}
                    </TableTd>
                    <TableTd className="text-[12px] max-w-[280px] truncate" title={r.responseSnippet}>
                      {snip(r.responseSnippet, 100)}
                    </TableTd>
                    <TableTd>
                      <Chip tone={judgeTone(r.judgeScore)} size="xs">
                        {fmt(r.judgeScore)}
                      </Chip>
                    </TableTd>
                    <TableTd className="whitespace-nowrap">
                      <CostChip cost={r.totalCostUsd} />
                    </TableTd>
                    <TableTd className="whitespace-nowrap">
                      <PromptVersionChip promptVersion={r.promptVersion} />
                    </TableTd>
                    <TableTd className="text-[12px] text-text-secondary whitespace-nowrap">{fmtDur(r.durationMs)}</TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </PageSection>
  );
}

export default InvocationSearchPage;
