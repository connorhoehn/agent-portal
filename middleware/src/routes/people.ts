// GET /api/people/shared — the tenant-neutral people list behind the shell's
// presence and direct-message entry. Before 2026-10-05 that entry read the
// Social directory (`/api/social/embedded`) and joined `social:lobby`, so a
// user without a Social grant had no presence and no way to DM anyone.
//
// Who is listed: users holding a current grant in the caller's ACTIVE tenant
// (the signed source), read from the authoritative directory. The caller's own
// session is re-validated (epoch, source role, actor) before and after the
// read, so a revoked session never receives a roster. The response names the
// two realtime names the shell uses, both already guarded by the gateway:
//   - `<tenant>:lobby`  presence only, for that tenant's current grant holders
//     (lib/tenant-channels.ts);
//   - `<tenant>:dm:<sorted ids>` — the DM rule (caller must be one of the ids,
//     and hold a grant in the partition) in realtime-gateway.ts.
import { Router } from 'express';
import { AppError, asyncHandler } from '../lib/async-handler.js';
import { requireSession, resolveSession } from '../lib/authz.js';
import { currentLiveSession } from '../lib/live-principal.js';
import { tenantLobbyChannel } from '../lib/tenant-channels.js';
import { listUsers } from '../providers/identity.js';
import { userAvatars } from '../providers/user-avatars.js';
import { socialChat } from '../lib/social-chat.js';
import { unreadFor } from '../mock/social-channels.js';
import { mirrorCloneDms } from '../lib/clone-dms.js';

export const peopleRouter = Router();

/** The DM channel two or more people share in `tenant` (sorted, distinct ids). */
export function tenantDmChannel(tenant: string, ids: readonly string[]): string {
  return `${tenant}:dm:${[...new Set(ids)].sort().join(':')}`;
}

peopleRouter.get('/shared', requireSession('SharedPeople'), asyncHandler(async (req, res) => {
  const signed = resolveSession(req);
  if (!signed) throw new AppError(401, 'Sign in again.');
  const session = await currentLiveSession(signed);
  let directory;
  try { directory = await listUsers({ authoritative: true }); }
  catch { throw new AppError(503, 'The identity store is unavailable'); }
  // The directory read may outlive a revocation: recheck before answering.
  const current = await currentLiveSession(session);
  const tenant = current.tenant;
  const listed = directory
    .filter(user => user.id !== current.sub && (user.grants[tenant]?.length ?? 0) > 0)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .slice(0, 500);
  // Faces are best-effort (null → initials) and read only for who is answered.
  const avatars = await userAvatars([...listed, ...directory.filter(user => user.id === current.sub)]);
  const people = listed.map(user => ({ userId: user.id, displayName: user.displayName, avatarUrl: avatars.get(user.id) ?? null }));
  res.set('Cache-Control', 'no-store');
  res.json({
    tenant, me: { userId: current.sub, displayName: current.name ?? current.sub, avatarUrl: avatars.get(current.sub) ?? null },
    lobby: tenantLobbyChannel(tenant), dmPrefix: `${tenant}:dm:`, people,
  });
}));

const UNREAD_WINDOW = 50;

/**
 * GET /api/people/conversations — the caller's DM conversations in their ACTIVE
 * tenant (`<tenant>:dm:<sorted ids>`), newest first, with last-message preview
 * and unread count. Reads the chat backend's conversation index (the same one
 * behind /api/social/dms); never returns another tenant's channel, a channel
 * whose id list omits the caller, or one with a peer who lost the tenant grant.
 * The session is re-validated before and after the reads.
 */
peopleRouter.get('/conversations', requireSession('SharedPeopleConversations'), asyncHandler(async (req, res) => {
  const signed = resolveSession(req);
  if (!signed) throw new AppError(401, 'Sign in again.');
  const session = await currentLiveSession(signed);
  const tenant = session.tenant;
  const prefix = `${tenant}:dm:`;
  // A clone lists its own copies of its persona's conversations (lib/clone-dms.ts).
  const self = session.sub;
  await mirrorCloneDms(self);
  const chat = socialChat();
  let directory; let rows;
  try {
    directory = await listUsers({ authoritative: true });
    await chat.ready;
    rows = await chat.conversations.listForUser(self);
  } catch { throw new AppError(503, 'Conversations are unavailable'); }
  const tenantUsers = directory.filter(u => (u.grants[tenant]?.length ?? 0) > 0);
  const names = new Map(tenantUsers.map(u => [u.id, u.displayName]));
  const mine = rows.filter(r => r.channel.startsWith(prefix) && r.channel.length > prefix.length)
    .map(r => ({ r, ids: r.channel.slice(prefix.length).split(':') }))
    .filter(({ ids }) => ids.includes(self) && ids.length >= 2 && ids.every(id => id === self || names.has(id)))
    .sort((a, b) => (b.r.lastMessageAt ?? '').localeCompare(a.r.lastMessageAt ?? '') || a.r.channel.localeCompare(b.r.channel))
    .slice(0, 200);
  const peerIds = new Set(mine.flatMap(({ ids }) => ids));
  const avatars = await userAvatars(tenantUsers.filter(u => peerIds.has(u.id)));
  let conversations;
  try {
    conversations = await Promise.all(mine.map(async ({ r, ids }) => {
      const [recent, cursors] = await Promise.all([chat.recentMessages(r.channel, UNREAD_WINDOW), chat.readReceiptStore.listReceipts(r.channel)]);
      const readAt = cursors.find(c => c.userId === self)?.readAt ?? null;
      return {
        channel: r.channel,
        peers: ids.filter(id => id !== self).map(id => ({ userId: id, displayName: names.get(id) ?? id, avatarUrl: avatars.get(id) ?? null })),
        lastMessageAt: r.lastMessageAt, lastMessagePreview: r.lastMessagePreview,
        unreadCount: unreadFor(recent, r.channel, self, readAt),
      };
    }));
  } catch { throw new AppError(503, 'Conversations are unavailable'); }
  const current = await currentLiveSession(session);
  if (current.tenant !== tenant) throw new AppError(401, 'Sign in again.');
  res.set('Cache-Control', 'no-store');
  res.json({ tenant, conversations });
}));
