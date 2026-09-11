// ToolCallsPage — "which tools is the fleet calling, how long do they take,
// and what is failing".
//
// WHY THIS PAGE EXISTS. `/api/observability/tools/{latency,timeseries,errors}`
// has been on the wire for three sprints with no consumer. That mattered most
// for `/errors`: an empty tool-error list is the single most misleading empty
// in the observability tree, because "nothing is failing" is exactly what
// somebody opens the page to confirm — and until the routes grew a `degraded`
// marker, a blown-up query said it in the same words as a clean afternoon.
// Rendering that marker is half of this page's job.
//
// THREE STATES, KEPT APART. Every panel here can be in one of three
// conditions and they must never look alike:
//   • results        — rows.
//   • honestly empty — the read worked and there is nothing. For the error
//                      tail this is GOOD NEWS and is phrased as such.
//   • degraded       — the read failed (transport) or the server answered a
//                      well-formed empty it does not itself believe
//                      (`degraded: true`). Both render `UnavailableNotice`
//                      via SmartEmptyState's `degraded` prop; neither ever
//                      renders as "no errors".
//
// WIRE SHAPES are documented in ./toolCallsFormat.ts, read off a running
// dev:mock rather than off the route source.
//
// THE FILTER ROW IS DOING TWO DIFFERENT JOBS, deliberately. `windowHours` and
// `agentId` are real query parameters on /latency; the tool search is local.
// `/errors` takes NEITHER an agent nor a window — only `limit` — so its panel
// applies the agent and tool filters client-side (filterErrors) and its
// subtitle says the window does not apply to it. Silently letting the error
// tail ignore the selector would have it contradict the table directly above.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Card,
  CardHeader,
  Chip,
  FilterChip,
  Inline,
  PageSection,
  SearchInput,
  SegmentedControl,
  Select,
  Sparkline,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';

import { useFetch } from '../../hooks/useFetch';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { firstDegraded } from '../../lib/degraded';
import { T } from './Text';
import {
  TOOL_WINDOWS,
  errorTone,
  filterErrors,
  fmtInt,
  fmtMs,
  fmtPct,
  fmtToolCost,
  fmtTs,
  latencyTone,
  matchesQuery,
  summarize,
  volumeSeriesByTool,
  windowFor,
  type ToolErrorRow,
  type ToolLatencyRow,
  type ToolTimeseriesPoint,
} from './toolCallsFormat';

interface LatencyResponse { byTool: ToolLatencyRow[] }
interface TimeseriesResponse { points: ToolTimeseriesPoint[]; bucketMin: number; windowHours: number }
interface ErrorsResponse { errors: ToolErrorRow[] }
/** Just enough of GET /api/agents to fill the agent selector. */
interface AgentRegistryEntry { id: string; name?: string }

const ERROR_LIMIT = 100;

// Where a reader should go looking when these reads fail. Both panels sit on
// observability.tool_calls, so they name the same place.
const SOURCE = 'Tool calls are projected into the Aurora observability tables from agent spans';

function ToolCallsPage() {
  const [windowLabel, setWindowLabel] = useState('24h');
  const [agentId, setAgentId] = useState('all');
  const [query, setQuery] = useState('');
  const [failingOnly, setFailingOnly] = useState(false);
  const win = windowFor(windowLabel);

  const agentParam = agentId === 'all' ? '' : `&agentId=${encodeURIComponent(agentId)}`;

  const { data: latencyData, error: latencyError, refresh: refreshLatency } =
    useFetch<LatencyResponse>(
      `/api/observability/tools/latency?windowHours=${win.hours}${agentParam}`,
      30_000,
    );
  const { data: seriesData } = useFetch<TimeseriesResponse>(
    `/api/observability/tools/timeseries?windowHours=${win.hours}&bucketMin=${win.bucket}`,
    30_000,
  );
  const { data: errorsData, error: errorsError, degraded: errorsDegraded, refresh: refreshErrors } =
    useFetch<ErrorsResponse>(`/api/observability/tools/errors?limit=${ERROR_LIMIT}`, 30_000);
  // Populates the selector with every deployed agent, not only the ones that
  // happen to have tool traffic in this window — otherwise narrowing to a
  // quiet agent is impossible precisely when you need it.
  const { data: registry } = useFetch<{ agents: AgentRegistryEntry[] }>('/api/agents', 60_000);

  // The table's two reads sit on the same Aurora table and fail together, so
  // one sentence covers both. `error` (the request itself failed, no body) and
  // `degraded` (a 200 the server tells us not to believe) are two ways to be
  // blind about the same thing and get one treatment.
  const tableBlind = latencyError ?? firstDegraded(latencyData, seriesData);
  // The error tail is a SEPARATE read with its own failure branch — a working
  // latency rollup over a broken error query is exactly the case where "no
  // errors" would be believed. It gets its own marker, never the table's.
  const errorPanelBlind = errorsError ?? errorsDegraded;

  const rows = useMemo(() => latencyData?.byTool ?? [], [latencyData]);
  const series = useMemo(
    () => volumeSeriesByTool(seriesData?.points ?? []),
    [seriesData],
  );
  const allErrors = useMemo(() => errorsData?.errors ?? [], [errorsData]);

  const visibleRows = useMemo(
    () => rows.filter((r) => matchesQuery(r.toolName, query) && (!failingOnly || r.errorRate > 0)),
    [rows, query, failingOnly],
  );
  const visibleErrors = useMemo(
    () => filterErrors(allErrors, { agentId, query }),
    [allErrors, agentId, query],
  );

  const totals = useMemo(() => summarize(rows), [rows]);

  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of registry?.agents ?? []) seen.set(a.id, a.name || a.id);
    // An agent that shows up in the error tail but not in the registry still
    // deserves a way to be selected.
    for (const e of allErrors) if (e.agentId && !seen.has(e.agentId)) seen.set(e.agentId, e.agentId);
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [registry, allErrors]);

  const filtered = query.trim().length > 0 || failingOnly || agentId !== 'all';

  // One line, not a row of stat cards — the table has to start above the fold.
  // When the rollup is blind, the description must not quote numbers from it.
  const description = tableBlind
    ? `Per-tool latency, volume and failures · last ${win.label} · ` +
      (rows.length > 0 ? 'showing the last good answer' : 'these totals could not be read')
    : `${fmtInt(totals.tools)} tool${totals.tools === 1 ? '' : 's'} · ` +
      `${fmtInt(totals.calls)} call${totals.calls === 1 ? '' : 's'} in the last ${win.label} · ` +
      `${totals.failing === 0 ? 'none failing' : `${fmtInt(totals.failing)} with failures`}`;

  return (
    <PageSection
      title="Tool Calls"
      description={description}
      actions={
        <SegmentedControl
          size="sm"
          value={windowLabel}
          onChange={setWindowLabel}
          options={TOOL_WINDOWS.map((w) => ({ value: w.label, label: w.label }))}
        />
      }
    >
      {/* WHERE THE FAILURE IS SAID, EXACTLY ONCE. Each panel has two ways to
          be blind and one place to say so:
            • nothing to draw  → SmartEmptyState's `degraded` prop replaces the
              empty card with the failure notice, IN the space the rows would
              have filled.
            • stale rows still on screen (the refresh failed, the last good
              answer is still rendered) → the notice sits above them, because
              an empty card cannot carry it and rows with no marker read as
              current.
          A page-level banner on top of either of those is the stacked-banner
          problem `firstDegraded` exists to avoid — the same sentence twice,
          200px apart. The description line carries the page-level half by
          refusing to quote totals it could not read. */}
      {tableBlind && visibleRows.length > 0 && (
        <UnavailableNotice
          error={tableBlind}
          what="a fresh tool-call rollup"
          source={`${SOURCE}. The rows below are the last good answer`}
          onRetry={refreshLatency}
          className="mb-3"
        />
      )}

      <Card padding="md">
        {/* The one compact selector row this page is allowed. */}
        <Inline gap="sm" align="center" wrap className="mb-3">
          <Select
            size="sm"
            aria-label="Filter by agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            options={[{ value: 'all', label: 'All agents' }, ...agentOptions]}
            className="w-[180px]"
          />
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Filter tools…"
            aria-label="Filter by tool name"
            className="w-[220px]"
          />
          {/* FilterChip, not a Chip with a click handler: it renders a real
              button, so it is in the tab order and answers Enter/Space
              without this page reimplementing either. */}
          <FilterChip
            active={failingOnly}
            size="sm"
            onClick={() => setFailingOnly((v) => !v)}
            data-testid="failing-only"
          >
            Failing only
          </FilterChip>
          <T className="text-[11px] text-text-tertiary">
            {`${fmtInt(visibleRows.length)} of ${fmtInt(rows.length)} tools`}
          </T>
        </Inline>

        {visibleRows.length === 0 ? (
          <SmartEmptyState
            title={filtered ? 'No tool matches these filters' : 'No tool calls in this window'}
            detail={
              filtered
                ? 'Widen the window, clear the search, or pick All agents.'
                : 'Tool calls are recorded from agent spans. Widen the window, or run traffic through the fleet.'
            }
            degraded={tableBlind}
            degradedWhat="the tool-call rollup"
            degradedSource={SOURCE}
            onRetry={refreshLatency}
            actions={filtered ? [] : [
              {
                label: 'Run the test harness',
                code: 'python3 infra/scripts/harness.py run --mode live --label "tool-calls@$(git rev-parse --short HEAD)"',
              },
              { label: 'Ask an agent something', href: '/iq/invoke' },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Tool</TableTh>
                <TableTh>Calls</TableTh>
                <TableTh>Volume</TableTh>
                <TableTh>P50</TableTh>
                <TableTh>P99</TableTh>
                <TableTh>Error rate</TableTh>
                <TableTh>Cost</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleRows.map((r) => (
                <TableRow key={r.toolName}>
                  <TableTd className="text-[12px] font-medium font-mono whitespace-nowrap">
                    {r.toolName}
                  </TableTd>
                  <TableTd className="text-[12px] text-text-secondary tabular-nums">
                    {fmtInt(r.count)}
                  </TableTd>
                  <TableTd>
                    {/* Shape over the window, per tool. A tool that ran once
                        and a tool that runs every hour both report a count;
                        only the series tells them apart. */}
                    {(series.get(r.toolName)?.length ?? 0) > 1 ? (
                      <Sparkline
                        data={series.get(r.toolName) ?? []}
                        width={72}
                        height={18}
                        color="var(--color-brand)"
                      />
                    ) : (
                      <T className="text-[11px] text-text-tertiary">—</T>
                    )}
                  </TableTd>
                  <TableTd className="text-[12px] text-text-secondary tabular-nums">
                    {fmtMs(r.p50DurationMs)}
                  </TableTd>
                  <TableTd>
                    <Chip tone={latencyTone(r.p99DurationMs)} size="xs">
                      {fmtMs(r.p99DurationMs)}
                    </Chip>
                  </TableTd>
                  <TableTd>
                    {r.errorRate > 0 ? (
                      <Chip tone={errorTone(r.errorRate)} size="xs">{fmtPct(r.errorRate)}</Chip>
                    ) : (
                      <T className="text-[12px] text-text-tertiary tabular-nums">0%</T>
                    )}
                  </TableTd>
                  <TableTd
                    className="text-[12px] text-text-secondary tabular-nums"
                    title={r.withCost === 0
                      ? 'No priced rows — this tool spends no model tokens'
                      : `${fmtInt(r.withCost)} of ${fmtInt(r.count)} calls carried a cost estimate`}
                  >
                    {fmtToolCost(r.totalCostUsd, r.withCost)}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md">
        <CardHeader
          title="Tool errors"
          subtitle={`newest first · the server returns the last ${ERROR_LIMIT} errored calls regardless of the window, so the agent and tool filters are applied here`}
          meta={
            errorPanelBlind ? (
              <Chip tone="danger" size="xs">unknown</Chip>
            ) : (
              // A green 0 is a claim about the fleet, so it is reserved for a
              // fleet with no recorded errors at all. Zero because the agent
              // or tool filter hid fourteen of them is neutral, not good news.
              <Chip
                tone={allErrors.length === 0 ? 'success' : visibleErrors.length === 0 ? 'neutral' : 'danger'}
                size="xs"
              >
                {fmtInt(visibleErrors.length)}
              </Chip>
            )
          }
        />
        {errorPanelBlind && visibleErrors.length > 0 && (
          <UnavailableNotice
            error={errorPanelBlind}
            what="a fresh tool error list"
            source={`${SOURCE}. The errors below are the last good answer`}
            onRetry={refreshErrors}
            className="mb-3"
          />
        )}
        {visibleErrors.length === 0 ? (
          <SmartEmptyState
            // The good-news empty, said plainly. This is the sentence the
            // whole degraded-marker exercise exists to protect: it may only
            // appear when the read actually succeeded.
            title={
              allErrors.length > 0
                ? 'No errors match these filters'
                : rows.length === 0
                  ? 'No tool errors — but no tool calls either'
                  : 'No tool errors — every recorded tool call succeeded'
            }
            detail={
              allErrors.length > 0
                ? `${fmtInt(allErrors.length)} errored call${allErrors.length === 1 ? '' : 's'} are recorded, but none from this agent or matching this tool name.`
                // "Every call succeeded" is a real claim and is only worth
                // making when calls exist; with an empty rollup above it, the
                // honest reading is that there was nothing to fail.
                : rows.length === 0
                  ? 'Nothing has been recorded to fail — the rollup above is empty too, so this is an idle fleet rather than a clean one.'
                  : `The last ${ERROR_LIMIT} tool calls the fleet recorded all returned without an error.`
            }
            degraded={errorPanelBlind}
            degradedWhat="the tool error list"
            degradedSource={SOURCE}
            onRetry={refreshErrors}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Tool</TableTh>
                <TableTh>Error</TableTh>
                <TableTh>Invocation</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleErrors.map((e) => (
                <TableRow key={e.toolCallId}>
                  <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                    {fmtTs(e.ts)}
                  </TableTd>
                  <TableTd className="text-[12px] font-mono whitespace-nowrap">{e.agentId || '—'}</TableTd>
                  <TableTd className="text-[12px] font-mono whitespace-nowrap">{e.toolName}</TableTd>
                  <TableTd className="text-[12px] text-text-secondary">
                    {e.errorMessage ?? 'errored with no message'}
                  </TableTd>
                  <TableTd className="whitespace-nowrap">
                    <Link
                      to={`/admin/observability/invocations/${encodeURIComponent(e.invocationId)}`}
                      className="text-primary text-[12px] font-mono no-underline px-1 py-0.5"
                    >
                      {e.invocationId}
                    </Link>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageSection>
  );
}

export default ToolCallsPage;
