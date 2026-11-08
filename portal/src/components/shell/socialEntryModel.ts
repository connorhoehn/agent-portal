// What the footer's "Social" button does (user, 2026-10-07: "when I click Social
// it should take me to that tenant or the Communication tab in that tenant if
// enabled"). Pure: tenant + Social grant + the page's bound channel + the
// current path in, one target out. No request — the grant and binding are what
// the shell already holds.
import { communicationPath } from '../../lib/communicationPlane.ts';

export type SocialEntryTarget =
  | { kind: 'navigate'; path: string }
  /** Already on that workspace: leave the page (and its open conversation) alone. */
  | { kind: 'here' }
  /** No Social grant: keep the footer panel and its empty state. */
  | { kind: 'panel' };

export interface SocialEntryInput {
  tenant: string | null | undefined;
  hasSocialGrant: boolean;
  /** Slug of the Social channel bound to the page on screen, if any. */
  pageChannelSlug?: string | null | undefined;
  pathname: string;
}

const channelPath = (base: string, slug: string | null | undefined) =>
  slug ? `${base}/channels/${encodeURIComponent(slug)}` : `${base}/channels`;

export function socialEntryTarget(input: SocialEntryInput): SocialEntryTarget {
  if (!input.hasSocialGrant) return { kind: 'panel' };
  const within = (base: string) => input.pathname === base || input.pathname.startsWith(`${base}/`);
  if (input.tenant === 'social') {
    return within('/social/channels') || within('/social/dms') ? { kind: 'here' } : { kind: 'navigate', path: channelPath('/social', input.pageChannelSlug) };
  }
  const base = communicationPath(input.tenant);
  if (!base) return { kind: 'panel' };
  return within(base) ? { kind: 'here' } : { kind: 'navigate', path: channelPath(base, input.pageChannelSlug) };
}

/** The "↗" door to the Social tenant itself: only with a grant, and never from inside Social. */
export const showSocialTenantDoor = (tenant: string | null | undefined, hasSocialGrant: boolean): boolean =>
  hasSocialGrant && tenant !== 'social';

/**
 * The footer bell's "See all activity": the Social workspace's own Activity
 * view (the same inbox, full height), opened by `?shelf=activity` — in the
 * Social tenant, or the Communication plane elsewhere. Null without a Social
 * grant or a plane in this tenant, where there is no such page to open.
 */
export function socialActivityPath(tenant: string | null | undefined, hasSocialGrant: boolean): string | null {
  if (!hasSocialGrant) return null;
  const base = tenant === 'social' ? '/social' : communicationPath(tenant);
  return base ? `${base}/channels?shelf=activity` : null;
}

/**
 * The footer presence tooltip's lines: everyone online with a status message,
 * "Ana (away): out today". PresenceAvatars' own native title carries only the
 * name and "Away", so the footer wraps the row in a Tooltip with these.
 */
export function presenceStatusLines(people: ReadonlyArray<{ name: string; idle?: boolean; detail?: string }>, max = 6): string[] {
  return people.filter((p) => p.detail).slice(0, max).map((p) => `${p.name}${p.idle ? ' (away)' : ''}: ${p.detail}`);
}
