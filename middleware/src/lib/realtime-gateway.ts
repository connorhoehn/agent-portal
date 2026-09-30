// The OrgIQ middleware as its own realtime gateway (docs/social-calls-plan.md
// step 7, deploy-plan risk #2 — the gateway half).
//
//   ws(s)://<middleware>/ws     Sec-WebSocket-Protocol: bearer-token-v1, <jwt>
//   features: chat, presence, calls, notifications (+ the library's built-in subscribe)
//
// Why here and not realtime-examples' gateway container: that server verifies
// Cognito id_tokens (or runs with SKIP_AUTH, which trusts any claims), and it
// cannot scope a lobby to a tenant. Serving the socket from the BFF makes the
// identity OUR token — the HS256 realtime token `GET /api/session/realtime-token`
// mints (lib/realtime-token.ts) — and lets `calls({ lobbyGuard })` refuse any
// lobby outside the caller's tenant.
//
// Auth runs once, at upgrade (the library answers 401 when it throws):
//   1. the browser Origin allowlist, as every other browser-facing path;
//   2. `Sec-WebSocket-Protocol` must be exactly `bearer-token-v1, <jwt>` —
//      no query-string or cookie fallback;
//   3. the JWT verifies against REALTIME_JWT_SECRET (HS256, iss/aud/exp,
//      tokenKind 'orgiq-hs256').
// The resulting context — `{ userId: sub, displayName, org, tenants, role }` —
// is what the router routes rings by (`getClientsByUserId`) and what
// `lobbyGuard` sees. Like lib/distillation-realtime.ts, an open socket is not
// re-checked: a token that expires mid-connection keeps its socket until it
// reconnects, and the portal re-fetches a token on every drop.
//
// Tenant scoping, and what it does NOT cover yet:
//   - call frames naming a lobby: refused unless the lobby's partition
//     (`<p>:…`) is the caller's tenant or one the token's `tenants` lists
//     (design E5), and a `<p>:dm:<ids>` lobby additionally only for one of
//     those ids;
//   - untargeted (broadcast) invites: refused — the library fans those out to
//     every connected client, which would ring across tenants;
//   - chat and presence CHANNELS follow the same partition rule
//     (channelGuard, below), plus membership for `social:ch:` and team
//     channels.
//
// Enabled by REALTIME_GATEWAY=on|off. Default: on outside production, off in
// production unless set, so the ECS task is unchanged until someone asks.
//
// Call state lives in Redis when REDIS_URL is set (realtime-modules'
// RedisCallStateStore over lib/redis-lite.ts), in memory otherwise. The
// ROUTER is always the library's single-process LocalRealtimeRouter: Redis
// makes call state survive a restart and be shared, but it does not fan
// frames out across replicas — run one task until a Redis-backed router
// exists (the library's recipe names realtime-examples' MessageRouter as the
// reference implementation).
//
// Notifications (docs/social-tenant-design.md §3.3–§3.4): the library's
// user-addressed inbox, persisted by lib/notification-store.ts (Redis when
// REDIS_URL, the library's store over an in-memory map otherwise, seeded from
// mock/notifications.ts under MOCK_AURORA). The library does not replay a
// user's unread set by itself — `onConnect` below does, once per socket. The
// producers are lib/social-notify.ts's `notify` (wired here as the sink) plus
// two that only this file can see:
//   - a DM message (chat publish on `<tenant>:dm:<a>:<b>…`) → the other
//     members who have no live subscription to that channel;
//   - a missed call (`calls({ onCallMissed })`) → the invite's targets.
//   - a channel message (chat publish on `social:ch:<slug>`) → the channel's
//     active members who have no live subscription to it; `@<name>` in the
//     text → the mentioned members, as a `mention` (design §3.4 row 5).
//
// Chat state (docs/social-tenant-design.md §4.4, lane S1): `chat({ chatStore })`
// takes the social backend from lib/social-chat.ts — the library's
// DynamoChatStore when SOCIAL_CHAT_STORE=dynamo or a SOCIAL_CHAT_* DynamoDB
// setting is present (DynamoDB Local under the `social` compose profile), the
// library's in-memory stores (fixture-backed under MOCK_AURORA) otherwise. A
// `social:ch:<slug>` channel is admitted to its active MEMBERS only, on top of
// the tenant rule; `social:dm:<ids>` to the ids, as every `<org>:dm:` name.

import type { IncomingMessage, Server } from 'node:http';
import { attachRealtime, chat, presence, calls, notifications, type RealtimeHandle } from '@connorhoehnslalom/realtime-modules/server';
import { RedisCallStateStore, InMemoryCallStateStore, type CallStateRedis } from '@connorhoehnslalom/realtime-modules/call';
import { DynamoChatStore, type DynamoCommandClient } from '@connorhoehnslalom/realtime-modules/server/stores/dynamo';
import type { ChatMember, ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { isAllowedBrowserOrigin } from './browser-origin.js';
import { realtimeSigningSecret, tokenFromSubprotocol, verifyRealtimeToken } from './realtime-token.js';
import { RedisLite } from './redis-lite.js';
import { createGatewayNotificationStore, releaseGatewayNotificationStore, seedMockNotifications } from './notification-store.js';
import { conversationHref, notify, parseDmLobby, resolveMentions, setNotificationSink, type NotificationSink } from './social-notify.js';
import {
  createMemorySocialChatBackend,
  dmMembers,
  MirroredMembershipStore,
  setSocialChatBackend,
  slugForChannel,
  socialChat,
  socialChatConfig,
  SOCIAL_CHANNEL_PREFIX,
  type SocialChatBackend,
  type SocialChatConfig,
  type SocialConversations,
} from './social-chat.js';
import { config } from '../config.js';
import { listChannels } from '../providers/social-channels.js';
import { isSocialTeamMember } from '../providers/social-platform.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../mock/social-channels.js';

export const REALTIME_GATEWAY_PATH = '/ws';

export type RealtimeGatewayStore = 'redis' | 'memory';

export interface RealtimeGatewayAuth {
  userId: string;
  displayName: string;
  org: string;
  tenants: string[];
  role: string;
  [key: string]: unknown;
}

/** REALTIME_GATEWAY=on|off; unset → on unless NODE_ENV=production. */
export function realtimeGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['REALTIME_GATEWAY'] ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return env['NODE_ENV'] !== 'production';
}

/**
 * The upgrade's auth callback. Throws to refuse (the library answers 401).
 */
export async function authenticateGatewayUpgrade(req: IncomingMessage): Promise<RealtimeGatewayAuth> {
  const origin = req.headers.origin;
  if (origin) {
    const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
    if (!isAllowedBrowserOrigin(origin, `${proto}://${req.headers.host ?? ''}`)) {
      throw new Error('browser origin is not allowed');
    }
  }
  const token = tokenFromSubprotocol(req.headers['sec-websocket-protocol']);
  if (!token) throw new Error('missing bearer-token-v1 subprotocol');
  const secret = realtimeSigningSecret();
  if (!secret) throw new Error('realtime token verification unavailable');
  const claims = await verifyRealtimeToken(token, secret);
  return {
    userId: claims.sub,
    displayName: typeof claims.displayName === 'string' && claims.displayName ? claims.displayName : claims.sub,
    org: claims.org,
    tenants: Array.isArray(claims.tenants) ? claims.tenants.filter((t): t is string => typeof t === 'string') : [],
    role: typeof claims.role === 'string' ? claims.role : '',
  };
}

/** `social:team:<team slug>:<channel>` — a team's chat channel (design §4.3). */
const TEAM_CHANNEL = /^social:team:([^:]+):[^:]+$/;

type GuardAuth = { userId?: unknown; org?: unknown; tenants?: unknown };

/**
 * May this connection use `lobbyName`? The partition is the name's first
 * segment (`<p>:…`), admitted when it is the caller's own tenant (`org`) or
 * any tenant the token's `tenants` claim lists — the grant list
 * (docs/social-tenant-design.md E5, §4.2: "slowly contextually embed" needs an
 * orgiq page to open a `social:` channel for a user who holds a social grant).
 * Then, whatever the partition:
 *   - `<p>:dm:<a>:<b>…` (the shape `dmLobbyName(ids, { prefix: '<p>:' })`
 *     builds) only when the caller is one of the ids;
 *   - `social:team:<team>:<channel>` only for the team's members (the BFF's
 *     in-process copy of platform-api's roster, providers/social-platform.ts).
 * Anything else under an admitted partition (a room, an initiative) is open
 * to the partition's grant holders.
 */
export function lobbyGuard(auth: GuardAuth, lobbyName: string): boolean {
  const org = typeof auth.org === 'string' ? auth.org : '';
  const userId = typeof auth.userId === 'string' ? auth.userId : '';
  if (!userId) return false;
  const tenants = Array.isArray(auth.tenants) ? auth.tenants.filter((t): t is string => typeof t === 'string' && !!t) : [];
  const cut = lobbyName.indexOf(':');
  if (cut <= 0) return false;
  const partition = lobbyName.slice(0, cut);
  if (partition !== org && !tenants.includes(partition)) return false;
  const rest = lobbyName.slice(cut + 1);
  if (!rest) return false;
  if (rest === 'dm' || rest.startsWith('dm:')) {
    const ids = rest.slice(3).split(':').filter(Boolean);
    return ids.includes(userId);
  }
  const team = TEAM_CHANNEL.exec(lobbyName);
  if (team) return isSocialTeamMember(team[1]!, userId);
  if (partition === 'social' && rest.startsWith('team:')) return false; // a malformed team name
  return true;
}

/**
 * May this connection subscribe to / publish on `channel` (chat, presence)?
 * The same rule as lobbies (2026-09-29; widened to the token's `tenants` by
 * E5): only channels whose partition the caller holds a grant in, a
 * `<p>:dm:<a>:<b>…` channel only when the caller is one of the ids, a team
 * channel only for the team's members. Before this, `lobbyGuard` scoped calls
 * only, and every orgiq persona could join `assessment:doc:<id>` — read its
 * history and post into it (assessment isolation walk, 2026-09-29).
 */
export function channelGuard(auth: GuardAuth | null, channel: string): boolean {
  if (auth == null) return false;
  const bare = stripServicePrefix(channel);
  if (!lobbyGuard(auth, bare)) return false;
  // A social channel additionally needs membership (design §4.2): the store's
  // `chat-members` rows, read through the synchronous mirror. The tenant rule
  // above already refused every caller with no `social` grant.
  if (bare.startsWith(SOCIAL_CHANNEL_PREFIX)) {
    const userId = typeof auth.userId === 'string' ? auth.userId : '';
    return !!slugForChannel(bare) && socialChat().membershipStore.isActiveMember(bare, userId);
  }
  return true;
}

/**
 * The library's services subscribe under their own prefix — `presence:<channel>`,
 * `reactions:<channel>`, `cursor:<channel>`, `chat:<channel>` — and the hook
 * sees that full name. The tenant rule applies to the channel the app named,
 * so the service prefix is stripped first; without this the tenant's own
 * presence was refused (assessment re-audit, 2026-09-29, defect #9).
 */
const SERVICE_PREFIX = /^(presence|reactions|cursor|chat|typing|activity|pins):/;
export function stripServicePrefix(channel: string): string {
  return channel.replace(SERVICE_PREFIX, '');
}

// Typed inline: the library's `ChannelAuthorize` type reaches ts-jest as `any`.
const authorizeChannel = ({ kind, channel, ctx }: { kind: 'subscribe' | 'publish'; clientId: string; channel: string; ctx: GuardAuth | null }): boolean => {
  const ok = channelGuard(ctx, channel);
  if (!ok) {
    const who = ctx as Record<string, unknown> | null;
    console.warn(`[realtime-gateway] refused ${kind} on channel '${channel}' for user '${String(who?.['userId'] ?? '?')}' (org '${String(who?.['org'] ?? '?')}')`);
  }
  return ok;
};

function guardWithLog(auth: Record<string, unknown>, lobbyName: string): boolean {
  const ok = lobbyGuard(auth, lobbyName);
  if (!ok) {
    console.warn(`[realtime-gateway] refused lobby '${lobbyName}' for user '${String(auth['userId'] ?? '?')}' (org '${String(auth['org'] ?? '?')}')`);
  }
  return ok;
}

// ── Socket producers (design §3.4 rows 4 and 6) ────────────────────────────

/** The router surface the DM producer reads. `channelMembers` is LocalRealtimeRouter's
 * private channel → clientIds map: realtime-modules 0.98.7 exposes no public "who is
 * subscribed to this channel" accessor, so it is read duck-typed, and when it is
 * absent (a different router) every member but the sender is notified. */
interface DmRouter {
  getUserIdForClient?(clientId: string): string | undefined;
  channelMembers?: Map<string, Set<string>>;
}

function snippet(text: unknown, max = 140): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Users with a live subscription to `channel` (chat subscribes it bare; `chat:`-prefixed covered too). */
export function liveSubscribers(router: DmRouter, channel: string): Set<string> | null {
  const members = router.channelMembers;
  if (!(members instanceof Map)) return null;
  const out = new Set<string>();
  for (const name of [channel, `chat:${channel}`]) {
    for (const clientId of members.get(name) ?? []) {
      const userId = router.getUserIdForClient?.(clientId);
      if (userId) out.add(userId);
    }
  }
  return out;
}

/**
 * Row 4: a chat message on a `<tenant>:dm:<a>:<b>…` channel notifies the other
 * members who are not looking at it. The sender is the PUBLISHING CONNECTION's
 * authenticated user (the plugin's `clientId` is the publisher); the message's
 * server-stamped sender (`message.userId`, and `metadata.userId` where a
 * library version stamps it there) must agree or the frame is ignored. The
 * gateway's `authorize` already refused a publish by a non-member.
 */
export function dmNotifyPlugin(getRouter: () => DmRouter | null) {
  return {
    name: 'social-dm-notify',
    onMessage: ({ clientId, channelId, message }: { clientId: string; channelId: string; message: unknown }) => {
      const frame = message as { type?: unknown; action?: unknown; message?: { userId?: unknown; message?: unknown; metadata?: { userId?: unknown; displayName?: unknown } } } | null;
      if (!frame || frame.type !== 'chat' || frame.action !== 'message' || !frame.message) return;
      const channel = stripServicePrefix(channelId);
      const dm = parseDmLobby(channel);
      if (!dm) return;
      const router = getRouter();
      const sender = router?.getUserIdForClient?.(clientId);
      const stamped = frame.message.userId ?? frame.message.metadata?.userId;
      if (!router || !sender || (typeof stamped === 'string' && stamped !== sender) || !dm.members.includes(sender)) return;
      const live = liveSubscribers(router, channel);
      const recipients = dm.members.filter((u) => u !== sender && !(live?.has(u) ?? false));
      if (!recipients.length) return;
      const name = typeof frame.message.metadata?.displayName === 'string' && frame.message.metadata.displayName ? frame.message.metadata.displayName : sender;
      void notify(recipients, {
        type: 'message',
        title: `${name} sent you a message`,
        body: snippet(frame.message.message) || 'New message',
        channel,
        payload: { tenant: dm.tenant, kind: 'message', channel, actorId: sender, actorName: name },
        action: { label: 'Open the conversation', href: conversationHref(dm.tenant, channel) },
      });
    },
  };
}

/**
 * Row 5: a chat message on a `social:ch:<slug>` channel notifies the channel's
 * active members who are not looking at it (no live subscription), and
 * `@<display name>` in the text — resolved against the social roster — sends
 * the mentioned MEMBERS a `mention` instead (live or not: a mention asks for
 * attention). A mention of someone outside the channel notifies nobody: the
 * link would open a channel they cannot read. The sender is the plugin's
 * authenticated `userId` (0.99.0), falling back to the publishing connection's.
 */
export function channelNotifyPlugin(getRouter: () => DmRouter | null, members: () => MirroredMembershipStore = () => socialChat().membershipStore) {
  return {
    name: 'social-channel-notify',
    onMessage: ({ clientId, channelId, message, userId }: { clientId: string; channelId: string; message: unknown; userId?: string }) => {
      const frame = message as { type?: unknown; action?: unknown; message?: { userId?: unknown; message?: unknown; metadata?: { displayName?: unknown } } } | null;
      if (!frame || frame.type !== 'chat' || frame.action !== 'message' || !frame.message) return;
      const channel = stripServicePrefix(channelId);
      const slug = slugForChannel(channel);
      if (!slug) return;
      const router = getRouter();
      const sender = userId ?? router?.getUserIdForClient?.(clientId);
      const stamped = frame.message.userId;
      if (!sender || (typeof stamped === 'string' && stamped !== sender)) return;
      const store = members();
      if (!store.isActiveMember(channel, sender)) return;
      const audience = store.activeMembers(channel).map((m) => m.userId).filter((u) => u !== sender);
      if (!audience.length) return;
      const live = router ? liveSubscribers(router, channel) : null;
      const name = typeof frame.message.metadata?.displayName === 'string' && frame.message.metadata.displayName ? frame.message.metadata.displayName : sender;
      const text = typeof frame.message.message === 'string' ? frame.message.message : '';
      void notifyChannelMessage({ channel, slug, sender, name, text, audience, live });
    },
  };
}

export async function notifyChannelMessage(ev: { channel: string; slug: string; sender: string; name: string; text: string; audience: string[]; live: Set<string> | null }): Promise<void> {
  try {
    const href = `/social/channels/${encodeURIComponent(ev.slug)}`;
    const payload = { tenant: 'social', kind: 'message', channel: ev.channel, actorId: ev.sender, actorName: ev.name };
    const action = { label: 'Open the channel', href };
    const body = snippet(ev.text) || 'New message';
    const mentioned = (await resolveMentions(ev.text, 'social')).filter((u) => ev.audience.includes(u));
    if (mentioned.length) {
      await notify(mentioned, { type: 'mention', title: `${ev.name} mentioned you in #${ev.slug}`, body, channel: ev.channel, payload: { ...payload, kind: 'mention' }, action });
    }
    const rest = ev.audience.filter((u) => !mentioned.includes(u) && !(ev.live?.has(u) ?? false));
    if (rest.length) {
      await notify(rest, { type: 'message', title: `${ev.name} in #${ev.slug}`, body, channel: ev.channel, payload, action });
    }
  } catch (err) {
    console.warn(`[realtime-gateway] channel notify failed: ${(err as Error).message}`);
  }
}

// ── Chat state (design §4.4) ────────────────────────────────────────────────

function socialChatClient(cfg: SocialChatConfig): DynamoCommandClient {
  // DynamoDB Local accepts any key; never send the operator's real
  // credentials to a loopback emulator (the comment importer's rule).
  const local = !!cfg.endpoint && process.env['NODE_ENV'] !== 'production';
  return new DynamoDBClient({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
}

/**
 * The chat backend for `cfg`: the library's DynamoChatStore, or the memory one.
 * Dynamo's membership is mirrored in process for the synchronous guard and
 * hydrated from `chat-members` for every directory channel; under MOCK_AURORA a
 * directory channel with no rows in DynamoDB yet is seeded once from the
 * fixtures, so DynamoDB Local (in-memory, emptied on every restart) opens on
 * the same world as the memory store.
 */
export function createSocialChatBackend(cfg: SocialChatConfig = socialChatConfig(), opts: { client?: DynamoCommandClient } = {}): SocialChatBackend {
  if (cfg.store !== 'dynamo') return createMemorySocialChatBackend();
  const store = new DynamoChatStore({ client: opts.client ?? socialChatClient(cfg), tablePrefix: cfg.tablePrefix, logger });
  const mirror: ChatMember[] = [];
  const membershipStore = new MirroredMembershipStore(() => mirror, store.members);
  const conversations: SocialConversations = {
    listForUser: async (userId) => (await store.conversations.listForUser(userId)).map((r) => ({
      channel: r.channel, peers: r.peers, lastMessageAt: r.lastMessageAt || null,
      lastMessagePreview: r.lastMessagePreview || null, lastMessageUserId: r.lastMessageUserId,
    })),
    recordJoin: (channel, userId) => store.conversations.recordJoin(channel, userId),
    recordDmMessage: (channel, members, message) => store.conversations.recordMessage({ channel, members, message }),
  };
  const seedIfEmpty = async (channel: string): Promise<void> => {
    if (!config.mock.aurora || (await store.members.listMembers(channel)).length) return;
    for (const m of socialChannelMembersFixture.rows().filter((r) => r.channel === channel)) await store.members.putMember(m);
    for (const m of socialChannelMessagesFixture.rows().filter((r) => r.channel === channel)) await store.putMessage(m);
  };
  const seedDms = async (): Promise<void> => {
    if (!config.mock.aurora) return;
    const byChannel = new Map<string, ChatMessage[]>();
    for (const m of socialChannelMessagesFixture.rows()) {
      if (dmMembers(m.channel)) byChannel.set(m.channel, [...(byChannel.get(m.channel) ?? []), m]);
    }
    for (const [channel, msgs] of byChannel) {
      if ((await store.listMessages(channel, 1)).length) continue;
      for (const m of msgs) {
        await store.putMessage(m);
        await conversations.recordDmMessage(channel, dmMembers(channel)!, m);
      }
    }
  };
  const ready = (async () => {
    for (const row of await listChannels()) {
      const channel = `${SOCIAL_CHANNEL_PREFIX}${row.slug}`;
      await seedIfEmpty(channel);
      await membershipStore.hydrate(channel);
    }
    await seedDms();
  })().catch((err: unknown) => {
    console.warn(`[realtime-gateway] social chat store did not hydrate (${(err as Error).message}); social channels refuse every subscribe until it does`);
  });
  return {
    kind: 'dynamo',
    chatStore: store,
    membershipStore,
    readReceiptStore: store.reads,
    conversations,
    chatOptions: (extra = {}) => ({
      ...store.chatOptions({
        // The library indexes `chat:dm:` names itself; a `social:dm:` DM reaches
        // it as a channel message, so its members are indexed here.
        onChannelMessage: (info) => {
          const ids = dmMembers(info.channel);
          if (ids) void conversations.recordDmMessage(info.channel, ids, info.message).catch(() => undefined);
          extra.onChannelMessage?.(info);
        },
      }),
      membershipStore,
    }),
    lastMessage: async (channel) => (await store.listMessages(channel, 1))[0] ?? null,
    recentMessages: (channel, limit) => store.listMessages(channel, limit),
    ready,
  };
}

/** Invites seen by `calls({ config.authorize })`, so a missed call knows who was rung and from where. */
const invites = new Map<string, { targets: string[]; channel: string | null; at: number }>();
const INVITE_TTL_MS = 10 * 60_000;

export function recordInvite(action: string, data: { callId?: unknown; targetUserIds?: unknown; channel?: unknown }): void {
  if (action !== 'invite' || typeof data?.callId !== 'string') return;
  const now = Date.now();
  for (const [id, v] of invites) if (now - v.at > INVITE_TTL_MS) invites.delete(id);
  const targets = Array.isArray(data.targetUserIds) ? data.targetUserIds.filter((t): t is string => typeof t === 'string') : [];
  invites.set(data.callId, { targets, channel: typeof data.channel === 'string' ? data.channel : null, at: now });
}

const MISSED_BODY: Record<string, string> = {
  cancelled: 'The call ended before anyone answered.',
  declined: 'The call was declined.',
  'no-answer': 'Nobody answered.',
};

/** Row 6: an invite that never became a call → its targets (from the invite, else a DM lobby's other members). */
export async function notifyMissedCall(summary: { callId: string; lobbyName: string; callerId: string; callerName?: string; reason: string }): Promise<void> {
  const seen = invites.get(summary.callId);
  invites.delete(summary.callId);
  const tenant = summary.lobbyName.split(':')[0] ?? '';
  if (!tenant) return;
  const dm = parseDmLobby(summary.lobbyName);
  const targets = (seen?.targets.length ? seen.targets : dm?.members ?? []).filter((u) => u !== summary.callerId);
  if (!targets.length) return;
  const channel = seen?.channel ?? null;
  const initiative = channel?.startsWith('initiative:') ? channel.slice('initiative:'.length) : null;
  const href = initiative && tenant === 'orgiq'
    ? `/iq/projects/${encodeURIComponent(initiative)}`
    : conversationHref(tenant, summary.lobbyName);
  const caller = summary.callerName || summary.callerId;
  await notify(targets, {
    type: 'call-missed',
    title: `Missed call from ${caller}`,
    body: MISSED_BODY[summary.reason] ?? 'Missed call.',
    channel: channel ?? summary.lobbyName,
    payload: { tenant, kind: 'call-missed', callId: summary.callId, lobbyName: summary.lobbyName, callerId: summary.callerId, callerName: caller, reason: summary.reason, ...(channel ? { channel } : {}) },
    action: { label: initiative ? 'Open the initiative' : 'Open the conversation', href },
  });
}

let status: { gateway: 'on' | 'off'; store: RealtimeGatewayStore | null } = { gateway: 'off', store: null };

/** For /api/health. */
export function realtimeGatewayStatus(): typeof status {
  return { ...status };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn('[realtime-gateway]', ...args),
  error: (...args: unknown[]) => console.error('[realtime-gateway]', ...args),
};

export interface AttachGatewayOptions {
  /** Override REDIS_URL (tests). `null` forces memory. */
  redisUrl?: string | null;
  pingIntervalMs?: number;
  /** Override the chat backend (tests). Default: from SOCIAL_CHAT_* (socialChatConfig). */
  socialChat?: SocialChatBackend;
}

/**
 * Attach chat + presence + calls on REALTIME_GATEWAY_PATH. The caller decides
 * whether to call this (realtimeGatewayEnabled) and must add the path to
 * rejectUnsupportedUpgrades' allowPaths.
 */
export function attachRealtimeGateway(server: Server, opts: AttachGatewayOptions = {}): RealtimeHandle & { store: RealtimeGatewayStore; redis: RedisLite | null } {
  const redisUrl = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() || null : opts.redisUrl;
  const redis = redisUrl ? new RedisLite(redisUrl) : null;
  const store: RealtimeGatewayStore = redis ? 'redis' : 'memory';
  const stateStore = redis ? new RedisCallStateStore(redis as unknown as CallStateRedis) : new InMemoryCallStateStore();
  const inbox = createGatewayNotificationStore(redis);
  const chatBackend = opts.socialChat ?? createSocialChatBackend();
  const chatOpts = chatBackend.chatOptions();
  // Bound after attach: the plugin and onConnect run only once sockets exist.
  let handleRef: RealtimeHandle | null = null;
  const notificationService = (): (NotificationSink & { replayUnreadForUser(clientId: string, userId: string): Promise<void> }) | null =>
    (handleRef?.services['notification'] as unknown as (NotificationSink & { replayUnreadForUser(clientId: string, userId: string): Promise<void> }) | undefined) ?? null;
  // Since realtime-modules 0.98.6 the router is the single authorization
  // point: a refused presence/reactions/cursor subscribe reaches no service
  // state and every fan-out runs `authorize` first, answering
  // `AUTHZ_CHANNEL_DENIED`. Under 0.98.5 the presence service ignored the
  // router's refusal (an orgiq user could read an assessment roster), and
  // this gateway briefly wired `presence({ authorizeChannel })` as well —
  // dropped again because that hook answers silently and hid the router's
  // refusal frame (assessment re-audit, 2026-09-29).
  const handle = attachRealtime(server, {
    path: REALTIME_GATEWAY_PATH,
    auth: authenticateGatewayUpgrade,
    pingIntervalMs: opts.pingIntervalMs ?? 30_000,
    logger,
    // Chat + presence channels are tenant-scoped like call lobbies.
    authorize: authorizeChannel,
    plugins: [
      dmNotifyPlugin(() => (handleRef?.router as unknown as DmRouter | undefined) ?? null),
      channelNotifyPlugin(() => (handleRef?.router as unknown as DmRouter | undefined) ?? null),
    ],
    // A fresh socket gets its unread set (the library leaves replay to the host).
    onConnect: (clientId: string, ctx: Record<string, unknown>) => {
      const userId = typeof ctx?.['userId'] === 'string' ? ctx['userId'] : '';
      if (userId) void notificationService()?.replayUnreadForUser(clientId, userId);
    },
    features: [
      chat({ ...chatOpts, chatStore: chatOpts.chatStore }),
      presence(),
      calls({
        stateStore,
        lobbyGuard: guardWithLog,
        config: {
          // Never refuses (the tenant rule is lobbyGuard's); records who an
          // invite rang, which onCallMissed's summary does not carry.
          authorize: (_clientId: string, action: string, data: { callId?: unknown; targetUserIds?: unknown; channel?: unknown }) => {
            recordInvite(action, data ?? {});
            return true;
          },
          // An invite with no targets is fanned out to every connected
          // client — every tenant. The portal's hooks always target.
          canCall: (_callerId: string, targetUserIds: string[]) => targetUserIds.length > 0,
          onCallMissed: (summary: { callId: string; lobbyName: string; callerId: string; callerName?: string; reason: string }) => notifyMissedCall(summary),
        },
      }),
      notifications({ store: inbox.store }),
    ],
  });
  handleRef = handle;
  setNotificationSink(notificationService());
  // The routes read the same backend; a mock reset drops the ChatService's
  // per-channel caches so the rebuilt fixture rows are what the next join reads.
  setSocialChatBackend(chatBackend, () => {
    (handleRef?.services['chat'] as unknown as { channelCaches?: Map<string, unknown> } | undefined)?.channelCaches?.clear();
  });
  if (inbox.memory) void seedMockNotifications().catch(() => undefined);
  status = { gateway: 'on', store };
  const where = redis ? `redis (${redisUrl!.replace(/\/\/[^@/]*@/, '//***@')})` : 'memory';
  console.log(`[realtime-gateway] serving ${REALTIME_GATEWAY_PATH} (chat, presence, calls, notifications); call state + inbox: ${where}; chat store: ${chatBackend.kind}`);
  if (redis) {
    void redis.ping().catch((err: unknown) => {
      console.warn(`[realtime-gateway] REDIS_URL is set but Redis did not answer (${(err as Error).message}); call frames will fail until it does`);
    });
  }
  const baseDispose = handle.dispose.bind(handle);
  return Object.assign(handle, {
    store,
    redis,
    dispose: async () => {
      setNotificationSink(null);
      setSocialChatBackend(null);
      releaseGatewayNotificationStore();
      handleRef = null;
      await baseDispose();
      await redis?.quit();
      status = { gateway: 'off', store: null };
    },
  });
}
