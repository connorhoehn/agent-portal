/**
 * RangeSliderFrame — a labelled range input with its current value.
 *
 * This used to hand-roll the whole thing, with a note saying "replace with
 * `Slider` from `/shared` once it is exported there". As of 2.241.0 it is: the
 * track below is the library control, and the raw `<input type="range">` and
 * its hand-set `accent-primary` are gone.
 *
 * The wrapper stays because `Slider` has no `label` slot and no `id`, so a
 * caller who wants a visible label beside the track — which all five call
 * sites do — still has to compose one. That gap is filed in
 * docs/ui-components-queue.md; if Slider grows a label slot this file becomes
 * a direct re-export.
 */
import type { ReactNode } from 'react';
import { Inline, Slider } from '@connorhoehnslalom/ui-components/shared';

export interface RangeSliderFrameProps {
  label: string;
  /** Accessible name; defaults to `label`. */
  ariaLabel?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  /** Rendered after the track (the formatted value). */
  valueLabel: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function RangeSliderFrame({
  label, ariaLabel, min, max, step = 1, value, onChange, valueLabel, disabled, title, className = '',
}: RangeSliderFrameProps) {
  return (
    // `as="label"` keeps clicking the text focused on the control, which the
    // native <label> gave for free.
    <Inline
      as="label"
      gap="xs"
      wrap={false}
      title={title}
      className={`inline-flex text-text-secondary ${disabled ? 'opacity-[0.35]' : ''} ${className}`}
    >
      {label}
      <Slider
        aria-label={ariaLabel ?? label}
        className="w-20"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
      <Inline as="span" gap="none" className="min-w-4 text-right tabular-nums">{valueLabel}</Inline>
    </Inline>
  );
}
