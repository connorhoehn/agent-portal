// Where an initiative's discussion lives (leftovers 2, 10 November): one
// conversation per initiative. An initiative bound to a Social channel
// (providers/social-bindings.ts) discusses IN that channel; the old
// `orgiq:initiative:<id>` thread is no longer anyone's conversation.
//
//   * boundChannel: the binding as stored, whatever the channel's privacy:
//     the server's own question (where a /comment's reference goes, whether
//     a note belongs on the old thread at all).
//   * discussionHome: what a Work viewer WITHOUT Social access may learn, so
//     the page can say "This initiative's discussion is in #<channel> in
//     Social" instead of showing them the old thread: the slug of a PUBLIC
//     channel only (the Social directory lists public channels to everyone it
//     admits; a private one reads as "bound, but not to you", as the binding
//     read answers a non-member, routes/social.ts bindingView). Never a
//     message, a member or a count.
//   * visibleBoundChannel: the binding as ONE caller may know it (sweep 12,
//     L2): a public channel, or a private one they are an active member of
//     AND whose binding read admits them (readsSocialBindings: a current
//     Social grant that allows ViewSocial, and one in orgiq). Anything else
//     reads as unbound, as both reads above answer that caller, so a write
//     route never tells them more than a read would, and never points them
//     somewhere other than what their pane shows: a member whose Social grant
//     was removed (membership outlives the grant) gets the discussion-home
//     read, which hides a private channel, so their pane shows the old thread.

import { getBinding } from '../providers/social-bindings.js';
import { getChannel } from '../providers/social-channels.js';
import { slugForChannel, socialChat } from './social-chat.js';
import { currentSocialAuthority } from './social-authority.js';
import type { Session } from './session.js';

export const initiativeBindingContext = (projectId: string) => ({ tenant: 'orgiq', kind: 'initiative', id: projectId });

/** The `social:` channel the initiative is bound to, or null. */
export async function boundChannel(projectId: string): Promise<string | null> {
  const row = await getBinding(initiativeBindingContext(projectId));
  return row?.channel ?? null;
}

/** The bound channel's slug when the channel is public, else null (unbound, or private). */
export async function discussionHome(projectId: string): Promise<{ channel: string; slug: string } | null> {
  const channel = await boundChannel(projectId);
  const slug = channel ? slugForChannel(channel) : null;
  if (!channel || !slug) return null;
  const dir = await getChannel(slug);
  return dir?.privacy === 'public' ? { channel, slug } : null;
}

/**
 * Whether the initiative page's binding read (GET /api/social/bindings,
 * socialGate('ViewSocial') with a grant in orgiq) answers this caller: the
 * page shows the bound channel only then, and asks the discussion-home read
 * otherwise. Any refusal or error is false: the strict reading.
 */
export async function readsSocialBindings(session: Session): Promise<boolean> {
  try {
    await currentSocialAuthority(session, 'ViewSocial', { grantIn: 'orgiq' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The bound channel when `sub` may know of it (public, or a private channel
 * they are an active member of and whose binding read admits them,
 * `readsSocial`), else null. A channel with no directory row counts as
 * private here: the strict reading, since it leaks nothing.
 */
export async function visibleBoundChannel(projectId: string, sub: string, readsSocial: boolean): Promise<string | null> {
  const channel = await boundChannel(projectId);
  const slug = channel ? slugForChannel(channel) : null;
  if (!channel || !slug) return null;
  if ((await getChannel(slug))?.privacy === 'public') return channel;
  if (!readsSocial) return null;
  const chat = socialChat(); await chat.ready;
  await chat.membershipStore.hydrate(channel);
  return chat.membershipStore.isActiveMember(channel, sub) ? channel : null;
}
