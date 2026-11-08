// A dimension's maturity level, as a Chip. The source rendered a rose→emerald
// CSS gradient per level; ui-components' Chip has no gradient fill, so the
// scale is expressed through Chip's tone vocabulary instead (see
// `levelTone` in ../types.ts) — L0 danger .. L5 success, N/A / unassessed
// neutral.

import { Chip, type ChipTone } from '@connorhoehn/ui-components/shared';
import { levelBadgeLabel, levelTone } from '../types';

export function LevelBadge({
  level,
  isNa,
  size = 'sm',
}: {
  level: number | null | undefined;
  isNa?: boolean;
  /** Chip only ships 'xs' | 'sm' — there is no larger size to ask for. */
  size?: 'xs' | 'sm';
}) {
  const tone: ChipTone = levelTone(level, isNa);
  return (
    <Chip tone={tone} size={size} mono>
      {levelBadgeLabel(level, isNa)}
    </Chip>
  );
}
