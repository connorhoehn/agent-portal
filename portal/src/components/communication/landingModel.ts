// What the Communication plane opens when no conversation is named
// (`/iq/communication`, `/assessment/communication`, `/pipelines/communication`):
// docs/layout-cascade.md rule 6 — a landing shows real content, never a
// "Pick a channel" placeholder. The user's own default conversation opens
// directly: the first of their groups whose bound Social channel they are in,
// else their most recent conversation (a joined channel or a DM). With none,
// the plane shows its overview (CommunicationLanding). No React, so
// `__tests__/landingModel.test.ts` runs under plain `node --test`.

import { groupBindingContext, type PlaneGroup } from './planeRailModel.ts';

export interface LandingInput {
  /** The workspace's channel and DM lists have answered. */
  ready: boolean;
  groups: readonly PlaneGroup[];
  groupsLoading: boolean;
  /** Binding facts by context; absent = not answered yet. */
  bindings: ReadonlyMap<string, { binding: { slug: string | null } | null; joined: boolean }>;
  channels: ReadonlyArray<{ slug: string; joined: boolean; lastMessageAt: string | null }>;
  conversations: ReadonlyArray<{ channel: string; lastMessageAt: string | null }>;
  /**
   * Phone width: the workspace shows the list or the pane, one at a time. Nothing opens on its own there, or
   * "All conversations" would land back on the same conversation (second regression walk, 10 November).
   */
  narrow?: boolean;
}

export type LandingDecision =
  | { kind: 'wait' }
  | { kind: 'open'; href: string; reason: 'group' | 'recent' }
  | { kind: 'overview' };

const at = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * `waitedLong`: the group bindings have had their chance — a binding read that
 * failed never answers, so after a short wait the recent conversation decides.
 */
export function landingDecision(input: LandingInput, base: string, waitedLong = false): LandingDecision {
  if (input.narrow) return { kind: 'overview' };
  if (!input.ready) return { kind: 'wait' };
  const joined = new Set(input.channels.filter((c) => c.joined).map((c) => c.slug));
  const contexts = input.groups.map(groupBindingContext).filter((c): c is string => !!c);
  const unanswered = input.groupsLoading || contexts.some((c) => !input.bindings.has(c));
  for (const context of contexts) {
    const facts = input.bindings.get(context);
    if (!facts) { if (!waitedLong) return { kind: 'wait' }; continue; }
    const slug = facts.binding?.slug;
    if (slug && facts.joined && joined.has(slug)) return { kind: 'open', href: `${base}/channels/${encodeURIComponent(slug)}`, reason: 'group' };
  }
  if (unanswered && !waitedLong) return { kind: 'wait' };
  const recent = [
    ...input.channels.filter((c) => c.joined).map((c) => ({ href: `${base}/channels/${encodeURIComponent(c.slug)}`, t: at(c.lastMessageAt) })),
    ...input.conversations.map((d) => ({ href: `${base}/dms/${encodeURIComponent(d.channel)}`, t: at(d.lastMessageAt) })),
  ].sort((a, b) => b.t - a.t)[0];
  return recent ? { kind: 'open', href: recent.href, reason: 'recent' } : { kind: 'overview' };
}
