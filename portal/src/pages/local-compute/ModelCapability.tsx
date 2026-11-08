// What a machine's announced models mean, on screen.
//
// The fleet table printed the raw ids as neutral chips — `claude-sonnet-5`,
// `llama3.1:8b` — which names a model without saying what it is for. The
// decision in front of this table is where to send a job, so a model has to
// carry the size of task it takes.
//
// Two pieces: the chips for the table cell, and the fuller "what this machine
// can take on" block for the Details tab, where there is room to say it
// properly.

import { Chip, Inline, MetaLine, Stack, T } from '@connorhoehn/ui-components/shared';
import {
  TIERS,
  capabilitiesFor,
  type ModelTier,
} from '../../lib/modelCapability';

/**
 * Tone per tier. The ladder reads warm-to-cool deliberately: `deep` is the one
 * you spend on, so it is the one that stands out.
 */
const TIER_TONE: Record<ModelTier, 'accent' | 'info' | 'neutral' | 'caution'> = {
  deep: 'accent',
  balanced: 'info',
  quick: 'neutral',
  local: 'info',
  unknown: 'caution',
};

export interface ModelChipsProps {
  models: readonly string[];
}

/**
 * The Models cell: one chip per announced model, strongest first, each labelled
 * with its tier so the column answers "what can this machine take" at a glance.
 */
export function ModelChips({ models }: ModelChipsProps) {
  const caps = capabilitiesFor(models);
  if (caps.length === 0) {
    return <MetaLine size="xs" tone="tertiary" items={['none announced']} />;
  }
  return (
    <Inline gap="xs" wrap={false}>
      {caps.map((c) => (
        <Chip
          key={c.id}
          tone={TIER_TONE[c.tier]}
          size="xs"
          title={`${TIERS[c.tier].name} — ${TIERS[c.tier].takesOn}`}
        >
          {`${c.label} · ${TIERS[c.tier].name}`}
        </Chip>
      ))}
    </Inline>
  );
}

export interface CapabilityBriefProps {
  models: readonly string[];
}

/**
 * "What this machine can take on" — every tier it announced, with the kind of
 * work that belongs there.
 *
 * Deliberately one row per TIER rather than per model: two Sonnets do not widen
 * what a machine can do, and the question is about the ceiling and the floor,
 * not the inventory.
 */
export function CapabilityBrief({ models }: CapabilityBriefProps) {
  const caps = capabilitiesFor(models);
  if (caps.length === 0) {
    return (
      <T size="sm" className="text-text-secondary">
        This machine has not announced any models yet, so there is nothing to
        say about what it can take on. It announces them when its worker starts.
      </T>
    );
  }

  // One entry per tier, keeping the strongest-first order capabilitiesFor gave.
  const seen = new Set<ModelTier>();
  const tiers = caps.filter((c) => !seen.has(c.tier) && seen.add(c.tier) !== undefined);

  return (
    <Stack gap="sm">
      {tiers.map((c) => {
        const info = TIERS[c.tier];
        const models = caps.filter((x) => x.tier === c.tier).map((x) => x.label);
        return (
          <Inline key={c.tier} gap="md" align="start" wrap={false}>
            {/* Fixed-width so the tier chips line up into a column; Inline
                takes the className, so no raw wrapper is needed for it. */}
            <Stack gap="none" className="w-[104px] shrink-0">
              <Chip tone={TIER_TONE[c.tier]} size="xs">{info.name}</Chip>
            </Stack>
            <Stack gap="none" className="min-w-0">
              <T size="sm" className="text-text-primary">{info.takesOn}</T>
              <T size="xs" className="font-mono text-text-tertiary">{models.join(', ')}</T>
            </Stack>
          </Inline>
        );
      })}
    </Stack>
  );
}
