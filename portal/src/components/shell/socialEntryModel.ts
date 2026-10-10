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
