// A six-step workflow as a connected timeline, sized for a table cell.
//
// The desk's Step column has to answer one question at a glance — "where is
// this team?" — inside ~150px. `WorkflowStepper`, the library's stepper,
// renders every step's label, so at that width it scrolled horizontally
// INSIDE the cell: the labels past the cap were unreachable without finding
// a near-invisible scrollbar, and half the rows showed a stepper already
// scrolled to "Publish · Follow-up" with no sign that earlier steps existed
// to the left.
//
// So the labels collapse to one — the step the team is actually on, which is
// the answer the column exists for — and the ladder itself becomes dots on a
// connector: done is a filled check, current is a ring, ahead is an empty
// outline. Six dots and five connectors measure ~134px, so the cell never
// scrolls at any table width.
//
// Composed locally because the library has no dots-and-connector stepper —
// `WorkflowStepper` is the labelled rail and has no prop to suppress its
// labels. Queued in docs/ui-components-queue.md; this file is the exemption
// that row mints, which is why the two raw spans below are allowed here and
// nowhere else.

import { Fragment } from 'react';
import { Inline, Stack, T, Tooltip, type WorkflowStep } from '@connorhoehnslalom/ui-components/shared';

/** Ring/fill per state, in library tokens so the timeline follows the theme. */
function dotClass(step: WorkflowStep): string {
  if (step.done) return 'bg-success border-success text-white';
  if (step.active) return 'bg-surface border-info ring-2 ring-info/30 text-info';
  return 'bg-surface border-border text-transparent';
}

export function WorkflowTimeline({ steps, testId }: { steps: WorkflowStep[]; testId?: string }) {
  if (steps.length === 0) return null;
  // The label is the step in progress; once every step is done the ladder is
  // finished and the last one is what it finished on — never a blank caption.
  const current = steps.find((s) => s.active) ?? steps[steps.length - 1];
  const total = steps.length;

  return (
    <Stack gap="none" data-testid={testId}>
      <T className="text-[11px] font-medium text-text-primary truncate leading-tight">
        {current.label}
      </T>
      <Inline gap="none" align="center" wrap={false} className="mt-1">
        {steps.map((s, i) => (
          <Fragment key={s.step}>
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`h-px w-2.5 shrink-0 ${steps[i - 1].done ? 'bg-success' : 'bg-border'}`}
              />
            )}
            <Tooltip
              placement="top"
              content={`${s.step} · ${s.label}${s.active ? ' — current step' : s.done ? ' — done' : ' — not started'}`}
            >
              <span
                // The label is gone from the cell, so each dot carries its own
                // accessible name — a screen reader must not be handed six
                // unlabelled circles just because the column got narrower.
                role="img"
                aria-label={`Step ${s.step} of ${total}: ${s.label}${s.active ? ', current step' : s.done ? ', done' : ', not started'}`}
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[8px] font-bold leading-none ${dotClass(s)}`}
              >
                {s.done ? '✓' : s.active ? '●' : ''}
              </span>
            </Tooltip>
          </Fragment>
        ))}
      </Inline>
    </Stack>
  );
}
