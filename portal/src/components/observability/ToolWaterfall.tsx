// ToolWaterfall — gantt-style horizontal bar chart for tool calls within an
// invocation. Each row is one tool call; the bar's horizontal position is
// proportional to startedAt within the overall span; bar length is durationMs.
//
// Bar color:
//   success (green) — !errored
//   danger  (red)   — errored
//
// If durations don't sum cleanly (sub-ms or missing values), we fall back to
// a small visible width so the row is still selectable/readable. Empty input
// renders an empty-state message.

import { useState } from 'react';
import {
  Button, EmptyState, Inline, MetaLine, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  durationMs: number | null;
  errored: boolean;
  errorMessage?: string | null;
}

type Mode = 'timeline' | 'duration';

interface Props {
  toolCalls: ToolCall[];
}

const fmtDur = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
};

export function ToolWaterfall({ toolCalls }: Props) {
  // Researcher-friendly mode toggle:
  //   timeline — bars positioned on real time axis (includes "thinking gaps"
  //              between tool calls). Useful for spotting slow agent
  //              deliberation between calls.
  //   duration — bars start at 0 and scale to max duration. Useful when you
  //              don't care WHEN each tool fired, only how long it took.
  const [mode, setMode] = useState<Mode>('timeline');

  const calls = Array.isArray(toolCalls) ? toolCalls : [];

  if (calls.length === 0) {
    return <EmptyState size="sm" title="No tool calls recorded for this invocation." />;
  }

  // Compute the overall time span. Defensive: parse may NaN.
  const starts = calls.map((c) => Date.parse(c.startedAt));
  const ends = calls.map((c, i) =>
    starts[i] + (c.durationMs != null && Number.isFinite(c.durationMs) ? c.durationMs : 0),
  );
  const validStarts = starts.filter((s) => Number.isFinite(s));
  const validEnds = ends.filter((e) => Number.isFinite(e));
  const t0 = validStarts.length > 0 ? Math.min(...validStarts) : 0;
  const t1 = validEnds.length > 0 ? Math.max(...validEnds) : t0 + 1;
  const totalSpanMs = Math.max(1, t1 - t0);
  // For duration mode: normalize each bar against the longest call.
  const maxDurationMs = Math.max(
    1,
    ...calls.map((c) => (c.durationMs != null && Number.isFinite(c.durationMs) ? c.durationMs : 0)),
  );

  // Order by start time so the visual descends chronologically.
  const ordered = calls
    .map((c, i) => ({ call: c, start: starts[i], end: ends[i] }))
    .sort((a, b) => {
      const sa = Number.isFinite(a.start) ? a.start : 0;
      const sb = Number.isFinite(b.start) ? b.start : 0;
      return sa - sb;
    });

  return (
    // The markup this replaces used `gridTemplateColumns: '140px 1fr 80px'`.
    // Fixed / flexible / fixed is what flex does natively, so the axis and bar
    // rows are Inline with a w-[140px] gutter, a flex-1 track and a w-20
    // duration — no grid needed and no style object.
    <Stack gap="xs">
      <Inline gap="xs" wrap className="mb-2">
        <Button
          variant={mode === 'timeline' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setMode('timeline')}
          title="Positions bars on real time. Gaps between bars = agent thinking time between tool calls."
        >
          By time
        </Button>
        <Button
          variant={mode === 'duration' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setMode('duration')}
          title="Each bar starts at 0; width scaled to longest call. Use when you only care about which tool was slow."
        >
          By duration
        </Button>
        <MetaLine
          size="xs"
          className="italic"
          items={[mode === 'timeline'
            ? 'Bars positioned on real time — gaps = agent deliberation.'
            : 'Bars normalized to longest call — pure duration ranking.']}
        />
      </Inline>

      <Inline gap="sm" wrap={false}>
        <Inline gap="none" className="w-[140px] shrink-0" />
        <Inline gap="none" className="relative flex-1 h-3 border-t border-dashed border-border">
          <SectionLabel className="absolute left-0">0ms</SectionLabel>
          <SectionLabel className="absolute right-0">
            {fmtDur(mode === 'timeline' ? totalSpanMs : maxDurationMs)}
          </SectionLabel>
        </Inline>
        <SectionLabel className="w-20 shrink-0 text-right">Duration</SectionLabel>
      </Inline>

      {ordered.map(({ call, start, end }) => {
        const safeStart = Number.isFinite(start) ? start : t0;
        const safeEnd = Number.isFinite(end) ? end : safeStart;
        let leftPct: number;
        let rawPct: number;
        if (mode === 'timeline') {
          leftPct = ((safeStart - t0) / totalSpanMs) * 100;
          rawPct = ((safeEnd - safeStart) / totalSpanMs) * 100;
        } else {
          leftPct = 0;
          const dur = call.durationMs != null && Number.isFinite(call.durationMs)
            ? call.durationMs : 0;
          rawPct = (dur / maxDurationMs) * 100;
        }
        // Even short calls get a small visible width so the bar is selectable.
        const widthPct = Math.max(rawPct, 0.5);
        // Show label inside bar if width is decently large; otherwise outside.
        const labelInside = widthPct >= 18;
        const title = call.errored
          ? `${call.toolName} — ${call.errorMessage ?? 'errored'} (${fmtDur(call.durationMs)})`
          : `${call.toolName} (${fmtDur(call.durationMs)})`;

        return (
          <Inline key={call.toolCallId} gap="sm" wrap={false} className="h-6 text-[11px]" title={title}>
            <Inline
              as="span"
              gap="none"
              title={call.toolName}
              className="w-[140px] shrink-0 font-mono text-[11px] text-text-secondary truncate"
            >
              {call.toolName}
            </Inline>
            <Inline gap="none" className="relative flex-1 h-[18px] bg-surface border border-border rounded-[3px] overflow-hidden">
              {/* left/width are percentages computed per call, and the colour
                  is pass/fail — all runtime, so they stay inline. */}
              <Inline
                gap="none"
                className={`absolute inset-y-0 rounded-sm px-1.5 min-w-[2px] ${call.errored ? 'bg-danger' : 'bg-success'}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              >
                {labelInside && (
                  <Inline as="span" gap="none" className="text-white text-[11px] font-medium font-mono truncate">
                    {call.toolName}
                  </Inline>
                )}
              </Inline>
              {!labelInside && (
                <Inline
                  as="span"
                  gap="none"
                  className="absolute top-0.5 text-[11px] font-mono text-text-secondary whitespace-nowrap pointer-events-none"
                  style={{ left: `calc(${leftPct + widthPct}% + 6px)` }}
                >
                  {call.toolName}
                </Inline>
              )}
            </Inline>
            <Inline
              as="span"
              gap="none"
              justify="end"
              className="w-20 shrink-0 text-[11px] text-text-tertiary font-mono whitespace-nowrap"
            >
              {fmtDur(call.durationMs)}
            </Inline>
          </Inline>
        );
      })}
    </Stack>
  );
}

export default ToolWaterfall;
