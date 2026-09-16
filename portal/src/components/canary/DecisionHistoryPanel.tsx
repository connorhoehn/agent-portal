// DecisionHistoryPanel — right-side rail listing controller decisions newest
// first. Collapsible when empty (or manually toggled).

import { useEffect, useRef, useState } from 'react';
import {
  Chip, Inline, MetaLine, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCanaryStore } from './canaryStore.js';
import { DecisionRow } from './DecisionRow.js';
import type { Decision } from './types.js';

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
            ordered.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} decision={d} variant="card" index={i} />)
          )}
        </Stack>
      )}
    </Stack>
  );
}

