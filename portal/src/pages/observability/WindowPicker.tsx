// The time-window picker every observability page carries in its header.
//
// Six pages each kept a private copy of this as a row of Buttons whose
// variant flipped on the active one — a segmented control drawn by hand,
// six times. One setting with a few values is what the library's
// SegmentedControl is for: one `role="group"` with a name, aria-pressed on
// the chosen value, and one place to change how it looks.
import { SegmentedControl } from '@connorhoehnslalom/ui-components/shared';
import { useUrlState } from '../../lib/useUrlState';

export interface WindowOption {
  label: string;
}

/**
 * The six pages sharing `WindowPicker` also shared a private
 * `useState(windowIdx)` for it — a choice that was lost on refresh and not
 * restored by Back, unlike `AgentFlowPage.tsx`'s own window picker, which
 * has carried its choice as `?window=<label>` from the start. This is that
 * same convention, factored so a page just swaps its `useState` call for
 * this one: same `[index, setIndex]` shape the pages (and `WindowPicker`
 * itself) already expect, backed by the URL instead of local state. The
 * label (not the array index) is what's stored, so the URL stays meaningful
 * if a page ever reorders its `WINDOW_OPTIONS`.
 */
export function useWindowUrlState<T extends WindowOption>(
  options: readonly T[],
  defaultIndex: number,
): [number, (index: number) => void] {
  const defaultLabel = options[defaultIndex]?.label ?? options[0]?.label ?? '';
  const [label, setLabel] = useUrlState<string>(
    'window',
    (raw) => (raw != null && options.some((o) => o.label === raw) ? raw : defaultLabel),
    (v) => v,
  );
  const index = Math.max(0, options.findIndex((o) => o.label === label));
  const setIndex = (i: number) => setLabel(options[i]?.label ?? defaultLabel);
  return [index, setIndex];
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
      aria-label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={options.map((o, i) => ({ label: o.label, value: String(i) }))}
    />
  );
}
