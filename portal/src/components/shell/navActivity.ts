import { parseDmLobby } from '@connorhoehn/realtime-modules/call';
import type { DiscussionUnread } from './discussionUnreadModel';

interface InboxNotice {
  id: string;
  read?: boolean;
  channel?: string;
  payload?: Record<string, unknown>;
  action?: { href?: string };
}
interface ActivityScope {
  tenant: string;
  actorId: string;
  hasSocialGrant: boolean;
  /** The shell has already filtered these doors for the current actor. */
  visiblePaths: readonly string[];
}
const tenantPrefix: Readonly<Record<string, string>> = { orgiq: '/iq/', assessment: '/assessment/', social: '/social/', pipelines: '/pipelines/', access: '/access/' };

function localPath(href: unknown): string | null {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(href)) return null;
  try { return new URL(href, 'http://portal.invalid').pathname; } catch { return null; }
}
function socialPath(channel: string | undefined, actorId: string): string | null {
  if (!channel) return null;
  const dm = parseDmLobby(channel, { prefix: 'social:' });
  if (dm) return dm.kind === 'dm' && dm.members.includes(actorId) ? '/social/dms' : null;
  if (/^social:ch:[^\s/?#]+$/.test(channel)) return '/social/channels';
  if (/^social:team:[^\s/?#]+:[^\s/?#]+$/.test(channel)) return '/social/teams';
  if (/^social:room:[^\s/?#]+$/.test(channel)) return '/social/rooms';
  return null;
}
function visibleDoor(path: string, paths: readonly string[]): string | null {
  return [...paths].sort((a, b) => b.length - a.length).find(door => path === door || path.startsWith(`${door}/`)) ?? null;
}
function noticeDoor(notice: InboxNotice, scope: ActivityScope): string | null {
  const tenant = notice.payload?.tenant;
  const channel = notice.channel ?? (typeof notice.payload?.channel === 'string' ? notice.payload.channel : undefined);
  const href = notice.action?.href;
  const path = href === undefined ? null : localPath(href);
  // A malformed or external explicit action is not replaced with an inferred destination.
  if (href !== undefined && !path) return null;
  const dmCandidates = [channel];
  if (path?.startsWith('/social/dms/')) {
    try { dmCandidates.push(decodeURIComponent(path.slice('/social/dms/'.length))); } catch { return null; }
  }
  for (const candidate of dmCandidates) {
    const dm = parseDmLobby(candidate);
    // A group hash carries no member proof. Do not infer it from the action URL.
    if (dm && (dm.kind !== 'dm' || !dm.members.includes(scope.actorId))) return null;
  }
  if (tenant === 'social' && scope.tenant !== 'social') {
    if (!scope.hasSocialGrant || !(path?.startsWith('/social/') || socialPath(channel, scope.actorId))) return null;
    const communication = `${tenantPrefix[scope.tenant]}communication`;
    return scope.visiblePaths.includes(communication) ? communication : null;
  }
  if (tenant !== scope.tenant) return null;
  const prefix = tenantPrefix[scope.tenant];
  if (!prefix) return null;
  const candidate = path ?? (tenant === 'social' ? socialPath(channel, scope.actorId) : null);
  if (!candidate?.startsWith(prefix)) return null;
  return visibleDoor(candidate, scope.visiblePaths);
}

/** Existing inbox items and server-authorized discussion counts, with no new reads.
 * No marker means unknown/empty; it does not assert that a workspace is inactive.
 * The categories stay separate because one message can also have an inbox notice.
 */
export function navigationActivity(scope: ActivityScope, notices: readonly InboxNotice[], discussions: DiscussionUnread): Record<string, { label: string }> {
  if (!scope.actorId) return {};
  const counts = new Map<string, number>(), seen = new Set<string>();
  for (const notice of notices) {
    if (!notice.id || notice.read === true || seen.has(notice.id)) continue;
    seen.add(notice.id);
    const door = noticeDoor(notice, scope);
    if (door) counts.set(door, (counts.get(door) ?? 0) + 1);
  }
  const result: Record<string, { label: string }> = {};
  for (const path of scope.visiblePaths) {
    const parts: string[] = [];
    const count = discussions.sections[path];
    if (Number.isFinite(count) && count > 0) parts.push(`${Math.floor(count)} ${count === 1 ? 'conversation' : 'conversations'} with unread messages`);
    const notices = counts.get(path);
    if (notices) parts.push(`${notices} unread ${notices === 1 ? 'notice' : 'notices'} in this inbox`);
    if (parts.length) result[path] = { label: parts.join(' · ') };
  }
  return result;
}
