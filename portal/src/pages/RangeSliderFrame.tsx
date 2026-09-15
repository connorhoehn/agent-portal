/**
 * RangeSliderFrame — a labelled range input with its current value.
 *
 * This used to hand-roll the whole thing, with a note saying "replace with
 * `Slider` from `/shared` once it is exported there". As of 2.241.0 it is: the
 * track below is the library control, and the raw range input and
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
      // shrink-0: a toolbar that runs out of room must wrap this control, not
      // squeeze it — squeezed, the value ran over the end of the track.
      className={`inline-flex shrink-0 text-text-secondary ${disabled ? 'opacity-[0.35]' : ''} ${className}`}
    >
      {label}
      <Slider
        aria-label={ariaLabel ?? label}
        // The library Slider prints its own readout by default; this frame
        // prints the FORMATTED value after the track (0.60, not 60), so the
        // built-in one is switched off — with both on, the raw number sat on
        // the track's end and ran into the next control's label.
        readout={false}
        // The library's range input takes the wrapper's width since 2.261.0
        // (`w-full min-w-0`), so the box can be as narrow as the toolbar
        // wants without the track overflowing it.
        className="w-28"
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
