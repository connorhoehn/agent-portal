// How much of a machine is left, as a thing you can see rather than read.
//
// Load and memory were bare figures — `0.59`, `41%`, with the denominator in
// grey underneath. Correct, and nothing you can scan: deciding whether a
// machine has room for another job meant reading two numbers per row and doing
// the division yourself. On a fleet table that is the whole job of the column.
//
// A four-pixel bar under the figure answers it at a glance, and colours itself
// once the machine is genuinely under pressure. Deliberately not a full
// ProgressBar: no label, no ratio text, nothing that repeats what the line
// above already says.

import { T } from '@connorhoehnslalom/ui-components/shared';

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
    <div className="flex min-w-[72px] flex-col gap-1">
      <T className="text-[13px] tabular-nums">{value}</T>
      {clamped != null && (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-surface-panel"
          role="meter"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={ariaLabel}
        >
          <div
            className="h-full rounded-full transition-[width]"
            style={{ width: `${clamped}%`, background: toneFor(clamped) }}
          />
        </div>
      )}
      <T className="text-[11px] text-text-tertiary">{detail}</T>
    </div>
  );
}
