/**
 * RangeSliderFrame — a labelled range input with its current value.
 *
 * Composed locally because ui-components exports `Slider` only from the
 * package root, and importing the root pulls the `@tiptap/react` chunk into
 * `vite build` (queued in docs/ui-components-queue.md). Replace with
 * `Slider` from `/shared` once it is exported there.
 */
import type { ReactNode } from 'react';

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
    <label
      title={title}
      className={`inline-flex items-center gap-1 text-text-secondary ${disabled ? 'opacity-[0.35]' : ''} ${className}`}
    >
      {label}
      <input
        type="range"
        aria-label={ariaLabel ?? label}
        className="w-20 accent-primary"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span className="min-w-4 text-right tabular-nums">{valueLabel}</span>
    </label>
  );
}
