// The tenant rail's and palette's view of GET /api/discussions/unread: the
// signed-in user's page discussions (initiative/work threads, assessment team
// and document chats, pipelines run threads) with new messages. Every count is
// the server's — recomputed there from the stored read cursor on each call and
// re-gated against the page's current read authority. This module only reads
// the payload defensively and decides where each number is shown.

import { TENANTS_WITH_DISCUSSIONS } from '../../lib/tenants.generated.ts';

export interface UnreadDiscussion {
  channel: string;
  title: string;
  href: string;
  section: string;
  unreadCount: number;
  lastMessagePreview: string | null;
}

export interface DiscussionUnread {
  threads: UnreadDiscussion[];
  /** Rail door path → number of discussions with new messages behind it. */
  sections: Record<string, number>;
}

export const EMPTY_DISCUSSION_UNREAD: DiscussionUnread = { threads: [], sections: {} };

/** The tenants whose pages carry reader-cursor discussions. */
export const DISCUSSION_TENANTS: ReadonlySet<string> = new Set(TENANTS_WITH_DISCUSSIONS); // manifest `discussions`

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function readDiscussionUnread(raw: unknown, tenant: string | undefined): DiscussionUnread {
  if (!raw || typeof raw !== 'object') return EMPTY_DISCUSSION_UNREAD;
  const body = raw as { tenant?: unknown; threads?: unknown; sections?: unknown };
  // A reply for another tenant (the cookie moved in another tab) draws nothing here.
  if (tenant && body.tenant !== tenant) return EMPTY_DISCUSSION_UNREAD;
  const threads = (Array.isArray(body.threads) ? body.threads : []).flatMap((t): UnreadDiscussion[] => {
    if (!t || typeof t !== 'object') return [];
    const r = t as Record<string, unknown>;
    const channel = text(r.channel), href = text(r.href), section = text(r.section), unreadCount = count(r.unreadCount);
    // Only paths inside the portal: the server already keeps hrefs in-tenant.
    if (!channel || !href || !href.startsWith('/') || href.startsWith('//') || !section || !unreadCount) return [];
    return [{ channel, href, section, unreadCount, title: text(r.title) ?? channel, lastMessagePreview: text(r.lastMessagePreview) }];
  });
  const sections: Record<string, number> = {};
  for (const t of threads) sections[t.section] = (sections[t.section] ?? 0) + 1;
  return { threads, sections };
}

/** A rail door's badge: what it already counts, plus its discussions with new messages. */
export function railCount(path: string, base: number, unread: DiscussionUnread): number | undefined {
  const total = base + (unread.sections[path] ?? 0);
  return total > 0 ? total : undefined;
}

/** Palette label for one discussion with new messages. */
export function discussionCommandLabel(t: UnreadDiscussion): string {
  return `${t.title} — ${t.unreadCount} new ${t.unreadCount === 1 ? 'message' : 'messages'}`;
}
