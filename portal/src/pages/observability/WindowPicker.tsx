// The time-window picker every observability page carries in its header.
//
// Six pages each kept a private copy of this as a row of Buttons whose
// variant flipped on the active one — a segmented control drawn by hand,
// six times. One setting with a few values is what the library's
// SegmentedControl is for: one `role="group"` with a name, aria-pressed on
// the chosen value, and one place to change how it looks.
import { SegmentedControl } from '@connorhoehnslalom/ui-components/shared';

export interface WindowOption {
  label: string;
}

export function WindowPicker({
  options,
  value,
  onChange,
  label = 'Time window',
}: {
  options: readonly WindowOption[];
  /** Index into `options` — the pages key their bucket/hours tables by it. */
  value: number;
  onChange: (index: number) => void;
  label?: string;
}) {
  return (
    <SegmentedControl
      size="sm"
      aria-label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={options.map((o, i) => ({ label: o.label, value: String(i) }))}
    />
  );
}
