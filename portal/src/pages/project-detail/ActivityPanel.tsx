// What this initiative has actually been doing, day by day.
//
// The rollup answers "where does it stand" — points, spend, open decisions —
// but every one of those is a single number, and a single number cannot say
// whether the initiative is accelerating, stalled, or was busy a month ago and
// quiet since. Three lines over one window answer that at a glance: money
// going out, agents running, work coming out the other end.
//
// The three are deliberately on the SAME window and stacked. Spend without
// throughput is just a bill; throughput without spend hides what it cost. Read
// together, a spend line climbing while the completed line stays flat is the
// shape worth noticing.
//
// The series are derived from the runs and work tree the page already holds,
// not from an endpoint of their own — the numbers a graph draws should be the
// same numbers the rest of the page is showing, and deriving them from the
// same objects is what guarantees that.

import { useMemo, useState } from 'react';
import { MetricsGraph } from '@connorhoehnslalom/ui-components/observability';
import { Card, EmptyState, Inline, SectionLabel, SegmentedControl, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { BotRun } from '../bots/BotsPage';
import { T } from './Text';
import { activityBuckets, flattenWorkItems } from './projectFormat';
import type { WorkItemTree } from './types';

function Total({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Stack gap="none">
      <SectionLabel as="div">{label}</SectionLabel>
      <Inline gap="xs" align="baseline" wrap={false}>
        <T className="text-[15px] font-bold tabular-nums text-text-primary">{value}</T>
        {hint && <T className="text-[11px] text-text-tertiary">{hint}</T>}
      </Inline>
    </Stack>
  );
}

// The window is the reader's to choose. 30 days is the right default for a
// live initiative, but a quiet one that finished its work last quarter reads
// as "nothing ever happened" at 30 and as a real history at 180.
const WINDOWS = [
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '180', label: '180d' },
];

export function ActivityPanel({
  runs,
  workTree,
  defaultDays = 30,
  compact = false,
}: {
  runs: BotRun[];
  workTree: WorkItemTree[];
  defaultDays?: 30 | 90 | 180;
  /** Rail form: the same three lines and totals sized for a 300px column. */
  compact?: boolean;
}) {
  const [days, setDays] = useState<number>(defaultDays);
  const buckets = useMemo(
    () => activityBuckets(runs, flattenWorkItems(workTree), days),
    [runs, workTree, days],
  );

  // All-zero is a real answer — an initiative that has not run anything yet —
  // but three flat lines and a row of zeroes is a worse way to say "nothing
  // yet" than saying it in words.
  const idle = buckets.totals.runs === 0 && buckets.totals.completed === 0;

  return (
    <Card padding={compact ? 'sm' : 'md'}>
      <Stack gap={compact ? 'sm' : 'md'}>
        <Inline gap="sm" align="center" justify="between" wrap={compact}>
          {compact
            ? <SectionLabel className="text-[10px] font-semibold tracking-wide">Activity</SectionLabel>
            : <T className="text-[13px] font-semibold text-text-primary">Activity</T>}
          <SegmentedControl
            size="sm"
            options={WINDOWS}
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
          />
        </Inline>
        {idle ? (
          compact
            ? <T className="text-[12px] text-text-tertiary" wrap>No runs and no work completed in the last {days} days.</T>
            : <EmptyState
                title={`No activity in the last ${days} days`}
                body="No agent runs and no work completed in this window. Dispatch a story, or let a scheduled bot fire, and it will show up here."
              />
        ) : (
          <>
            <Inline gap={compact ? 'md' : 'lg'} align="center" wrap={compact}>
              <Total label="Agent spend" value={`$${buckets.totals.spendUsd.toFixed(2)}`} hint={`over ${days}d`} />
              <Total label="Runs" value={String(buckets.totals.runs)} />
              <Total label="Completed" value={String(buckets.totals.completed)} hint="items" />
              {!compact && (
                <T className="text-[11px] text-text-tertiary">
                  {buckets.labels[0]} → {buckets.labels[buckets.labels.length - 1]}
                </T>
              )}
            </Inline>
            <MetricsGraph
              title={`Last ${days} days`}
              yLabel="per day"
              // In the work pane (~800px) a 440px line read as a rendering
              // fault; in the 300px rail the line fills the card's width.
              sparkWidth={compact ? 250 : 680}
              sparkHeight={compact ? 26 : 30}
              series={[
                { label: 'Spend', data: buckets.spendUsd, color: 'var(--color-primary)' },
                { label: 'Runs', data: buckets.runs, color: 'var(--color-info)' },
                { label: 'Completed', data: buckets.completed, color: 'var(--color-success)' },
              ]}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}
