// What to do with a machine that has nothing queued.
//
// "Assign work" used to answer an empty suggestion list with one grey line:
// "Nothing suggested right now — open work on your initiatives shows up here."
// True, and useless. It names the pipe the suggestions come down without
// saying what this machine is for, what it could take right now, or what you
// could do next. On the page whose whole purpose is routing work to a machine,
// the empty state is the state you are in most often.
//
// So it says three things instead: why the list is empty, what size of job this
// particular machine is suited to (from the models it announced), and the
// routes that actually exist from here.
//
// Deliberately NOT fabricated work items with Send buttons. Dispatch takes a
// real `workItemId` or `botId` — there is no free-form prompt route — so a
// clickable "suggestion" would be a button that cannot work. These are things
// to go and do, phrased as such.

import { Button, Chip, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { Link as RouterLink } from 'react-router';
import { TIERS, TIER_IDEAS, bestTier } from '../../lib/modelCapability';


export interface NoSuggestionsProps {
  machineLabel: string;
  models: readonly string[];
  /** True when the machine is accepting work; false makes the reason different. */
  accepting: boolean;
  /** Switches the Source control over to bots. */
  onTryBots?: () => void;
}

export function NoSuggestions({
  machineLabel,
  models,
  accepting,
  onTryBots,
}: NoSuggestionsProps) {
  const tier = bestTier(models);
  const info = tier ? TIERS[tier] : null;
  const ideas = tier ? TIER_IDEAS[tier] : [];

  return (
    <Stack gap="md" className="py-6">
      <Stack gap="xs">
        <T size="sm" className="font-semibold text-text-primary">
          Nothing open on your initiatives right now
        </T>
        <T size="sm" className="text-text-secondary">
          Suggestions here come from work items on initiatives you own. When one
          is open and unassigned, it appears in this list ready to send to{' '}
          {machineLabel}.
        </T>
      </Stack>

      {info && (
        <Stack gap="sm">
          <Inline gap="sm" align="center">
            <T size="xs" className="font-semibold uppercase tracking-wide text-text-tertiary">
              What {machineLabel} is suited to
            </T>
            <Chip tone="info" size="xs">{info.name}</Chip>
          </Inline>
          <T size="sm" className="text-text-secondary">{info.takesOn}</T>
          {/* A Stack of Inlines rather than a raw <ul>. The library has no list
              primitive (queued), and these are short phrases rather than prose,
              so the bullet is a leading dot per row. */}
          <Stack gap="xs">
            {ideas.map((idea) => (
              <Inline key={idea} gap="sm" align="start">
                <T aria-hidden className="text-text-tertiary">·</T>
                <T size="sm" className="text-text-primary">{idea}</T>
              </Inline>
            ))}
          </Stack>
        </Stack>
      )}

      {!accepting && (
        <T size="sm" className="text-text-secondary">
          {machineLabel} is not accepting work at the moment, so nothing would
          start even if you sent it. The Accepting switch on its row turns that
          back on.
        </T>
      )}

      <Inline gap="sm" align="center" wrap>
        <RouterLink
          to="/iq/initiatives"
          className="inline-flex items-center rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-primary no-underline hover:bg-surface-panel"
        >
          Open initiatives
        </RouterLink>
        {onTryBots && (
          <Button size="sm" variant="ghost" onClick={onTryBots}>
            Send a bot instead
          </Button>
        )}
      </Inline>
    </Stack>
  );
}
