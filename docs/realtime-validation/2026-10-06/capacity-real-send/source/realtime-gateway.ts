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
// the current-principal preflight sees. Each channel read/write/recipient
// delivery and call action refreshes directory grants, source role and epoch.
// Token expiry itself is verified at upgrade; the portal re-fetches on drops.
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
//     channels;
//   - the distillation feed (`orgiq:distill:*`, lib/distillation-channels.ts)
//     is server-push only: a plain subscribe for whoever the REST read gate
//     admits, never a client publish, never a chat/presence/call on the name.
//
// Enabled by REALTIME_GATEWAY=on|off. Default: on outside production, off in
// production unless set, so the ECS task is unchanged until someone asks.
//
// Call state lives in Redis when REDIS_URL is set (realtime-modules'
// RedisCallStateStore over lib/redis-lite.ts), in memory otherwise. The
// Default routing is LocalRealtimeRouter. REALTIME_GATEWAY_ROUTER=redis opts
// into the upstream leased peer router through startRealtimeGateway; its
// connection/state ports are ready before the HTTP server listens. Keep the
// one-task cloud safeguard until full application/service-state contracts pass.
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
import { RedisPresenceStore } from '@connorhoehnslalom/realtime-modules/presence';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createOrgiqWorkGraphStream, type WorkGraphStreamPublisher } from './work-graph/stream.js';
import { attachRealtime, chat, presence, calls, notifications, reactions, fileUploads, workGraph, baseChannel, RedisRealtimeRouter, type AuthorityScope, type RedisRealtimeRouterOptions, type RealtimeHandle, type ChannelAuthorize } from '@connorhoehnslalom/realtime-modules/server';
import { RedisCallStateStore, InMemoryCallStateStore, type CallStateRedis } from '@connorhoehnslalom/realtime-modules/call';
import { CallPageRuntime, MemoryCallPageStore, RedisCallPageStore, observeCallPageLifecycle, setCallPageRuntime, type CallPageSnapshot } from './call-pages.js';
import { CallChatRuntime, huddleMembershipStore, inCallChatNamespace, setCallChatRuntime } from './call-chat.js';
import { withHuddleChat } from './call-chat-send.js';
import { withDmPageReferences } from './dm-page-references.js';
import { MemoryCallChatStateStore, RedisCallChatStateStore } from './call-chat-state.js';
import { DynamoChatStore, DynamoChatPinsStore, type DynamoCommandClient } from '@connorhoehnslalom/realtime-modules/server/stores/dynamo';
import type { ChatMember, ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { isAllowedBrowserOrigin } from './browser-origin.js';
import { upgradeScheme } from './trusted-proxy.js';
import { realtimeSigningSecret, tokenFromSubprotocol, verifyRealtimeToken } from './realtime-token.js';
import { RedisLite, type GatewayRedisStore } from './redis-lite.js';
import { GatewayRedis } from './gateway-redis.js';
import { hostname } from 'node:os';
import { createGatewayNotificationStore, releaseGatewayNotificationStore, seedMockNotifications } from './notification-store.js';
import { conversationHref, notify, notifyTenantChannelMention, parseDmLobby, resolveMentions, setNotificationSink, type NotificationSink } from './social-notify.js';
import {
  createMemorySocialChatBackend,
  dmMembers,
  tenantDmMembers,
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
import { inDistillationNamespace, isDistillationChannel, mayReadDistillation, setDistillationGatewayTarget } from './distillation-channels.js';
import { listChannels } from '../providers/social-channels.js';
import { isSocialTeamMember } from '../providers/social-platform.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../mock/social-channels.js';
import { authorizeLiveGatewayCall, authorizeLiveGatewayChannel, getLivePrincipal, huddleCallId } from './live-principal.js';
import { createReactionStore, gatewayUploadConfig, uploadFeatureOptions } from './gateway-attachments.js';
import { tenantActivity, tenantPipeline } from './gateway-run-feed.js';
import { inFlowRunNamespace, parseFlowRunChannel } from './flow-runs/channel.js';
import { directRecipientFilter } from './direct-recipient.js';
import { TENANT_PARTITIONS, channelAuthorityFor, tenantChannelFamily, type TenantChannelFamily } from './tenant-channels.js';
import { inSocialDeckNamespace, parseSocialDeckChannel, socialDeckPresenceChannel } from './social-deck-channel.js';
import { DynamoDispatchQueue } from './dynamo-dispatch.js';

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
    // The viewer's scheme behind the declared proxies (lib/trusted-proxy.ts).
    if (!isAllowedBrowserOrigin(origin, `${upgradeScheme(req)}://${req.headers.host ?? ''}`)) {
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
    epoch: claims.epoch ?? 0,
    sessionIat: Number((claims as unknown as { iat?: number }).iat) || 0,
    ...(claims.act ? { act: { sub: claims.act.sub, epoch: claims.act.epoch ?? 0 } } : {}),
  };
}

/** `social:team:<team slug>:<channel>` — a team's chat channel (design §4.3). */
const TEAM_CHANNEL = /^social:team:([^:]+):[^:]+$/;

type GuardAuth = { userId?: unknown; org?: unknown; tenants?: unknown; role?: unknown };

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
 * Under `orgiq:`/`assessment:`/`pipelines:` only a family lib/tenant-channels.ts
 * lists as a lobby (`orgiq:initiative:<id>`, `assessment:doc:<id>`) is a call
 * lobby; anything else is refused (default deny, 2026-10-05). Social rooms
 * and other `social:` names stay governed by live-principal's Social actions.
 * The family's resource authority itself is asked asynchronously against the
 * reloaded session (live-principal.ts), never here.
 */
export function lobbyGuard(auth: GuardAuth, lobbyName: string): boolean {
  // Call chat is an HTTP-authorized application conversation, not a lobby.
  if (inCallChatNamespace(lobbyName)) return false;
  // The distillation feed is a server push, not a place to call into.
  if (inDistillationNamespace(lobbyName)) return false;
  // So is a flow run's private status channel.
  if (inFlowRunNamespace(lobbyName)) return false;
  // A Social deck's presence channel is not a place to call into either.
  if (inSocialDeckNamespace(lobbyName)) return false;
  return admitName(auth, lobbyName, family => family.lobby);
}

/** The partition, DM, team and Social-channel rules shared by lobbies and
 * channels; `familyAllows` decides a name under a non-Social tenant partition. */
function admitName(auth: GuardAuth, name: string, familyAllows: (family: TenantChannelFamily) => boolean): boolean {
  const org = typeof auth.org === 'string' ? auth.org : '';
  const userId = typeof auth.userId === 'string' ? auth.userId : '';
  if (!userId) return false;
  const tenants = Array.isArray(auth.tenants) ? auth.tenants.filter((t): t is string => typeof t === 'string' && !!t) : [];
  const cut = name.indexOf(':');
  if (cut <= 0) return false;
  const partition = name.slice(0, cut);
  if (partition !== org && !tenants.includes(partition)) return false;
  const rest = name.slice(cut + 1);
  if (!rest) return false;
  if (rest === 'dm' || rest.startsWith('dm:')) {
    const ids = rest.slice(3).split(':').filter(Boolean);
    return ids.includes(userId);
  }
  const team = TEAM_CHANNEL.exec(name);
  if (team) return isSocialTeamMember(team[1]!, userId);
  if (partition === 'social' && rest.startsWith('team:')) return false; // a malformed team name
  // A channel's CALL lobby is the channel: `social:ch:<slug>` admits the
  // channel's active members only, the same rows chat on it checks. Until
  // 2026-09-30 only chat asked membership, so any social grant holder could
  // ring or join a private channel's call (social chat-workspace walk).
  if (name.startsWith(SOCIAL_CHANNEL_PREFIX)) {
    return !!slugForChannel(name) && socialChat().membershipStore.isActiveMember(name, userId);
  }
  if (TENANT_PARTITIONS.has(partition)) {
    const family = tenantChannelFamily(name);
    return !!family && familyAllows(family);
  }
  return partition === 'social';
}

/**
 * May this connection subscribe to / publish on `channel` (chat, presence)?
 * The same rule as lobbies (2026-09-29; widened to the token's `tenants` by
 * E5): only channels whose partition the caller holds a grant in, a
 * `<p>:dm:<a>:<b>…` channel only when the caller is one of the ids, a team
 * channel only for the team's members. Before this, `lobbyGuard` scoped calls
 * only, and every orgiq persona could join `assessment:doc:<id>` — read its
 * history and post into it (assessment isolation walk, 2026-09-29).
 * Under a non-Social tenant only the families in lib/tenant-channels.ts, and
 * only the services each offers, pass this shape check (2026-10-05).
 */
export function channelGuard(auth: GuardAuth | null, channel: string, kind: 'subscribe' | 'publish' = 'subscribe'): boolean {
  if (auth == null) return false;
  const bare = baseChannel(channel);
  // `orgiq:huddle:<callId>` (lib/call-chat.ts): shape only here — chat on
  // the exact name or reactions on it, for a token holding orgiq. Whether this
  // CONNECTION is a current seat of that call is asked fresh by
  // live-principal's authorizeHuddleChannel, every time (never a grant alone).
  if (inCallChatNamespace(bare)) {
    const callId = huddleCallId(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!callId && (channel === bare || channel === `reactions:${bare}`) && typeof auth.userId === 'string' && !!auth.userId
      && (org === 'orgiq' || tenants.includes('orgiq'));
  }
  // `orgiq:distill:*` (lib/distillation-channels.ts): only the server pushes
  // there, so a client may hold a plain subscription — no service prefix, no
  // publish — and only under the REST read gate (active tenant orgiq, or admin).
  // The partition rule alone would let any orgiq grant holder publish forged
  // frames to every reader, and admit someone standing in another tenant.
  if (inDistillationNamespace(bare)) {
    return kind === 'subscribe' && channel === bare && isDistillationChannel(bare) && mayReadDistillation(auth);
  }
  // `<tenant>:flowrun:<runId>` (lib/flow-runs/channel.ts): shape only here —
  // a plain subscribe, never a publish or a service prefix, in a partition the
  // caller holds. Whether this caller requested the run is asked against the
  // durable row by live-principal's authorizeFlowRunChannel, every time.
  if (inFlowRunNamespace(bare)) {
    const ref = parseFlowRunChannel(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!ref && kind === 'subscribe' && channel === bare && typeof auth.userId === 'string' && !!auth.userId
      && (ref.tenant === org || tenants.includes(ref.tenant));
  }
  // `social:deck:<id>` (lib/social-deck-channel.ts): shape only here — the
  // presence service on a well-formed deck id, in a partition the caller holds.
  // Whether this caller owns the deck or is a current member of its source
  // conversation is asked fresh by live-principal's authorizeSocialDeckChannel.
  if (inSocialDeckNamespace(bare)) {
    const ref = parseSocialDeckChannel(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!ref && channel === socialDeckPresenceChannel(ref.deckId) && typeof auth.userId === 'string' && !!auth.userId
      && (org === 'social' || tenants.includes('social'));
  }
  // Membership for a `social:ch:<slug>` channel (design §4.2) is asked inside
  // admitName, so chat, presence and the channel's call lobby agree.
  return admitName(auth, bare, family => channelAuthorityFor(family, channel, kind) !== null);
}

/**
 * The channel a tenant/membership rule judges is the library's `baseChannel`
 * (realtime-modules 0.107, /server): `presence:`/`reactions:`/`cursor:` are
 * removed, and `chat:` only where `channelForLobby` put it around a DM lobby
 * (`chat:social:dm:a:b` → `social:dm:a:b`). Until 0.107 this file stripped
 * its own wider set (`chat|typing|activity|pins` as well). No library service,
 * portal hook or host producer names a channel with those four prefixes (the
 * chat service subscribes and fans out on the bare name; typing is a chat
 * action on it; `activity:broadcast` is the library's firehose, refused here
 * either way), so the narrower rule only stops admitting them: such a name
 * keeps its prefix as its partition, which is never a tenant, and fails closed.
 *
 * @deprecated kept as an alias for existing importers; use `baseChannel`.
 */
export const stripServicePrefix: (channel: string) => string = baseChannel;

// The installed async-aware router awaits each decision, including recipient
// fanout. Captured token grants never substitute for current directory rights.
// `scope` (0.107) is one library operation; live-principal shares only its
// Social membership read across that operation's checks, never past it.
const authorizeChannel: ChannelAuthorize = async ({ kind, clientId, channel, ctx, scope }) => {
  const ok = await authorizeLiveGatewayChannel({ kind, clientId, channel, ctx, ...(scope ? { scope } : {}) }, { guard: channelGuard, baseChannel });
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

/** Public subscription probes cover current local and peer readers. The private
 * inventory remains a compatibility fallback for older local routers. */
interface DmRouter {
  getUserIdForClient?(clientId: string): string | undefined;
  getClientsByUserId?(userIds: string[]): Array<{ clientId: string; userId: string }> | Promise<Array<{ clientId: string; userId: string }>>;
  isClientSubscribed?(clientId: string, channel: string, opts?: { scope?: AuthorityScope }): boolean | Promise<boolean>;
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

/** Public peer-aware probes verify the actual recipient's readable
 * subscription. An unavailable/legacy router retains conservative alerts.
 * `scope` is the send's operation when the caller has one: since 0.108 the
 * router hands every plugin hook the operation's scope (`info.scope`, retained
 * until the hook settles, at most PLUGIN_SCOPE_RETAIN_MAX_MS), so the probes
 * below share the send's membership proof — one durable read per channel
 * across the send's authorize checks and its plugins. A revocation observed
 * during the operation still denies every later probe (live-principal's
 * sticky shared fence); a closed scope is never passed on. */
export async function liveSubscribersForUsers(router: DmRouter, channel: string, users: string[], scope?: AuthorityScope): Promise<Set<string> | null> {
  if (!router.getClientsByUserId || !router.isClientSubscribed) return liveSubscribers(router, channel);
  try {
    const wanted = new Set(users), live = new Set<string>();
    const probe = (clientId: string, name: string) => scope?.active
      ? router.isClientSubscribed!(clientId, name, { scope }) : router.isClientSubscribed!(clientId, name);
    const clients = await router.getClientsByUserId([...wanted]);
    await Promise.all(clients.filter(client => wanted.has(client.userId)).map(async client => {
      if (await probe(client.clientId, channel) || await probe(client.clientId, `chat:${channel}`)) live.add(client.userId);
    }));
    return live;
  } catch { return null; }
}

type ChatPluginArgs = { clientId: string; channelId: string; message: unknown; userId?: string; scope?: AuthorityScope };
/** The send's authority scope while it is still open, else nothing (a fresh read). */
const liveScope = (args: ChatPluginArgs): AuthorityScope | undefined => args.scope?.active ? args.scope : undefined;
type ChatFrameMessage = { userId?: unknown; message?: unknown; metadata?: { userId?: unknown; displayName?: unknown } };

/**
 * The one reading of a notify plugin's input: a chat `message` frame whose
 * server-stamped sender agrees with the authenticated sender (the plugin's
 * `userId`, else the publishing connection's). Null for anything else.
 */
function chatMessageFrame(args: ChatPluginArgs, getRouter: () => DmRouter | null):
  { channel: string; router: DmRouter | null; sender: string; message: ChatFrameMessage; text: string; displayName: string | undefined } | null {
  const frame = args.message as { type?: unknown; action?: unknown; message?: ChatFrameMessage } | null;
  if (!frame || frame.type !== 'chat' || frame.action !== 'message' || !frame.message) return null;
  const router = getRouter();
  const sender = args.userId ?? router?.getUserIdForClient?.(args.clientId);
  const stamped = frame.message.userId ?? frame.message.metadata?.userId;
  if (!sender || (typeof stamped === 'string' && stamped !== sender)) return null;
  const name = frame.message.metadata?.displayName;
  return {
    channel: baseChannel(args.channelId), router, sender, message: frame.message,
    text: typeof frame.message.message === 'string' ? frame.message.message : '',
    displayName: typeof name === 'string' && name ? name : undefined,
  };
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
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame || !frame.router) return;
      const { channel, router, sender, message } = frame;
      const dm = parseDmLobby(channel);
      if (!dm || !dm.members.includes(sender)) return;
      const live = await liveSubscribersForUsers(router, channel, dm.members.filter(user => user !== sender), liveScope(args));
      const recipients = dm.members.filter((u) => u !== sender && !(live?.has(u) ?? false));
      if (!recipients.length) return;
      const name = frame.displayName ?? sender;
      void notify(recipients, {
        type: 'message',
        title: `${name} sent you a message`,
        body: snippet(message.message) || 'New message',
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
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame) return;
      const { channel, router, sender } = frame;
      const slug = slugForChannel(channel);
      if (!slug) return;
      const store = members();
      const scope = liveScope(args);
      // With the send's scope the rows are the SAME durable read its
      // authorize checks resolved (no extra membership query); a write or peer
      // hint during the send makes listMembers read fresh instead. Without one
      // (an unscoped or already-closed operation) the mirror answers, as before.
      const active = async () => scope
        ? (await store.listMembers(channel, { scope })).filter(m => !m.removedAt).map(m => m.userId)
        : store.activeMembers(channel).map(m => m.userId);
      const before = await active();
      if (!before.includes(sender)) return;
      const audience = before.filter((u) => u !== sender);
      if (!audience.length) return;
      const live = router ? await liveSubscribersForUsers(router, channel, audience, scope) : null;
      // A removal that landed while the probes ran must not still be alerted:
      // ask the operation's proof again (shared while unchanged, fresh after a
      // change) and keep only members who are still active.
      const after = scope ? new Set(await active()) : null;
      const current = after ? audience.filter(u => after.has(u)) : audience;
      if (!current.length || (after && !after.has(sender))) return;
      await notifyChannelMessage({ channel, slug, sender, name: frame.displayName ?? sender, text: frame.text, audience: current, live });
    },
  };
}

/**
 * Mentions in orgiq initiative/work, pipelines run/definition and assessment
 * document chat. Only `mention` items: these threads have no message alerts.
 * The sender is the authenticated plugin user (or the publishing connection).
 */
export function tenantMentionNotifyPlugin(getRouter: () => DmRouter | null) {
  return {
    name: 'tenant-mention-notify',
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame) return;
      const { channel, sender, text, displayName } = frame;
      if (!/^(orgiq:(initiative|work)|pipelines:(run|def)|assessment:doc):/.test(channel)) return;
      // Awaited so the send's scope is retained while the readers are asked:
      // their membership reads share the send's proof (one read per channel).
      const scope = liveScope(args);
      await notifyTenantChannelMention({ channel, sender, ...(displayName ? { senderName: displayName } : {}), text, ...(scope ? { scope } : {}) });
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
  const maxSockets = Number(process.env['SOCIAL_CHAT_MAX_SOCKETS'] ?? 50);
  if (!Number.isSafeInteger(maxSockets) || maxSockets < 1 || maxSockets > 256) throw new Error('SOCIAL_CHAT_MAX_SOCKETS must be an integer from 1 to 256');
  const sdk = new DynamoDBClient({
    region: cfg.region,
    // Keep the established SDK concurrency by default. Load profiles can
    // select a bounded pool explicitly; stalled replies have a deadline.
    requestHandler: { httpAgent: { maxSockets }, httpsAgent: { maxSockets },
      connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  // Opt-in only: the dispatch queue regressed the unchanged burst profile.
  return process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE'] === '1' ? new DynamoDispatchQueue(sdk, maxSockets) : sdk;
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
  const client = opts.client ?? socialChatClient(cfg);
  const store = new DynamoChatStore({ client, tablePrefix: cfg.tablePrefix, logger });
  const pinsStore = new DynamoChatPinsStore({ client, tableName: `${cfg.tablePrefix}chat-pins` });
  const mirror: ChatMember[] = [];
  const membershipStore = new MirroredMembershipStore(() => mirror, store.members,
    client instanceof DynamoDispatchQueue ? read => client.dispatchMembershipRead(read) : undefined);
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
    pinsStore,
    conversations,
    chatOptions: (extra = {}) => {
      const library = store.chatOptions({ onChannelMessage: (info) => extra.onChannelMessage?.(info) });
      return {
        ...library,
        // The library indexes `chat:dm:` names itself; a `social:dm:` DM reaches
        // it as a channel message, so its members (from the name) are indexed
        // here INSTEAD of by the library's channel hook. Both used to run, so
        // every DM send wrote the same two conversation rows twice (4 UpdateItems
        // per send in the 2026-10-06 capacity-real-send profile).
        onChannelMessage(this: unknown, info: Parameters<NonNullable<typeof library.onChannelMessage>>[0]) {
          const ids = tenantDmMembers(info.channel);
          if (!ids) return library.onChannelMessage?.call(this, info);
          void conversations.recordDmMessage(info.channel, ids, info.message).catch(() => undefined);
          extra.onChannelMessage?.(info);
        },
        membershipStore,
      };
    },
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
let ready: (() => boolean) | null = null;

/** For /api/health. */
export function realtimeGatewayStatus(): typeof status & { ready?: boolean } {
  return { ...status, ...(ready ? { ready: ready() } : {}) };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn('[realtime-gateway]', ...args),
  error: (...args: unknown[]) => console.error('[realtime-gateway]', ...args),
};

// ── Load line (docs/realtime-capacity-100-calls-2026-10-01.md §6, item 9) ──
//
// One JSON line per interval on stdout, which the ECS awslogs driver ships to
// /ecs/<prefix>-middleware, where OrgIQ-MiddlewareService's metric filters
// (realtimeAlarms=true) turn the fields into CloudWatch metrics. The gateway
// is pinned to ONE task, so "is it near its ceiling" is exactly these three
// numbers: sockets on this process, calls it is holding, and how late the
// event loop runs (a ring frame waits behind every blocked millisecond).

export const GATEWAY_STATS_TYPE = 'realtime-gateway-stats';

export interface GatewayStatsInput {
  sockets: number;
  activeCalls: number;
  /** monitorEventLoopDelay percentiles, nanoseconds. */
  eventLoopP99Ns: number;
  eventLoopMaxNs: number;
  rssBytes: number;
  store: RealtimeGatewayStore;
}

/** The log line, pure. Field names are the metric filter's contract (infra). */
export function gatewayStatsLine(input: GatewayStatsInput, now: Date = new Date()): string {
  const ms = (ns: number) => Math.round((Number.isFinite(ns) ? ns : 0) / 1e4) / 100;
  return JSON.stringify({
    type: GATEWAY_STATS_TYPE,
    sockets: input.sockets,
    activeCalls: input.activeCalls,
    eventLoopDelayP99Ms: ms(input.eventLoopP99Ns),
    eventLoopDelayMaxMs: ms(input.eventLoopMaxNs),
    rssMb: Math.round(input.rssBytes / 1048576),
    store: input.store,
    ts: now.toISOString(),
  });
}

/** Calls the CallService is holding on this process (its per-node map). */
export function activeCallCount(services: Record<string, unknown>): number {
  for (const name of ['call', 'calls']) {
    const active = (services[name] as { activeCalls?: { size?: number } } | undefined)?.activeCalls;
    if (typeof active?.size === 'number') return active.size;
  }
  return 0;
}

/** REALTIME_STATS_INTERVAL_MS, default 60 s; 0 turns the line off. */
export function statsIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['REALTIME_STATS_INTERVAL_MS'] ?? '').trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

function startStatsLine(handle: RealtimeHandle, store: RealtimeGatewayStore, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => undefined;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    try {
      console.log(gatewayStatsLine({
        sockets: handle.listClients().length,
        activeCalls: activeCallCount(handle.services as unknown as Record<string, unknown>),
        eventLoopP99Ns: histogram.percentile(99),
        eventLoopMaxNs: histogram.max,
        rssBytes: process.memoryUsage().rss,
        store,
      }));
    } finally {
      histogram.reset();
    }
  }, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); histogram.disable(); };
}

export interface AttachGatewayOptions {
  /** Override REALTIME_STATS_INTERVAL_MS (tests). */
  statsIntervalMs?: number;
  /** Override REDIS_URL (tests). `null` forces memory. */
  redisUrl?: string | null;
  pingIntervalMs?: number;
  /** Override the chat backend (tests). Default: from SOCIAL_CHAT_* (socialChatConfig). */
  socialChat?: SocialChatBackend;
  /** Connected host-owned stores for the async cluster startup. */
  redisClient?: GatewayRedisStore;
  routerFactory?: (hooks: Pick<RedisRealtimeRouterOptions, 'authorize' | 'filterClientMessage' | 'plugins'>) => RedisRealtimeRouter;
}

export type GatewayHandle = RealtimeHandle & { store: RealtimeGatewayStore; redis: GatewayRedisStore | null };

/** Ready transport before the host starts accepting upgrades. The synchronous
 * attach function remains available to existing single-gateway callers. */
export async function startRealtimeGateway(server: Server, opts: AttachGatewayOptions = {}): Promise<GatewayHandle> {
  const routing = (process.env['REALTIME_GATEWAY_ROUTER'] ?? 'local').trim();
  if (routing === 'local') return attachRealtimeGateway(server, opts);
  if (routing !== 'redis') throw new Error('REALTIME_GATEWAY_ROUTER must be local or redis');
  const redisUrl = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() : opts.redisUrl;
  if (!redisUrl) throw new Error('Redis peer routing requires REDIS_URL');
  const bound = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const redis = new GatewayRedis(redisUrl, bound('REDIS_COMMAND_TIMEOUT_MS', 2000));
  await redis.open();
  let router: RedisRealtimeRouter | undefined;
  let handle: GatewayHandle | undefined;
  try {
    handle = attachRealtimeGateway(server, { ...opts, redisClient: redis, routerFactory: hooks => {
      router = new RedisRealtimeRouter({ ...hooks, redis: redis.cluster,
        namespace: process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway',
        nodeId: process.env['REALTIME_GATEWAY_NODE_ID'] || `${hostname()}:${process.pid}`,
        leaseMs: bound('REALTIME_GATEWAY_LEASE_MS', 30000),
        requestTimeoutMs: bound('REALTIME_GATEWAY_RECEIPT_TIMEOUT_MS', 3000) });
      return router;
    } });
    await router!.start();
    console.log('[realtime-gateway] Redis peer routing ready', { nodeId: router!.nodeId });
    return handle;
  } catch (error) {
    if (handle) await handle.dispose(); else await redis.quit();
    throw error;
  }
}

/**
 * Attach chat + presence + calls on REALTIME_GATEWAY_PATH. The caller decides
 * whether to call this (realtimeGatewayEnabled) and must add the path to
 * rejectUnsupportedUpgrades' allowPaths.
 */
export function attachRealtimeGateway(server: Server, opts: AttachGatewayOptions = {}): GatewayHandle {
  const redisUrl = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() || null : opts.redisUrl;
  const redis = opts.redisClient ?? (redisUrl ? new RedisLite(redisUrl) : null);
  const store: RealtimeGatewayStore = redis ? 'redis' : 'memory';
  const baseStateStore = redis ? new RedisCallStateStore(redis as unknown as CallStateRedis) : new InMemoryCallStateStore();
  let pageRuntime: CallPageRuntime | null = null;
  let chatRuntime: CallChatRuntime | null = null;
  const stateStore = observeCallPageLifecycle(baseStateStore, () => pageRuntime, () => chatRuntime);
  const inbox = createGatewayNotificationStore(redis);
  const chatBackend = opts.socialChat ?? createSocialChatBackend();
  const chatOpts = chatBackend.chatOptions();
  // The orgiq work graph's live stream (lib/work-graph/stream.ts).
  const workGraphStream = createOrgiqWorkGraphStream();
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
  const routerHooks: Pick<RedisRealtimeRouterOptions, 'authorize' | 'filterClientMessage' | 'plugins'> = {
    authorize: authorizeChannel,
    filterClientMessage: directRecipientFilter({ guard: lobbyGuard,
      getLobby: async callId => (await baseStateStore.getCall(callId))?.lobbyName ?? null }, async ({ clientId, message }) => {
      try {
        const frame = message as Record<string, unknown>;
        return frame.type === 'call-page'
          ? await pageRuntime?.filterSnapshot(clientId, frame as unknown as CallPageSnapshot) ?? null
          : await chatRuntime?.filterFrame(clientId, frame) ?? null;
      } catch { return null; }
    }),
    plugins: [
      dmNotifyPlugin(() => (handleRef?.router as unknown as DmRouter | undefined) ?? null),
      channelNotifyPlugin(() => (handleRef?.router as unknown as DmRouter | undefined) ?? null),
      tenantMentionNotifyPlugin(() => (handleRef?.router as unknown as DmRouter | undefined) ?? null),
      workGraphStream.plugin,
    ],
  };
  const clusterRouter = opts.routerFactory?.(routerHooks);
  const handle = attachRealtime(server, {
    path: REALTIME_GATEWAY_PATH,
    auth: async req => {
      const ctx = await authenticateGatewayUpgrade(req);
      // A valid signature is not a current session. Refuse retired roles,
      // epochs and operator provenance before registering a cluster owner.
      await getLivePrincipal(ctx);
      if (clusterRouter && !clusterRouter.isReady()) throw new Error('Realtime gateway ownership is unavailable');
      return ctx;
    },
    // This socket carries signalling and chat; canvas updates use /realtime.
    maxPayload: 256 * 1024,
    pingIntervalMs: opts.pingIntervalMs ?? 30_000,
    logger,
    // Chat + presence channels are tenant-scoped like call lobbies.
    ...(clusterRouter ? { router: clusterRouter } : routerHooks),
    // A fresh socket gets its unread set (the library leaves replay to the host).
    onConnect: (clientId: string, ctx: Record<string, unknown>) => {
      const userId = typeof ctx?.['userId'] === 'string' ? ctx['userId'] : '';
      if (userId) void notificationService()?.replayUnreadForUser(clientId, userId);
    },
    features: [
      // Tenant and team prefixes make valid channel names exceed the
      // library's 50-character default (a 40-character team slug + General).
      // Huddle chat (`orgiq:huddle:<callId>`) is this same service: its
      // membership rows come from the call-chat mirror and its sends carry the
      // huddle contract (lib/call-chat-send.ts withHuddleChat).
      withHuddleChat(withDmPageReferences(chat({ ...chatOpts, chatStore: chatOpts.chatStore, maxChannelNameLength: 256,
        membershipStore: huddleMembershipStore(chatOpts.membershipStore, () => chatRuntime) })),
        () => chatRuntime),
      presence(clusterRouter && redis ? { store: new RedisPresenceStore({ command: (...args) => redis.command(...args) },
        process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway') } : {}),
      calls({
        stateStore,
        ...(clusterRouter ? { crossNodePubSub: clusterRouter.crossNodePubSub } : {}),
        config: {
          // The library trusts callerId on invite. Prove it at this host
          // boundary before it becomes call ownership (including stop rights).
          // Normalize the same flat/nested envelopes the public service accepts.
          authorize: async (clientId: string, action: string, data: Record<string, unknown>) => {
            let payload = data ?? {};
            const nested = payload['data'];
            if (payload['callId'] == null && payload['lobbyName'] == null
              && nested && typeof nested === 'object' && !Array.isArray(nested)) {
              payload = { ...(nested as Record<string, unknown>), ...payload };
            }
            const ctx = handleRef?.router.getClientData?.(clientId)?.userContext ?? null;
            const allowed = await authorizeLiveGatewayCall(ctx, action, payload, {
              guard: guardWithLog,
              getLobby: async callId => (await baseStateStore.getCall(callId))?.lobbyName ?? null,
            });
            if (!allowed) return false;
            recordInvite(action, payload);
            return true;
          },
          // An invite with no targets is fanned out to every connected
          // client — every tenant. The portal's hooks always target.
          canCall: (_callerId: string, targetUserIds: string[]) => targetUserIds.length > 0,
          onCallMissed: (summary: { callId: string; lobbyName: string; callerId: string; callerName?: string; reason: string }) => notifyMissedCall(summary),
          onCallEnded: (summary: { callId: string; participantClientIds: string[] }) => {
            void pageRuntime?.finish(summary.callId, summary.participantClientIds).catch(error => console.warn('[call-page] terminal cleanup failed', error));
            void chatRuntime?.finish(summary.callId, summary.participantClientIds).catch(error => console.warn('[call-chat] terminal cleanup failed', error));
          },
        },
      }),
      // Reactions follow chat's channel authority (the router's `authorize`
      // strips `reactions:`); targeted ones persist in Redis or memory.
      reactions({ store: createReactionStore(redis ? { command: (...args) => redis.command(...args) } : null,
        process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway'), maxChannelNameLength: 256 }),
      // Socket verbs for uploads; bytes ride /api/uploads (routes/index.ts).
      // Off in production unless a mounted volume is configured.
      ...(gatewayUploadConfig().enabled ? [fileUploads(uploadFeatureOptions(
        clientId => handleRef?.router.getClientData?.(clientId)?.userContext ?? null,
        { guard: channelGuard, baseChannel }))] : []),
      // Library activity + pipeline features under the tenant channel families
      // (lib/gateway-run-feed.ts): server-produced, default-deny.
      tenantActivity(),
      tenantPipeline(),
      // The work graph's per-viewer stream: default deny (channelFor maps only
      // orgiq readers onto `orgiq:workgraph:<subject>`, which the router's
      // authorize judges); server-publish only; frames from the viewer's own
      // rebuilt snapshot (lib/work-graph/stream.ts).
      workGraph({ channelFor: workGraphStream.channelFor, source: workGraphStream.source }),
      notifications({ store: inbox.store, authorize: async clientId => {
        const ctx = handleRef?.router.getClientData?.(clientId)?.userContext ?? null;
        try {
          await getLivePrincipal(ctx);
          return ctx !== null && handleRef?.router.getClientData?.(clientId)?.userContext === ctx;
        } catch { return false; }
      } }),
    ],
  });
  handleRef = handle;
  const stopWorkGraph = workGraphStream.attach(handle.services['work-graph'] as unknown as WorkGraphStreamPublisher,
    clusterRouter?.peerEvents ?? null);
  const stopPeerMembership = clusterRouter?.peerEvents.subscribe('social:membership', payload => {
    try {
      const channel = JSON.parse(payload) as unknown;
      if (typeof channel === 'string' && channel.startsWith('social:') && channel.length <= 256) {
        chatBackend.membershipStore.invalidate(channel);
      }
    } catch { /* An invalidation hint is never a membership record. */ }
  });
  const stopMembershipWrites = chatBackend.membershipStore.onCommittedWrite(channel => {
    if (clusterRouter) void clusterRouter.peerEvents.publish('social:membership', JSON.stringify(channel))
      .catch(error => console.warn('[social-membership] peer invalidation failed', error));
  });
  pageRuntime = new CallPageRuntime({ calls: baseStateStore, pages: redis ? new RedisCallPageStore(redis) : new MemoryCallPageStore(), router: handle.router, lobbyAllowed: lobbyGuard });
  setCallPageRuntime(pageRuntime);
  chatRuntime = new CallChatRuntime({ calls: baseStateStore, state: redis ? new RedisCallChatStateStore(redis) : new MemoryCallChatStateStore(),
    messages: chatBackend.chatStore, router: handle.router, lobbyAllowed: lobbyGuard });
  setCallChatRuntime(chatRuntime);
  setNotificationSink(notificationService());
  // lib/distillation-realtime.ts pushes the distillation feed here as well as
  // on /realtime: this is the socket the portal actually opens.
  setDistillationGatewayTarget(handle.router);
  // The routes read the same backend; a mock reset drops the ChatService's
  // per-channel caches so the rebuilt fixture rows are what the next join reads.
  setSocialChatBackend(chatBackend, () => {
    (handleRef?.services['chat'] as unknown as { channelCaches?: Map<string, unknown> } | undefined)?.channelCaches?.clear();
  }, (channel) => {
    void Promise.resolve(handle.router.sendToChannel(channel, { type: 'chat:pins-changed', channel })).catch((error: unknown) => {
      console.warn('[social-pins] live refresh failed', error);
    });
  });
  if (inbox.memory) void seedMockNotifications().catch(() => undefined);
  status = { gateway: 'on', store };
  ready = clusterRouter ? () => clusterRouter.isReady() : null;
  const where = redis ? `redis (${redisUrl!.replace(/\/\/[^@/]*@/, '//***@')})` : 'memory';
  console.log(`[realtime-gateway] serving ${REALTIME_GATEWAY_PATH} (chat, presence, calls, notifications, work-graph); call state + inbox: ${where}; chat store: ${chatBackend.kind}`);
  if (redis) {
    void redis.ping().catch((err: unknown) => {
      console.warn(`[realtime-gateway] REDIS_URL is set but Redis did not answer (${(err as Error).message}); call frames will fail until it does`);
    });
  }
  const stopStats = startStatsLine(handle, store, opts.statsIntervalMs ?? statsIntervalMs());
  const baseDispose = handle.dispose.bind(handle);
  return Object.assign(handle, {
    store,
    redis,
    dispose: async () => {
      stopStats();
      // Keep feature runtimes/ports live until socket disconnect hooks finish.
      try { await baseDispose(); } finally {
        stopWorkGraph();
        stopPeerMembership?.();
        stopMembershipWrites();
        pageRuntime?.dispose();
        setCallPageRuntime(null);
        chatRuntime?.dispose();
        setCallChatRuntime(null);
        setNotificationSink(null);
        setDistillationGatewayTarget(null);
        setSocialChatBackend(null);
        releaseGatewayNotificationStore();
        handleRef = null;
        await redis?.quit();
        status = { gateway: 'off', store: null };
        ready = null;
      }
    },
  });
}
