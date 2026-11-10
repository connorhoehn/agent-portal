// One conversation per initiative (the demo-moments journey, M4: the
// initiative's own thread and its bound channel were two near-identical
// conversations, and a message typed on the initiative never reached
// #auth-migration).
//
// An initiative bound to a Social channel (middleware social-bindings, read
// through the shell's `pageChannel`) discusses IN that channel: the page's
// Discussion pane shows it and the page's composer posts to it, with the
// channel's own messages, receipts and membership rule. The separate
// `orgiq:initiative:<id>` thread is not offered as a second destination. An
// initiative with no binding keeps that thread, as before.
//
// The gateway admits a `social:ch:*` subscription for members only, so a
// viewer who is not a member reads nothing there: the pane says so with the
// channel's own reason ("Join the channel in Social to read and post here.")
// and the composer cannot post.
//
// A viewer with no Social grant cannot read the binding at all, and used to
// fall back to the old thread, which nobody else reads any more (leftovers 2).
// The page asks where the discussion lives instead (GET
// /api/graph/projects/:id/discussion: a public bound channel's slug only), and
// a bound initiative is `elsewhere`: a read-only notice in the pane ("This
// initiative's discussion is in #<channel> in Social. You don't have Social
// access."), the Social access next step, and no thread anywhere.
//
// Pure: the page (ProjectDetailPage.tsx) feeds it the binding state.

import { scopeDiscussionChannel } from './scopeDiscussionModel.ts';

/** The part of the shell's binding state this reads (components/social/ChannelBindingStrip.tsx). */
export interface BindingRead {
  data: { binding: { channel: string; slug?: string | null; name: string } | null; joined: boolean } | null;
  error: string | null;
}

export type DiscussionTarget =
  /** The binding is still being read: mount nothing yet, so the page never joins one thread and then the other. */
  | { kind: 'loading' }
  /** No binding (or no Social grant to read one): the initiative's own thread. */
  | { kind: 'thread'; channel: string; label: string }
  /** Bound: the channel IS the discussion. `joined` false: the viewer is not a member and reads nothing. */
  | { kind: 'channel'; channel: string; slug: string; label: string; joined: boolean }
  /** Bound, and the viewer has no Social grant: nothing to read or post here, only the notice and the access step. */
  | { kind: 'elsewhere'; slug: string; label: string; reason: string };

/** What the discussion-home read answered (GET /api/graph/projects/:id/discussion), for a viewer with no Social grant. */
export interface HomeRead {
  data: { channel: { slug: string } | null } | null;
  error: string | null;
}

/** The notice a viewer with no Social access reads where the thread used to be (and the voice's refusal). */
export function noSocialAccessReason(label: string): string {
  return `This initiative's discussion is in ${label} in Social. You don't have Social access.`;
}

export const NOT_A_MEMBER_REASON = 'Join the channel in Social to read and post here.';

export function initiativeDiscussionTarget(o: {
  projectId: string;
  /** The viewer holds a Social grant, so the shell reads the binding. Without one there is none to read. */
  socialAvailable: boolean;
  binding: BindingRead | null;
  /** Without a Social grant: where the discussion lives (the page reads it only then). */
  home?: HomeRead | null;
}): DiscussionTarget {
  const thread: DiscussionTarget = { kind: 'thread', channel: scopeDiscussionChannel(o.projectId), label: 'Initiative discussion' };
  if (!o.socialAvailable) {
    // A failed read keeps today's thread rather than no discussion at all, as a failed binding read does.
    if (!o.home || o.home.error) return thread;
    if (!o.home.data) return { kind: 'loading' };
    const slug = o.home.data.channel?.slug;
    return slug ? { kind: 'elsewhere', slug, label: `#${slug}`, reason: noSocialAccessReason(`#${slug}`) } : thread;
  }
  if (!o.binding) return thread;
  // A failed binding read keeps today's thread rather than no discussion at all.
  if (o.binding.error) return thread;
  if (!o.binding.data) return { kind: 'loading' };
  const bound = o.binding.data.binding;
  if (!bound) return thread;
  const slug = bound.slug || bound.channel.replace(/^social:ch:/, '');
  return { kind: 'channel', channel: bound.channel, slug, label: `#${slug}`, joined: o.binding.data.joined };
}

/**
 * Who may post where the target points, and why not. A channel takes Social's
 * own rule (PostMessage and membership, the Communication page's); the
 * initiative thread its writers (DispatchAgentRun).
 */
export function discussionAccess(t: DiscussionTarget, can: { postMessage: boolean; dispatch: boolean }): { maySend: boolean; reason: string | null } {
  if (t.kind === 'loading') return { maySend: false, reason: 'The initiative discussion is still loading.' };
  if (t.kind === 'elsewhere') return { maySend: false, reason: t.reason };
  if (t.kind === 'thread') return { maySend: can.dispatch, reason: can.dispatch ? null : 'You can read messages. Your current role cannot post to this discussion.' };
  if (!t.joined) return { maySend: false, reason: `You are not a member of ${t.label}. ${NOT_A_MEMBER_REASON}` };
  return { maySend: can.postMessage, reason: can.postMessage ? null : `You can read ${t.label}. Your current role cannot post there.` };
}
