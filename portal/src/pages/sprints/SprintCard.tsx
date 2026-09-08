// One tile in the sprint picker grid.

import { Avatar, Chip, Inline, MetaLine, ProgressBar, SelectableCard, Stack } from '@connorhoehnslalom/ui-components/shared';
import { dateRange, mineReasons, sprintHealth, STATUS_TONE, timeLeftLabel, usd, windowProgress } from './sprintFormat';
import { T } from './Text';
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
  const health = sprintHealth(s);
  const elapsed = windowProgress(s);
  return (
    <SelectableCard selected={selected} onSelect={onSelect} aria-label={s.name}>
      <Stack gap="sm">
        {/* The name wraps rather than truncating — a sprint's name is the one
            thing on the card that has to be readable, and "Sprint 98 — Span
            metrics + …" is not a name. The grid keeps rows equal height, so a
            two-line title does not make the tile ragged. */}
        <Inline justify="between" align="baseline" wrap={false} gap="sm">
          <strong className="text-[14px] min-w-0">{s.name}</strong>
          {/* Health outranks status: "active" is table stakes, "off track" is
              the thing a steward opens the page to learn. */}
          {health
            ? <Chip tone={health.tone} size="sm" dot="static">{health.label}</Chip>
            : <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>}
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
        {/* Who answers for it. A sprint without a steward is itself a finding. */}
        {s.stewardName ? (
          <Inline gap="xs" wrap={false} className="min-w-0">
            <Avatar name={s.stewardName} size={18} />
            <T className="truncate text-[12px] text-text-secondary">{s.stewardName}</T>
          </Inline>
        ) : (
          <T className="text-[12px] text-text-tertiary">No steward</T>
        )}
        <ProgressBar
          value={s.pointsDone}
          max={Math.max(s.pointsTotal, 1)}
          size="sm"
          showRatio={false}
          label={
            <T className="text-[11px] text-text-tertiary">
              {s.pointsDone}/{s.pointsTotal} pts
              {s.status === 'active' && elapsed != null ? ` · ${Math.round(elapsed * 100)}% elapsed` : ''}
            </T>
          }
        />
        {/* The money, when there is any: initiative spend in the window
            against the envelope(s) granted to this sprint. */}
        {(s.grantCount > 0 || s.initiativeSpendInWindowUsd > 0) && (
          <T className="text-[11px] text-text-tertiary">
            {usd(s.initiativeSpendInWindowUsd)}
            {s.grantCount > 0 ? ` of ${usd(s.grantedUsd)} envelope` : ' spent · no envelope'}
          </T>
        )}
        <MineChips s={s} />
      </Stack>
    </SelectableCard>
  );
}
