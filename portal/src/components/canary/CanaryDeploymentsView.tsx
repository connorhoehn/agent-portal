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

import { useState } from 'react';
import {
  Button, Card, Chip, EmptyState, EntityCell, Inline, MetaLine, Stack, Table, TableBody, TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { useCanaryStore } from './canaryStore.js';
import type { ControllerAction, Decision } from './types.js';

// ── Action metadata ───────────────────────────────────────────────────────────

const ACTION_META: Record<ControllerAction, { label: string; tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral' }> = {
  PROMOTE:            { label: 'Promote',        tone: 'success' },
  ROLLBACK:           { label: 'Rollback',       tone: 'danger' },
  HOLD:               { label: 'Hold',           tone: 'warning' },
  // These carried literal light-mode hex (#e0e7ff / #3730a3), which paints
  // the same in dark mode and read as a bright card on a dark table. A tone
  // follows the theme.
  SKIPPED_OVERRIDE:   { label: 'Skip — override', tone: 'info' },
  SKIPPED_COOLDOWN:   { label: 'Skip — cooldown', tone: 'neutral' },
  SKIPPED_NO_SAMPLES: { label: 'Skip — no data',  tone: 'neutral' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function DeltaCell({ delta }: { delta: number | undefined }): React.ReactElement {
  if (delta === undefined) return <MetaLine size="xs" items={['—']} />;
  const cls =
    delta > 0.005 ? 'text-success' :
    delta < -0.005 ? 'text-danger' :
    'text-text-secondary';
  return (
    <EntityCell label={`${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`} labelClassName={`tabular-nums ${cls}`} />
  );
}

// ── Decision row (collapsible reason) ────────────────────────────────────────

function DecisionRow({ decision, index }: { decision: Decision; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(index === 0 && !!decision.reason);
  const meta = ACTION_META[decision.action];
  const hasReason = !!decision.reason;

  const trafficClass =
    decision.to > decision.from ? 'text-success' :
    decision.to < decision.from ? 'text-danger' :
    'text-text-secondary';

  return (
    <>
      {/* Hover used to be two imperative handlers assigning
          `currentTarget.style.background`; the library's row owns that. */}
      <TableRow aria-expanded={hasReason ? expanded : undefined}>
        <TableTd><MetaLine size="xs" className="tabular-nums" items={[fmtDate(decision.ts)]} /></TableTd>
        <TableTd><Chip size="xs" tone={meta.tone}>{meta.label}</Chip></TableTd>
        <TableTd>
          <Inline gap="xs" align="center" className="tabular-nums">
            <MetaLine size="sm" tone="secondary" items={[`${decision.from}%`]} />
            <MetaLine size="xs" items={['→']} />
            <EntityCell label={`${decision.to}%`} labelClassName={trafficClass} />
          </Inline>
        </TableTd>
        <TableTd align="center"><DeltaCell delta={decision.deltaScore} /></TableTd>
        <TableTd className="max-w-0">
          {hasReason
            ? <MetaLine size="xs" className="truncate italic" items={[decision.reason]} />
            : <MetaLine size="xs" items={['—']} />}
        </TableTd>
        <TableTd align="center" className="w-7">
          {hasReason && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse reason' : 'Expand reason'}
              onClick={() => setExpanded(v => !v)}
            >
              <span aria-hidden="true">{expanded ? '▲' : '▼'}</span>
            </Button>
          )}
        </TableTd>
      </TableRow>
      {expanded && hasReason && (
        <TableRow>
          <TableTd colSpan={6}>
            <MetaLine size="sm" tone="secondary" className="italic leading-relaxed" items={[decision.reason]} />
          </TableTd>
        </TableRow>
      )}
    </>
  );
}

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
          <EntityCell label="Canary Deployments" labelClassName="text-base" />
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
            <Link to="/iq/canary" className="text-primary no-underline hover:underline text-[12px]">● Live view</Link>
          )}
          <Link to="/iq/canary" className="text-primary no-underline hover:underline text-[12px]">
            {experimentState === 'setup' ? '+ New experiment' : 'View experiment'}
          </Link>
        </Inline>
      </Inline>

      <Card padding="none" className="overflow-hidden">
        <Table>
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
              sorted.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} decision={d} index={i} />)
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
