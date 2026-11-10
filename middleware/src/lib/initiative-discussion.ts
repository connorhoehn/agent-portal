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

import { getBinding } from '../providers/social-bindings.js';
import { getChannel } from '../providers/social-channels.js';
import { slugForChannel } from './social-chat.js';

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
