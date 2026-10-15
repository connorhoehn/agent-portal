// CanaryDeploymentsView — Full-page table of controller decisions for the
// active canary experiment. Renders at /iq/canary?focus=decisions, bypassing
// the live graph and setup wizard entirely.
//
// Data source: canaryStore.recentDecisions — populated from Aurora via the
// decisions poller → broker ring buffer → SSE replay on connect. The store
// holds the last 20 decisions; the broker ring buffer holds the last 500
// events so a freshly-opened tab catches up from Aurora immediately.
//
// Empty table shown when Aurora has no decisions recorded yet.

import {
  Card, EmptyState, EntityCell, Inline, MetaLine, Stack, Table, TableBody, TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { useCanaryStore } from './canaryStore.js';
import { DecisionRow } from './DecisionRow.js';

// ── Empty state ───────────────────────────────────────────────────────────────

function DecisionsEmpty(): React.ReactElement {
  return (
    <TableRow>
      <TableTd colSpan={6}>
        <EmptyState
          icon="🧪"
          title="No canary decisions recorded yet"
          description="Start a canary experiment to let the automated controller evaluate A/B prompt performance. Each PROMOTE, ROLLBACK, or HOLD decision appears here as a row, sourced from observability.canary_decisions in Aurora."
          action={<Link to="/iq/canary" className="text-primary no-underline hover:underline">Configure experiment →</Link>}
        />
      </TableTd>
    </TableRow>
  );
}

// ── View ──────────────────────────────────────────────────────────────────────

export function CanaryDeploymentsView(): React.ReactElement {
  const decisions = useCanaryStore((s) => s.recentDecisions);
  const experimentState = useCanaryStore((s) => s.experimentState);
  // Newest-first display
  const sorted = [...decisions].reverse();

  return (
    <Stack gap="md" className="p-6">
      <Inline gap="md" align="start" justify="between">
        <Stack gap="none">
          <EntityCell label="Canary Deployments" labelClassName="text-sm" />
          <MetaLine
            size="sm"
            tone="secondary"
            items={[
              'Controller decisions from observability.canary_decisions',
              decisions.length > 0
                ? `${decisions.length} decision${decisions.length !== 1 ? 's' : ''} loaded`
                : null,
            ]}
          />
        </Stack>
        <Inline gap="sm" align="center">
          {experimentState === 'running' && (
            <Link to="/iq/canary" className="text-primary no-underline hover:underline text-xs">● Live view</Link>
          )}
          <Link to="/iq/canary" className="text-primary no-underline hover:underline text-xs">
            {experimentState === 'setup' ? '+ New experiment' : 'View experiment'}
          </Link>
        </Inline>
      </Inline>

      {/* `overflow-x-auto` (not `overflow-hidden`) so narrow viewports scroll
          the table horizontally instead of clipping the trailing columns —
          the six columns don't fit under ~1100px. */}
      <Card padding="none" className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHead>
            <TableRow>
              <TableTh className="w-[170px]">Time</TableTh>
              <TableTh className="w-[150px]">Outcome</TableTh>
              <TableTh className="w-[130px]">Traffic B</TableTh>
              <TableTh align="center" className="w-[90px]">Δ Score</TableTh>
              <TableTh>Reason</TableTh>
              <TableTh className="w-7" />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.length === 0 ? (
              <DecisionsEmpty />
            ) : (
              sorted.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} decision={d} variant="list" index={i} />)
            )}
          </TableBody>
        </Table>
      </Card>

      {decisions.length > 0 && (
        <MetaLine
          size="xs"
          items={[`Showing ${decisions.length} most recent decision${decisions.length !== 1 ? 's' : ''}. Decisions older than the current session are loaded from Aurora on connect.`]}
        />
      )}
    </Stack>
  );
}
