// KeyValue — one labelled fact: a SectionLabel caption and a value.
//
// Three pages had grown their own copy of this (AgentDetailPage `Kv`,
// MemoryPage `MetaRow`, WorkItemDrawer `Field`), each with its own label
// size, case and column width, so the same "Model: nova-pro" read three
// different ways across the app. ui-components has no key-value composite
// (DetailSection is a titled block, not a fact; DataTable is for rows) — see
// docs/ui-components-queue.md — so it is composed ONCE here from Stack /
// Inline / SectionLabel and consumed everywhere a page states a fact.
//
//   stack (default)      row
//   MODEL                MODEL  nova-pro
//   nova-pro

import type { ReactNode } from 'react';
import { Inline, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';

export interface KeyValueProps {
  label: string;
  /** The fact. `children` is the same slot for callers that nest markup. */
  value?: ReactNode;
  children?: ReactNode;
  /** Monospace value — ids, shas, model ids. */
  mono?: boolean;
  /** `stack` puts the label above the value; `row` puts it to the left. */
  layout?: 'stack' | 'row';
  /** Row layout only: the label column's Tailwind width class. */
  labelWidth?: string;
  /** Stack layout only: clip a long value to one line (the full text goes in `title`). */
  truncate?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function KeyValue({
  label, value, children, mono = false, layout = 'stack', labelWidth = 'w-20', truncate = true, className, 'data-testid': testId,
}: KeyValueProps) {
  const body = value ?? children;
  const title = truncate && typeof body === 'string' ? body : undefined;
  if (layout === 'row') {
    return (
      <Inline gap="sm" align="baseline" wrap={false} className={className} data-testid={testId}>
        <SectionLabel className={`${labelWidth} shrink-0`}>{label}</SectionLabel>
        <Inline as="span" gap="none" className={`min-w-0 flex-1 text-[12px] text-text-primary ${mono ? 'font-mono' : ''}`}>{body}</Inline>
      </Inline>
    );
  }
  return (
    <Stack gap="none" className={`min-w-0 ${className ?? ''}`} data-testid={testId}>
      <SectionLabel>{label}</SectionLabel>
      <Inline as="span" gap="none" className={`mt-0.5 text-[12px] text-text-primary ${truncate ? 'truncate' : ''} ${mono ? 'font-mono' : ''}`} title={title}>
        {body}
      </Inline>
    </Stack>
  );
}

export default KeyValue;
