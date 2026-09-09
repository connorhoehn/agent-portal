import { Button, Inline, MetaLine, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';

interface WeightSliderProps {
  value: number;
  onChange: (v: number) => void;
  label?: string;
}

// Lives inside a popover now (see FilterBar.tsx) rather than its own row on
// the page — DEFECTS.md #3 named the weighting row as one of the stacked
// blocks pushing the leaderboard below the fold.
export function WeightSlider({ value, onChange, label = 'Composite weighting: influence vs expertise' }: WeightSliderProps) {
  const infPct = Math.round(value * 100);
  const expPct = Math.round((1 - value) * 100);

  return (
    <Stack gap="xs">
      <Inline align="center" justify="between">
        <SectionLabel>Composite weighting</SectionLabel>
        <Button variant="ghost" size="sm" onClick={() => onChange(0.55)}>Reset</Button>
      </Inline>
      {/* A raw range input because `Slider` is exported only from the package
          root, and importing the root pulls @tiptap/react — a peer dep this
          portal never installed — into `vite build`. Queued; this file is on
          the ledger as a local composite for exactly that reason. */}
      <input
        type="range"
        aria-label={label}
        min={0}
        max={100}
        value={infPct}
        onChange={e => onChange(Number(e.target.value) / 100)}
        className="w-full cursor-pointer accent-primary"
      />
      <Inline justify="between">
        <MetaLine size="xs" className="text-primary" items={[`Influence ${infPct}%`]} />
        <MetaLine size="xs" className="text-success" items={[`Expertise ${expPct}%`]} />
      </Inline>
    </Stack>
  );
}
