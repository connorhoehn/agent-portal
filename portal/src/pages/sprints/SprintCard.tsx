// One tile in the sprint picker grid.

import { Chip, Inline, MetaLine, ProgressBar, SelectableCard, Stack } from '@connorhoehnslalom/ui-components/shared';
import { dateRange, mineReasons, STATUS_TONE, timeLeftLabel } from './sprintFormat';
import type { Sprint } from './types';

/** The chips that say WHY this sprint is yours — stewardship, envelope, or
 *  work assigned to you. Without them "Mine" is three different relationships
 *  wearing the same face. */
export function MineChips({ s }: { s: Sprint }) {
  const reasons = mineReasons(s);
  if (reasons.length === 0) return null;
  return (
    <Inline gap="xs">
      {reasons.map((r) => <Chip key={r.key} tone={r.tone} size="sm">{r.label}</Chip>)}
    </Inline>
  );
}

export function SprintCard({ s, selected, onSelect }: {
  s: Sprint; selected: boolean; onSelect: () => void;
}) {
  return (
    <SelectableCard selected={selected} onSelect={onSelect} aria-label={s.name}>
      <Stack gap="sm">
        {/* The name wraps rather than truncating — a sprint's name is the one
            thing on the card that has to be readable, and "Sprint 98 — Span
            metrics + …" is not a name. The grid keeps rows equal height, so a
            two-line title does not make the tile ragged. */}
        <Inline justify="between" align="baseline" wrap={false} gap="sm">
          <strong className="text-[14px] min-w-0">{s.name}</strong>
          <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>
        </Inline>
        <MetaLine
          size="sm"
          items={[
            s.orgProjectName ?? s.orgProjectId,
            dateRange(s),
            // Days-left only earns a slot while the sprint is running; on a
            // done sprint it is noise, and MetaLine drops the separator with it.
            s.status === 'active' ? timeLeftLabel(s.endsOn, 'short') : null,
          ]}
        />
        <ProgressBar
          value={s.pointsDone}
          max={Math.max(s.pointsTotal, 1)}
          size="sm"
          showRatio={false}
          label={`${s.pointsDone}/${s.pointsTotal} pts`}
        />
        <MineChips s={s} />
      </Stack>
    </SelectableCard>
  );
}
