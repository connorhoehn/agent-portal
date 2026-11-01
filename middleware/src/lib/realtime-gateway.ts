// The OrgIQ middleware as its own realtime gateway (docs/social-calls-plan.md
// step 7, deploy-plan risk #2 — the gateway half): COMPOSITION ONLY.
//
//   ws(s)://<middleware>/ws     Sec-WebSocket-Protocol: bearer-token-v1, <jwt>
//   features: chat, presence, cursor, calls, meeting, reactions, uploads, activity,
//             pipeline, work-graph, notifications (+ the library's built-in subscribe)
//
// Why here and not realtime-examples' gateway container: that server verifies
// Cognito id_tokens (or runs with SKIP_AUTH, which trusts any claims), and it
// cannot scope a lobby to a tenant. Serving the socket from the BFF makes the
// identity OUR token — the HS256 realtime token `GET /api/session/realtime-token`
// mints (lib/realtime-token.ts) — and lets every feature refuse a name outside
// the caller's tenant.
//
// The split (docs/realtime-validation/2026-10-08/gateway-split.md): this file
// attaches the library's features to the BFF's server, chooses the routers and
// stores, and wires the runtimes; it decides nothing about who may do what.
//   lib/gateway/auth.ts            socket admission (origin, subprotocol, the token)
//   lib/gateway/authority.ts       the ONE authority facade: the shape guards
//                                  (`lobbyGuard`, `channelGuard`) and every
//                                  fresh-per-request `admit*` decision
//   lib/gateway/calls.ts           the calls feature, invites, missed calls
//   lib/gateway/meeting.ts         raised hands and breakout rooms on a call
//   lib/gateway/notify-plugins.ts  DM / channel / mention producers, page-thread unread options
//   lib/gateway/stats.ts           the load line
//   lib/gateway/env.ts             the tuning knobs
//   lib/gateway-cursor.ts, gateway-run-feed.ts, gateway-attachments.ts,
//   redis-store.ts                 cursor, activity/pipeline, reactions/uploads,
//                                  application Redis store shapes
//   lib/social-chat.ts             both chat store factories (memory, Dynamo)
// Every name this file exported before the split is re-exported below, so no
// importer moved.
//
// Enabled by REALTIME_GATEWAY=on|off. Default: on outside production, off in
// production unless set, so the ECS task is unchanged until someone asks.
//
// Call state lives in Redis when REDIS_URL is set (realtime-modules'
// RedisCallStateStore over lib/redis-store.ts), in memory otherwise. The
// default routing is LocalRealtimeRouter. REALTIME_GATEWAY_ROUTER=redis opts
// into the upstream leased peer router through startRealtimeGateway; its
// connection/state ports are ready before the HTTP server listens. Keep the
// one-task cloud safeguard until full application/service-state contracts pass.
// REALTIME_FANOUT=redis is a compatibility alias for this same native path,
// never for the retired application DistributedRealtimeRouter implementation.
//
// Notifications (docs/social-tenant-design.md §3.3–§3.4): the library's
// user-addressed inbox, persisted by lib/notification-store.ts. The library
// replays a user's unread set once per socket (`replayOnConnect`, 0.118) and
// asks the host's read gate before every delivery (`admit`). The producers are
// lib/social-notify.ts's `notify` (wired here as the sink), the socket-side
// plugins in lib/gateway/notify-plugins.ts, and the chat service's own
// page-thread unread items (`unread`, lib/page-thread-unread.ts).

import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { RedisPresenceStore } from '@connorhoehn/realtime-modules/presence';
import { attachRealtime, createBoundedRedis, type BoundedRedis, type RealtimeLeaseGroup, chat, presence, notifications, reactions, fileUploads, workGraph, baseChannel, LocalRealtimeRouter, RedisRealtimeRouter, withAuthorityCache, withPrincipalRevalidation, type AuthorityVerdictCache, type RealtimeHandle, type RedisRealtimeRouterOptions, type ChannelAuthorize, type ClientMessageFilter, type PrincipalRevalidation } from '@connorhoehn/realtime-modules/server';
import { RedisCallStateStore, InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { MeetingService } from '@connorhoehn/realtime-modules/meeting';
import { createOrgiqWorkGraphStream, isWorkGraphStreamPublisher } from './work-graph/stream.js';
import { tenantCursor } from './gateway-cursor.js';
import { CallPageRuntime, MemoryCallPageStore, RedisCallPageStore, observeCallPageLifecycle, setCallPageRuntime, isCallPageSnapshot } from './call-pages.js';
import { CallChatRuntime, huddleMembershipStore, setCallChatRuntime } from './call-chat.js';
import { CallMediaProofRuntime, setCallMediaProofRuntime } from './call-media-proof.js';
import { withHuddleChat } from './call-chat-send.js';
import { withDmPageReferences } from './dm-page-references.js';
import { withAssessmentPageReferences } from './assessment-page-references.js';
import { MemoryCallChatStateStore, RedisCallChatStateStore } from './call-chat-state.js';
import { createRedisStore, type GatewayRedisStore } from './redis-store.js';
import { createGatewayNotificationStore, releaseGatewayNotificationStore, seedMockNotifications } from './notification-store.js';
import { admitTenantNotification, setNotificationSink } from './social-notify.js';
import { createSocialChatBackend, setSocialChatBackend, setThreadLiveAppend, type SocialChatBackend } from './social-chat.js';
import { createReactionStore, gatewayUploadConfig, uploadFeatureOptions } from './gateway-attachments.js';
import { tenantActivity, tenantPipeline } from './gateway-run-feed.js';
import { directRecipientFilter } from './direct-recipient.js';
import { admitChannel, admitMeetingRoomSync, admitPrincipal, bindMeetingRooms, callGuards, channelGuards, lobbyGuard, verdictCacheable } from './gateway/authority.js';
import { applyChannel, authorityEpoch, bindAuthorityCache } from './gateway/authority-invalidation.js';
import { authenticateGatewayUpgrade } from './gateway/auth.js';
import { socketContext, tenantCalls } from './gateway/calls.js';
import { tenantMeeting } from './gateway/meeting.js';
import { channelNotifyPlugin, dmNotifyPlugin, pageCursorChatOptions, tenantMentionNotifyPlugin } from './gateway/notify-plugins.js';
import { startStatsLine, statsIntervalMs, type RealtimeGatewayStore } from './gateway/stats.js';
import { authorityCacheEnabled, authorityCacheMaxAgeMs, inboundRateLimit, peerOperationLingerMs, publishProofMaxAgeMs, realtimeGatewayRouting } from './gateway/env.js';
import { captureCallReaction, configuredCallReactionCapture, type CallReactionCapture } from './call-reactions.js';
import { recordOwnerSender } from './record-owner.js';

// Everything the pre-split file exported, from where it lives now.
export { lobbyGuard, channelGuard } from './gateway/authority.js';
export { authenticateGatewayUpgrade, gatewayAuthFromClaims, realtimeGatewayEnabled, type RealtimeGatewayAuth } from './gateway/auth.js';
export { notifyMissedCall } from './gateway/calls.js';
export { dmNotifyPlugin, channelNotifyPlugin, tenantMentionNotifyPlugin, pageCursorChatOptions, notifyChannelMessage, liveSubscribersForUsers } from './gateway/notify-plugins.js';
export { GATEWAY_STATS_TYPE, gatewayStatsLine, statsIntervalMs, type GatewayStatsInput, type RealtimeGatewayStore } from './gateway/stats.js';
export { peerOperationLingerMs, socialChatIndexWrites, publishProofMaxAgeMs, realtimeGatewayRouting, realtimeFanoutRequested, authorityCacheEnabled, inboundRateLimit } from './gateway/env.js';
export { createSocialChatBackend } from './social-chat.js';

export const REALTIME_GATEWAY_PATH = '/ws';

// The installed async-aware router awaits each decision, including recipient
// fanout. Captured token grants never substitute for current directory rights.
// `scope` (0.107) is one library operation; live-principal shares only its
// Social membership read across that operation's checks, never past it.
const authorizeChannel: ChannelAuthorize = async ({ kind, clientId, channel, ctx, scope }) => {
  const ok = await admitChannel({ kind, clientId, channel, ctx, ...(scope ? { scope } : {}) });
  if (!ok) {
    const who = ctx as Record<string, unknown> | null;
    console.warn(`[realtime-gateway] refused ${kind} on channel '${channel}' for user '${String(who?.['userId'] ?? '?')}' (org '${String(who?.['org'] ?? '?')}')`);
  }
  return ok;
};

// Principal revalidation (realtime-modules 0.116 `attachRealtime({ principal })`):
// the directory read (epoch, grants, masquerade actor) the library runs
//   - at upgrade, after the bearer auth (a stale principal is a 401);
//   - before and after the `calls()` and `notifications()` hooks;
//   - before delivering a USER-ADDRESSED frame (calls, notifications, call
//     pages, huddle chat) — `revalidatedRecipientFilter` below.
// It is deliberately NOT wrapped around the router's `authorize`: every
// subscribe, publish and per-recipient fan-out check there is `admitChannel`,
// which already loads the principal fresh before and after its own I/O, so
// the library's wrapper would double those directory reads on the hottest
// path. Channel frames therefore skip the filter's revalidation for the same
// reason; their recipient check is `authorize`.
const principal: PrincipalRevalidation = { revalidate: ctx => admitPrincipal(ctx), recheckAfterIo: true };
/** Revalidate once before a user-addressed frame (no recheck: the filter's own call/notification decisions reload). */
const recipientPrincipal: PrincipalRevalidation = { revalidate: principal.revalidate, recheckAfterIo: false };
/**
 * The verdict cache (realtime-modules 0.120, contract V1–V7), behind
 * REALTIME_AUTHORITY_CACHE. Composition, inside out: `authorizeChannel` (the
 * full fresh decision) → the cache, keyed by `authorityEpoch` (the signed
 * session epoch plus the invalidation seam's generations) → principal
 * revalidation, which runs on EVERY check, hits included (V4), and drops the
 * connection's verdicts when it refuses. A hit therefore costs one directory
 * read instead of the whole decision (Social action, membership, Cedar, page
 * resource, two reloads). Removals reach the cache through
 * lib/gateway/authority-invalidation.ts; refusals are never cached, so a
 * grant is admitted on the next frame. Names whose answer depends on another
 * name (`verdictCacheable`) bypass it.
 */
export type GatewayVerdicts = { authorize: ChannelAuthorize; cache: AuthorityVerdictCache };
export function gatewayVerdictCache(opts: { maxAgeMs?: number } = {}): GatewayVerdicts {
  const cached = withAuthorityCache(authorizeChannel, {
    epoch: ctx => authorityEpoch(ctx as Record<string, unknown>),
    maxAgeMs: opts.maxAgeMs ?? authorityCacheMaxAgeMs(),
  });
  const fenced = withPrincipalRevalidation({ authorize: cached.authorize }, recipientPrincipal,
    { onStale: clientId => cached.cache.invalidateConnection(clientId) }).authorize;
  return { authorize: args => verdictCacheable(args.channel) ? fenced(args) : authorizeChannel(args), cache: cached.cache };
}

const USER_ADDRESSED = new Set(['call', 'call-page', 'call-chat', 'notification:new', 'notification:bulk-update', 'notification:read']);
function revalidatedRecipientFilter(inner: ClientMessageFilter): ClientMessageFilter {
  const revalidated = withPrincipalRevalidation({ filterClientMessage: inner }, recipientPrincipal).filterClientMessage;
  return args => {
    const frame = args.message && typeof args.message === 'object' ? args.message as Record<string, unknown> : null;
    const huddle = frame?.type === 'chat' && typeof frame.channel === 'string' && (frame.channel === 'orgiq:huddle' || frame.channel.startsWith('orgiq:huddle:'));
    return frame && (USER_ADDRESSED.has(frame.type as string) || huddle) ? revalidated(args) : inner(args);
  };
}

let status: { gateway: 'on' | 'off'; store: RealtimeGatewayStore | null; chatStore?: 'memory' | 'dynamo' } = { gateway: 'off', store: null };
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

export interface AttachGatewayOptions {
  /** The platform recording activity store. Null deliberately disables capture. */
  callReactionCapture?: CallReactionCapture | null;
  /** Override REALTIME_STATS_INTERVAL_MS (tests). */
  statsIntervalMs?: number;
  /** Override REDIS_URL (tests). `null` forces memory. */
  redisUrl?: string | null;
  pingIntervalMs?: number;
  /** Override the chat backend (tests). Default: from SOCIAL_CHAT_* (socialChatConfig). */
  socialChat?: SocialChatBackend;
  /** Connected host-owned stores for the async cluster startup. */
  redisClient?: GatewayRedisStore;
  redisSubscriber?: Pick<BoundedRedis, 'subscribe'>;
  /** The host process owns the lease group and releases it at shutdown. */
  leaseGroup?: RealtimeLeaseGroup;
  routerFactory?: (hooks: RouterHooks) => RedisRealtimeRouter;
  /** Override REALTIME_AUTHORITY_CACHE (tests). */
  authorityCache?: boolean;
}

/** What the gateway hands its router: the authority hooks, and (for the Redis
 * router) the Social membership store whose committed writes travel to the
 * peers on `social:membership` and drop their verdicts on arrival. */
export type RouterHooks = Pick<RedisRealtimeRouterOptions, 'authorize' | 'filterClientMessage' | 'plugins' | 'publishProofMaxAgeMs'
  | 'membershipStore' | 'membershipEventTopic' | 'acceptMembershipChannel' | 'authorityCache'>;

export type GatewayHandle = RealtimeHandle & { store: RealtimeGatewayStore; redis: GatewayRedisStore | null };

/** Ready transport before the host starts accepting upgrades. The synchronous
 * attach function remains available to existing single-gateway callers. */
export async function startRealtimeGateway(server: Server, opts: AttachGatewayOptions = {}): Promise<GatewayHandle> {
  const routing = realtimeGatewayRouting();
  const redisUrl = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() : opts.redisUrl;
  if (routing === 'local' && (opts.redisClient || !redisUrl)) return attachRealtimeGateway(server, opts);
  if (!redisUrl) throw new Error('Redis peer routing requires REDIS_URL');
  const bound = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const transport = await createBoundedRedis(redisUrl, { timeoutMs: bound('REDIS_COMMAND_TIMEOUT_MS', 2000),
    onError: (role, error) => console.warn('[realtime-gateway] Redis connection error', role, error instanceof Error ? error.name : 'unknown') });
  const redis = createRedisStore(transport);
  let router: RedisRealtimeRouter | undefined;
  let handle: GatewayHandle | undefined;
  try {
    if (routing === 'local') return attachRealtimeGateway(server, { ...opts, redisClient: redis, redisSubscriber: transport });
    handle = attachRealtimeGateway(server, { ...opts, redisClient: redis, redisSubscriber: transport, routerFactory: hooks => {
      router = new RedisRealtimeRouter({ ...hooks, redis: transport, leaseGroup: opts.leaseGroup,
        namespace: process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway',
        nodeId: process.env['REALTIME_GATEWAY_NODE_ID'] || `${hostname()}:${process.pid}`,
        leaseMs: bound('REALTIME_GATEWAY_LEASE_MS', 30000),
        requestTimeoutMs: bound('REALTIME_GATEWAY_RECEIPT_TIMEOUT_MS', 3000),
        // realtime-modules 0.110 P6: a send's notify probe and its fan-out
        // reach a peer as one operation, so the peer's recipient checks
        // share one membership read (scopedMembers) instead of two.
        peerOperationLingerMs: peerOperationLingerMs() });
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
  if (realtimeGatewayRouting() === 'redis' && !opts.routerFactory) {
    throw new Error('Redis peer routing requires awaited startRealtimeGateway, not synchronous attachRealtimeGateway');
  }
  const redisUrl = opts.redisUrl === undefined ? (process.env['REDIS_URL'] ?? '').trim() || null : opts.redisUrl;
  if (redisUrl && !opts.redisClient) {
    throw new Error('Redis storage requires awaited startRealtimeGateway or a connected redisClient');
  }
  const redis = opts.redisClient ?? null;
  const store: RealtimeGatewayStore = redis ? 'redis' : 'memory';
  const baseStateStore = redis ? new RedisCallStateStore(redis) : new InMemoryCallStateStore();
  let pageRuntime: CallPageRuntime | null = null;
  let chatRuntime: CallChatRuntime | null = null;
  // The meeting feature's service, bound after attach (below), for the call-ended hook.
  let meetingService: MeetingService | null = null;
  const stateStore = observeCallPageLifecycle(baseStateStore, () => pageRuntime, () => chatRuntime);
  const inbox = createGatewayNotificationStore(redis);
  const chatBackend = opts.socialChat ?? createSocialChatBackend();
  const chatOpts = chatBackend.chatOptions();
  // The orgiq work graph's live stream (lib/work-graph/stream.ts).
  const workGraphStream = createOrgiqWorkGraphStream();
  // Bound after attach: the plugin and onConnect run only once sockets exist.
  let handleRef: RealtimeHandle | null = null;
  const router = () => handleRef?.router ?? null;
  const getCtx = (clientId: string) => socketContext(handleRef?.router, clientId);
  const getLobby = async (callId: string) => (await baseStateStore.getCall(callId))?.lobbyName ?? null;
  const reactionCapture = opts.callReactionCapture === undefined ? configuredCallReactionCapture() : opts.callReactionCapture;
  const onReaction = captureCallReaction({ calls: baseStateStore, context: getCtx, store: reactionCapture });
  // Since realtime-modules 0.98.6 the router is the single authorization
  // point: a refused presence/reactions/cursor subscribe reaches no service
  // state and every fan-out runs `authorize` first, answering
  // `AUTHZ_CHANNEL_DENIED`. Do NOT also wire `presence({ authorizeChannel })`:
  // that hook answers silently and hides the router's refusal frame.
  const verdicts = (opts.authorityCache ?? authorityCacheEnabled()) ? gatewayVerdictCache() : null;
  const routerHooks: RouterHooks = {
    authorize: verdicts?.authorize ?? authorizeChannel,
    // A committed Social membership write is published to the peers on this
    // topic; a peer invalidates its membership reads and (cache on) its
    // verdicts on that name and the names derived from it (applyChannel).
    membershipStore: chatBackend.membershipStore,
    membershipEventTopic: 'social:membership',
    acceptMembershipChannel: channel => channel.startsWith('social:') && channel.length <= 256,
    ...(verdicts ? { authorityCache: { invalidateChannel: (channel: string) => applyChannel(channel, 'membership') } } : {}),
    // realtime-modules 0.109 publish proofs: one sender-side publish decision
    // per (socket, channel) per send, reused for that send's other publish
    // rechecks while younger than this and dropped when the membership store
    // observes a write or peer hint (MirroredMembershipStore.scopedMembers).
    // Recipient checks are never shared. A peer skips only its redundant
    // publisher re-check for a frame whose origin proof is this fresh.
    publishProofMaxAgeMs: publishProofMaxAgeMs(),
    filterClientMessage: revalidatedRecipientFilter(directRecipientFilter(callGuards(getLobby), async ({ clientId, message }) => {
      try {
        const frame = message as Record<string, unknown>;
        if (frame.type === 'call-page') return isCallPageSnapshot(frame) ? await pageRuntime?.filterSnapshot(clientId, frame) ?? null : null;
        return await chatRuntime?.filterFrame(clientId, frame) ?? null;
      } catch { return null; }
    })),
    plugins: [
      dmNotifyPlugin(router),
      channelNotifyPlugin(router),
      tenantMentionNotifyPlugin(router),
      workGraphStream.plugin,
    ],
  };
  const clusterRouter = opts.routerFactory?.(routerHooks);
  // The local router is built here rather than by attachRealtime so its
  // `authorize` is not wrapped by the principal revalidation (see above).
  // It takes only the authority hooks; the membership wiring is the Redis router's.
  const { membershipStore: _members, membershipEventTopic: _topic, acceptMembershipChannel: _accept, authorityCache: _verdictHook, ...localHooks } = routerHooks;
  const socketRouter = clusterRouter ?? new LocalRealtimeRouter({ ...localHooks, logger });
  const inbound = inboundRateLimit();
  const handle = attachRealtime(server, {
    path: REALTIME_GATEWAY_PATH,
    // A valid signature is not a current session: `principal` refuses retired
    // roles, epochs and operator provenance after this returns, before the
    // socket is registered with a cluster owner.
    auth: async req => {
      const ctx = await authenticateGatewayUpgrade(req);
      if (clusterRouter && !clusterRouter.isReady()) throw new Error('Realtime gateway ownership is unavailable');
      return ctx;
    },
    principal,
    // This socket carries signalling and chat; canvas updates use /realtime.
    maxPayload: 256 * 1024,
    pingIntervalMs: opts.pingIntervalMs ?? 30_000,
    logger,
    // Per-socket inbound frame budget (REALTIME_INBOUND_RATE_LIMIT; the
    // measured rates are in lib/gateway/env.ts).
    ...(inbound ? { inboundRateLimit: inbound } : {}),
    // V7: a closed connection's verdicts go with it.
    ...(verdicts ? { onDisconnect: (clientId: string) => { verdicts.cache.invalidateConnection(clientId); } } : {}),
    // Chat + presence channels are tenant-scoped like call lobbies.
    router: socketRouter,
    features: [
      // Channel names up to 256 characters (the library default since 0.119;
      // tenant and team prefixes exceed 50). Huddle chat (`orgiq:huddle:<callId>`) is this same service: its
      // membership rows come from the call-chat mirror and its sends carry the
      // huddle contract (lib/call-chat-send.ts withHuddleChat).
      withHuddleChat(withAssessmentPageReferences(withDmPageReferences(chat({ ...chatOpts, chatStore: chatOpts.chatStore,
        membershipStore: huddleMembershipStore(chatOpts.membershipStore, () => chatRuntime),
        // The sender is the record owner: an identity clone chats as its
        // persona for shared records, but keeps its own identity in a DM
        // whose members explicitly name the clone; its socket epoch is its own.
        resolveSender: recordOwnerSender,
        // Page discussions keep a cursor per current reader, with no member
        // list, and the service makes their "new messages" items
        // (realtime-modules 0.115 / 0.118; lib/page-thread-unread.ts).
        ...pageCursorChatOptions(router) }))),
        () => chatRuntime),
      presence(clusterRouter && redis ? { store: new RedisPresenceStore({ command: (...args) => redis.command(...args) },
        process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway') } : {}),
      // Pointer positions on a page canvas (lib/gateway-cursor.ts): the router's
      // channel authority decides, the wrapper rebuilds the frame's content.
      tenantCursor(),
      tenantCalls({
        stateStore, getLobby, getCtx,
        ...(clusterRouter ? { crossNodePubSub: clusterRouter.crossNodePubSub } : {}),
        onCallEnded: summary => {
          void pageRuntime?.finish(summary.callId, summary.participantClientIds).catch(error => console.warn('[call-page] terminal cleanup failed', error));
          void chatRuntime?.finish(summary.callId, summary.participantClientIds).catch(error => console.warn('[call-chat] terminal cleanup failed', error));
          // A meeting is its call (decision 1): the next call in this lobby starts with no hands, rooms or announcements.
          void meetingService?.resetMeeting(summary.lobbyName).catch(error => console.warn('[meeting] terminal cleanup failed', error));
        },
      }),
      // Raised hands and breakout rooms (docs/meeting-rooms-app-goal.md B1).
      // Meeting state is shared through the gateway's Redis only when the
      // gateway routes as a cluster (decision 6), like presence; one task
      // keeps it in memory.
      tenantMeeting({ calls: baseStateStore, getCtx,
        ...(clusterRouter && redis ? { redis, namespace: process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway',
          ...(opts.redisSubscriber ? { subscriber: opts.redisSubscriber } : {}) } : {}) }),
      // Reactions follow chat's channel authority (the router's `authorize`
      // strips `reactions:`); targeted ones persist in Redis or memory.
      reactions({ store: createReactionStore(redis ? { command: (...args) => redis.command(...args) } : null,
        process.env['REALTIME_GATEWAY_NAMESPACE'] || 'orgiq-gateway'), maxChannelNameLength: 256, onReaction }),
      // Socket verbs for uploads; bytes ride /api/uploads (routes/index.ts).
      // Off in production unless a mounted volume is configured.
      ...(gatewayUploadConfig().enabled ? [fileUploads(uploadFeatureOptions(getCtx, channelGuards))] : []),
      // Library activity + pipeline features under the tenant channel families
      // (lib/gateway-run-feed.ts): server-produced, default-deny.
      tenantActivity(),
      tenantPipeline(),
      // The work graph's per-viewer stream: default deny (channelFor maps only
      // orgiq readers onto `orgiq:workgraph:<subject>`, which the router's
      // authorize judges); server-publish only; frames from the viewer's own
      // rebuilt snapshot (lib/work-graph/stream.ts).
      workGraph({ channelFor: workGraphStream.channelFor, source: workGraphStream.source }),
      // The library gates every notification action on `principal` (before and
      // after); the host only requires a live connection. Every delivery —
      // live, the once-per-socket replay, history — asks `admit`: an item
      // about a tenant discussion reaches only someone who reads it now.
      notifications({ store: inbox.store, authorize: async clientId => getCtx(clientId) !== null,
        replayOnConnect: true, admit: (userId, record) => admitTenantNotification(userId, record) }),
    ],
  });
  handleRef = handle;
  const workGraphService = handle.services['work-graph'];
  if (!isWorkGraphStreamPublisher(workGraphService)) throw new Error('work-graph feature did not register its stream service');
  const stopWorkGraph = workGraphStream.attach(workGraphService, clusterRouter?.peerEvents ?? null);
  // The room rules (lib/gateway/authority.ts) ask this service who sits in which room.
  const registeredMeeting = handle.services['meeting'];
  if (!(registeredMeeting instanceof MeetingService)) throw new Error('meeting feature did not register its service');
  meetingService = registeredMeeting;
  bindMeetingRooms({ service: registeredMeeting, lobbyOfCall: getLobby });
  // The invalidation seam drives this cache; with Redis routing its user,
  // channel and global events also reach the peers (`orgiq:authority`).
  const unbindAuthority = verdicts ? bindAuthorityCache(verdicts.cache, { peers: clusterRouter?.peerEvents ?? null }) : null;
  // A local committed membership write drops this node's verdicts on the name;
  // with Redis routing the router does that (and tells the peers) itself.
  const stopMembershipWrites = verdicts && !clusterRouter
    ? chatBackend.membershipStore.onCommittedWrite(channel => applyChannel(channel, 'membership')) : null;
  pageRuntime = new CallPageRuntime({ calls: baseStateStore, pages: redis ? new RedisCallPageStore(redis) : new MemoryCallPageStore(), router: handle.router, lobbyAllowed: lobbyGuard });
  setCallPageRuntime(pageRuntime);
  chatRuntime = new CallChatRuntime({ calls: baseStateStore, state: redis ? new RedisCallChatStateStore(redis) : new MemoryCallChatStateStore(),
    messages: chatBackend.chatStore, router: handle.router, lobbyAllowed: lobbyGuard, meetingRoom: admitMeetingRoomSync });
  setCallChatRuntime(chatRuntime);
  setCallMediaProofRuntime(new CallMediaProofRuntime({ calls: baseStateStore, router: handle.router, lobbyAllowed: lobbyGuard }));
  setNotificationSink(handle.services.notification ?? null);
  // The routes read the same backend; a mock reset drops the ChatService's
  // per-channel caches so the rebuilt fixture rows are what the next join reads.
  setSocialChatBackend(chatBackend, () => {
    handleRef?.services.chat?.channelCaches.clear();
  }, (channel) => {
    void Promise.resolve(handle.router.sendToChannel(channel, { type: 'chat:pins-changed', channel })).catch((error: unknown) => {
      console.warn('[social-pins] live refresh failed', error);
    });
  });
  // A server-side thread post (lib/social-chat.ts postThreadMessage — the REST
  // work-item comment) is already stored; `appendServerMessage` caches and
  // broadcasts it the way a system card goes out, which also makes its unread
  // items (the service's `noteMessagePosted`, the path a socket send takes).
  setThreadLiveAppend(async (message) => {
    await handle.services.chat?.appendServerMessage(message.channel, message);
  });
  if (inbox.memory) void seedMockNotifications().catch(() => undefined);
  status = { gateway: 'on', store, chatStore: chatBackend.kind };
  ready = clusterRouter ? () => clusterRouter.isReady() : null;
  const where = redis ? (redisUrl ? `redis (${redisUrl.replace(/\/\/[^@/]*@/, '//***@')})` : 'redis (provided connection)') : 'memory';
  console.log(`[realtime-gateway] serving ${REALTIME_GATEWAY_PATH} (chat, presence, cursor, calls, meeting, notifications, work-graph); call state + inbox: ${where}; chat store: ${chatBackend.kind}`);
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
    ...(verdicts ? { authorityCache: verdicts.cache } : {}),
    dispose: async () => {
      stopStats();
      // Keep feature runtimes/ports live until socket disconnect hooks finish.
      try { await baseDispose(); } finally {
        stopWorkGraph();
        bindMeetingRooms(null);
        registeredMeeting.dispose();
        meetingService = null;
        stopMembershipWrites?.();
        unbindAuthority?.();
        pageRuntime?.dispose();
        setCallPageRuntime(null);
        chatRuntime?.dispose();
        setCallChatRuntime(null);
        setCallMediaProofRuntime(null);
        setNotificationSink(null);
        setSocialChatBackend(null);
        setThreadLiveAppend(null);
        releaseGatewayNotificationStore();
        handleRef = null;
        await redis?.quit();
        status = { gateway: 'off', store: null };
        ready = null;
      }
    },
  });
}
