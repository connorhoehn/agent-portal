// ToolWaterfall — an invocation's tool calls as the library TraceTimeline
// (ui-components 2.410.0): By time / By duration toggle, pass/fail colouring,
// a right-hand duration column and the error message on failed rows. This file
// only maps tool calls onto spans; it draws nothing itself.

import { useMemo } from 'react';
import { EmptyState } from '@connorhoehn/ui-components/shared';
import { TraceTimeline, type TraceSpan } from '@connorhoehn/ui-components/agents';

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  durationMs: number | null;
  errored: boolean;
  errorMessage?: string | null;
}

interface Props {
  toolCalls: ToolCall[];
}

const finite = (n: number | null): number => (n != null && Number.isFinite(n) ? n : 0);

export function ToolWaterfall({ toolCalls }: Props) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const trace = useMemo(() => {
    const ordered = calls
      .map((c) => ({ c, start: Date.parse(c.startedAt) }))
      .sort((a, b) => (Number.isFinite(a.start) ? a.start : 0) - (Number.isFinite(b.start) ? b.start : 0));
    const t0 = ordered.find((o) => Number.isFinite(o.start))?.start ?? 0;
    const spans: TraceSpan[] = ordered.map(({ c, start }) => {
      const s = Number.isFinite(start) ? start : t0;
      const d = finite(c.durationMs);
      return {
        traceId: 'tool-calls', spanId: c.toolCallId, name: c.toolName, kind: 'tool',
        startTime: new Date(s).toISOString(), endTime: new Date(s + d).toISOString(), durationMs: d,
        status: c.errored ? 'error' : 'ok',
        attributes: { errorMessage: c.errored ? (c.errorMessage ?? 'errored') : '' },
      };
    });
    const end = Math.max(t0 + 1, ...spans.map((s) => Date.parse(s.endTime)));
    return { traceId: 'tool-calls', rootSpanId: spans[0]?.spanId ?? '', spans, totalDurationMs: end - t0,
      agentId: '', startedAt: new Date(t0).toISOString() };
  }, [calls]);

  if (calls.length === 0) {
    return <EmptyState title="No tool calls recorded for this invocation." />;
  }
  return <TraceTimeline trace={trace} title="Tool calls" legendKinds={['tool']} scaleToggle colorByStatus durationColumn
    errorText={(span) => String(span.attributes.errorMessage || 'errored')} />;
}

export default ToolWaterfall;
