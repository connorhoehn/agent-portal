// Two shapes the Explore overlays need that ui-components does not have yet.
// Both are token-only — no inline styles, no literal colours.
//
// Reported upstream as primitive gaps:
//   • ContextStrip  — a full-width tinted "here is what you are looking at"
//                     band pinned above a canvas. Banner is the closest thing
//                     but it is a page-level alert with an icon and a dismiss.
//   • SuggestionRow — a combobox option row. The library has CommandPalette
//                     (a modal) and SelectableCard (a tile), but nothing for an
//                     inline autocomplete list.
//
// BUG FIXED HERE: every one of these surfaces was painted
// `var(--color-primary-subtle, #eef2ff)`. `--color-primary-subtle` is defined
// nowhere in the portal, so the fallback always won and the strips stayed
// indigo under the newsroom tenant, whose accent is amber. The real token is
// `--color-primary-soft`, which `[data-tenant]` actually overrides.

import type { ReactNode } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

/** The tinted band above the graph canvas: a path, a department focus, etc. */
export function ContextStrip({
  children,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  'aria-label'?: string;
}) {
  return (
    <Inline
      gap="md"
      align="center"
      wrap
      aria-label={ariaLabel}
      className="border-b border-border bg-[var(--color-primary-soft)] px-3 py-1.5 text-[12px]"
    >
      {children}
    </Inline>
  );
}

/** The small uppercase caption that labels a group inside a strip or panel. */
export function OverlineLabel({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
      {children}
    </span>
  );
}

/** A clickable list row whose trailing slot is a meter — "this name, this
 *  strong". Third gap: the library has ScoreBarGauge but nothing that pairs it
 *  with a label in a dense, selectable row. */
export function MeterRow({
  onClick,
  title,
  label,
  note,
  meter,
}: {
  onClick: () => void;
  title?: string;
  label: ReactNode;
  note?: ReactNode;
  meter: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-1.5 py-1 text-left text-[12px] text-text-primary hover:bg-surface-hover"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{label}</span>
        {note && <span className="text-[11px] text-text-tertiary">{' · '}{note}</span>}
      </span>
      <span className="w-11 shrink-0">{meter}</span>
    </button>
  );
}

/** One option in the search dropdown: a primary line and a muted second line.
 *  Highlight follows the keyboard cursor, not hover state, so arrow keys and
 *  the mouse cannot disagree about which row Enter would pick. */
export function SuggestionRow({
  active,
  onHighlight,
  onPick,
  primary,
  secondary,
}: {
  active: boolean;
  onHighlight: () => void;
  onPick: () => void;
  primary: ReactNode;
  secondary: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHighlight}
      onClick={onPick}
      className={[
        'flex w-full flex-col items-start gap-px border-none px-3 py-1.5 text-left text-[12px] text-text-primary cursor-pointer',
        active ? 'bg-[var(--color-primary-soft)]' : 'bg-transparent',
      ].join(' ')}
    >
      <span className="w-full truncate font-semibold">{primary}</span>
      <span className="w-full truncate text-[11px] text-text-tertiary">{secondary}</span>
    </button>
  );
}
