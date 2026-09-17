// How much of a machine is left, as a thing you can see rather than read.
//
// Load and memory were bare figures — `0.59`, `41%`, with the denominator in
// grey underneath. Correct, and nothing you can scan: deciding whether a
// machine has room for another job meant reading two numbers per row and doing
// the division yourself. On a fleet table that is the whole job of the column.
//
// A thin bar under the figure answers it at a glance, and colours itself once
// the machine is genuinely under pressure.
//
// This is the library's ProgressBar. It was briefly a hand-rolled pair of
// divs, justified as "deliberately not a full ProgressBar: no label, no ratio
// text" — but bare is what `label` omitted and `showRatio={false}` already
// give you, so the justification described a component that does exactly this.
// The hand-rolled version also carried the page directory's only inline style
// prop, for a width ProgressBar computes itself. (Naming that prop literally
// here would itself trip validate-component-discipline.sh, which greps the
// file rather than its syntax tree — so this paragraph spells it out instead.)

import { ProgressBar, Stack, T } from '@connorhoehnslalom/ui-components/shared';

/**
 * Where a reading stops being comfortable.
 *
 * Under 60% is headroom and gets no colour at all — a table where most rows
 * are tinted teaches you nothing. Amber from 60, red from 85: a machine over
 * 85% will be slow to pick anything else up.
 */
const CAUTION_AT = 60;
const PRESSURE_AT = 85;

function toneFor(pct: number): string {
  if (pct >= PRESSURE_AT) return 'var(--color-danger)';
  if (pct >= CAUTION_AT) return 'var(--color-caution)';
  return 'var(--color-border-emphasis)';
}

export interface HeadroomBarProps {
  /** The headline figure, already formatted — `0.59`, `41%`. */
  value: string;
  /** Fullness 0-100. Null when the machine did not report enough to know. */
  pct: number | null;
  /** The denominator, in the machine's own terms — `6% of 10`, `13G of 32G`. */
  detail: string;
  'aria-label': string;
}

export function HeadroomBar({ value, pct, detail, 'aria-label': ariaLabel }: HeadroomBarProps) {
  const clamped = pct == null ? null : Math.max(0, Math.min(100, pct));
  return (
    <Stack gap="xs" className="min-w-[72px]">
      <T className="text-[13px] tabular-nums">{value}</T>
      {clamped != null && (
        <ProgressBar
          value={clamped}
          max={100}
          size="sm"
          color={toneFor(clamped)}
          showRatio={false}
          aria-label={ariaLabel}
        />
      )}
      <T className="text-[11px] text-text-tertiary">{detail}</T>
    </Stack>
  );
}
