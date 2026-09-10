// DecisionHistoryPanel — right-side rail listing controller decisions newest
// first. Collapsible when empty (or manually toggled).

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Button, Chip, Inline, MetaLine, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCanaryStore } from './canaryStore.js';
import type { ControllerAction, Decision } from './types.js';

// A Chip tone per action, replacing a bg/fg colour pair each. SKIPPED_OVERRIDE
// was a literal indigo with no tone to match; `accent` is the closest the scale
// offers and it is the one entry that changes shade here.
const ACTION_TONE: Record<ControllerAction, 'success' | 'danger' | 'warning' | 'accent' | 'neutral'> = {
  PROMOTE: 'success',
  ROLLBACK: 'danger',
  HOLD: 'warning',
  SKIPPED_OVERRIDE: 'accent',
  SKIPPED_COOLDOWN: 'neutral',
  SKIPPED_NO_SAMPLES: 'neutral',
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString();
}

export function DecisionHistoryPanel(): React.ReactElement {
  const decisions = useCanaryStore((s) => s.recentDecisions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLenRef = useRef(0);
  // Start expanded so users can see what the panel does.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (decisions.length > lastLenRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      // Auto-expand when the first decision arrives.
      if (lastLenRef.current === 0) setCollapsed(false);
    }
    lastLenRef.current = decisions.length;
  }, [decisions.length]);

  const ordered: Decision[] = decisions.slice().reverse();

  return (
    // The collapsed/expanded width is animated from state, so it stays a style;
    // everything else about the panel is a class now.
    <Stack
      gap="none"
      className="h-full bg-surface border-l border-border shrink-0 transition-[width] duration-200"
      style={{ width: collapsed ? 44 : 320 }}
    >
      <Inline
        gap="sm"
        wrap={false}
        justify={collapsed ? 'center' : 'between'}
        className="px-3.5 py-2.5 border-b border-border cursor-pointer"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand decision history' : 'Collapse'}
      >
        {collapsed ? (
          <Inline as="span" gap="none" className="text-[13px] text-text-tertiary" title="Decision history">⟩</Inline>
        ) : (
          <>
            <Inline as="span" gap="none" className="text-[12px] font-semibold text-text-primary">
              Decision history
            </Inline>
            <Inline gap="xs" wrap={false}>
              <Chip tone="neutral" size="xs">{ordered.length}</Chip>
              <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">⟨</Inline>
            </Inline>
          </>
        )}
      </Inline>
      {!collapsed && (
        <Stack ref={scrollRef} gap="none" className="flex-1 overflow-y-auto py-2">
          {ordered.length === 0 ? (
            <Stack gap="sm" className="px-3.5 py-5 text-center">
              <MetaLine
                className="italic leading-normal"
                items={['The controller compares rolling A/B judge scores and automatically adjusts '
                  + 'traffic — PROMOTE shifts more to B, ROLLBACK pins back to A, HOLD waits for more data.']}
              />
              <MetaLine
                className="italic leading-normal"
                items={[<>Click <b>▶ Scenarios</b> in the toolbar, generate a set of people, then hit <b>Run all</b> to generate traffic and trigger decisions.</>]}
              />
            </Stack>
          ) : (
            ordered.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} d={d} index={i} />)
          )}
        </Stack>
      )}
    </Stack>
  );
}

function DecisionRow({ d, index }: { d: Decision; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(index === 0); // newest starts expanded
  const toggle = useCallback(() => setExpanded(v => !v), []);

  return (
    <Button
      variant="ghost"
      size="sm"
      fullWidth
      onClick={toggle}
      aria-expanded={expanded}
      className="flex-col items-start gap-1 justify-start text-left px-3.5 py-2 border-b border-border rounded-none"
    >
      <Inline gap="sm" justify="between" wrap={false} className="w-full">
        <Inline as="span" gap="none" className="text-[10.5px] text-text-tertiary tabular-nums">
          {fmtTime(d.ts)}
        </Inline>
        <Chip tone={ACTION_TONE[d.action]} size="xs">{d.action}</Chip>
        <Inline as="span" gap="none" aria-hidden className="ml-auto text-[10px] text-text-tertiary">
          {expanded ? '▲' : '▼'}
        </Inline>
      </Inline>
      <Inline gap="xs" wrap={false} className="w-full text-[11px] text-text-secondary tabular-nums">
        <Inline as="span" gap="none" className="font-medium">B {d.from}%</Inline>
        <Inline as="span" gap="none" className="text-text-tertiary">→</Inline>
        <Inline as="span" gap="none" className="font-medium">{d.to}%</Inline>
        {d.deltaScore !== undefined && (
          <Inline as="span" gap="none" title="composite_b - composite_a"
            className="ml-auto text-[10.5px] text-text-tertiary">
            Δ {d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(2)}
          </Inline>
        )}
      </Inline>
      {expanded && (
        <Stack gap="xs" className="mt-1 w-full">
          <Inline as="span" gap="none" className="text-[11.5px] text-text-secondary italic leading-snug">
            {d.reason}
          </Inline>
          {d.deltaScore !== undefined && (
            <Inline as="span" gap="none" className="text-[10.5px] text-text-tertiary">
              Score delta (composite_b − composite_a):{' '}
              <b className="tabular-nums">{d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(4)}</b>
            </Inline>
          )}
          <Inline as="span" gap="none" className="text-[10px] text-text-tertiary tabular-nums">
            {new Date(d.ts).toLocaleString()}
          </Inline>
        </Stack>
      )}
    </Button>
  );
}

