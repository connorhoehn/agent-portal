// CostChip — renders an invocation/run cost as a coloured chip.
//
// Tone palette (per Sprint 1 spec):
//   < $0.001   → success  (cheap)
//   $0.001–$0.01 → neutral (typical)
//   $0.01–$0.10 → warning (notable)
//   > $0.10    → danger  (expensive)
//
// Formatting:
//   >= $0.01   → '$0.00'    (2 decimals)
//   < $0.01    → '$0.0034'  (4 decimals)
//   null/undef → '—'        (no tone)

import { Chip } from '@connorhoehnslalom/ui-components/shared';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

interface Props {
  cost: number | null | undefined;
  size?: 'xs' | 'sm';
}

function toneFor(cost: number): Tone {
  if (cost < 0.001) return 'success';
  if (cost < 0.01) return 'neutral';
  if (cost < 0.1) return 'warning';
  return 'danger';
}

function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

export function CostChip({ cost, size = 'xs' }: Props) {
  if (cost == null || !Number.isFinite(cost)) {
    return (
      <Chip tone="neutral" size={size}>
        —
      </Chip>
    );
  }
  return (
    <Chip tone={toneFor(cost)} size={size}>
      {formatCost(cost)}
    </Chip>
  );
}

export default CostChip;
