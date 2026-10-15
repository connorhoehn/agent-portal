// The OrgIQ middleware as its own realtime gateway (docs/social-calls-plan.md
// step 7, deploy-plan risk #2 — the gateway half): COMPOSITION ONLY.
//
//   ws(s)://<middleware>/ws     Sec-WebSocket-Protocol: bearer-token-v1, <jwt>
//   features: chat, presence, cursor, calls, reactions, uploads, activity,
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
//   lib/gateway/notify-plugins.ts  DM / channel / mention / page-unread producers
//   lib/gateway/stats.ts           the load line
//   lib/gateway/env.ts             the tuning knobs
//   lib/gateway-cursor.ts, gateway-run-feed.ts, gateway-attachments.ts,
//   gateway-redis.ts               cursor, activity/pipeline, reactions/uploads,
//                                  the leased Redis ports (unchanged)
//   lib/social-chat.ts             both chat store factories (memory, Dynamo)
// Every name this file exported before the split is re-exported below, so no
// importer moved.
//
// Enabled by REALTIME_GATEWAY=on|off. Default: on outside production, off in
// production unless set, so the ECS task is unchanged until someone asks.
//
// Call state lives in Redis when REDIS_URL is set (realtime-modules'
// RedisCallStateStore over lib/redis-lite.ts), in memory otherwise. The
// default routing is LocalRealtimeRouter. REALTIME_GATEWAY_ROUTER=redis opts
// into the upstream leased peer router through startRealtimeGateway; its
// connection/state ports are ready before the HTTP server listens. Keep the
// one-task cloud safeguard until full application/service-state contracts pass.
// REALTIME_FANOUT=redis is a compatibility alias for this same native path,
// never for the retired application DistributedRealtimeRouter implementation.
//
// Notifications (docs/social-tenant-design.md §3.3–§3.4): the library's
// user-addressed inbox, persisted by lib/notification-store.ts. The library
// does not replay a user's unread set by itself — `onConnect` below does, once
// per socket. The producers are lib/social-notify.ts's `notify` (wired here as
// the sink) plus the socket-side plugins in lib/gateway/notify-plugins.ts.

import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { RedisPresenceStore } from '@connorhoehnslalom/realtime-modules/presence';
import { attachRealtime, chat, presence, notifications, reactions, fileUploads, workGraph, baseChannel, LocalRealtimeRouter, RedisRealtimeRouter, withPrincipalRevalidation, type RealtimeHandle, type RedisRealtimeRouterOptions, type ChannelAuthorize, type ClientMessageFilter, type PrincipalRevalidation } from '@connorhoehnslalom/realtime-modules/server';
import { RedisCallStateStore, InMemoryCallStateStore, type CallStateRedis } from '@connorhoehnslalom/realtime-modules/call';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { createOrgiqWorkGraphStream, type WorkGraphStreamPublisher } from './work-graph/stream.js';
import { tenantCursor } from './gateway-cursor.js';
import { CallPageRuntime, MemoryCallPageStore, RedisCallPageStore, observeCallPageLifecycle, setCallPageRuntime, type CallPageSnapshot } from './call-pages.js';
import { CallChatRuntime, huddleMembershipStore, setCallChatRuntime } from './call-chat.js';
import { CallMediaProofRuntime, setCallMediaProofRuntime } from './call-media-proof.js';
import { withHuddleChat } from './call-chat-send.js';
import { withDmPageReferences } from './dm-page-references.js';
import { withAssessmentPageReferences } from './assessment-page-references.js';
import { MemoryCallChatStateStore, RedisCallChatStateStore } from './call-chat-state.js';
import { RedisLite, type GatewayRedisStore } from './redis-lite.js';
import { GatewayRedis } from './gateway-redis.js';
import type { LeasedOwner } from './realtime-node-ownership.js';
import { createGatewayNotificationStore, releaseGatewayNotificationStore, seedMockNotifications } from './notification-store.js';
import { setNotificationSink, type NotificationSink } from './social-notify.js';
import { notifyPageThreadMessage, setDiscussionInbox, type DiscussionInbox } from './page-thread-unread.js';
import { createSocialChatBackend, setSocialChatBackend, setThreadLiveAppend, socialChat, type SocialChatBackend } from './social-chat.js';
import { setDistillationGatewayTarget } from './distillation-channels.js';
import { createReactionStore, gatewayUploadConfig, uploadFeatureOptions } from './gateway-attachments.js';
import { tenantActivity, tenantPipeline } from './gateway-run-feed.js';
import { directRecipientFilter } from './direct-recipient.js';
import { pageCursorFamily } from './tenant-channels.js';
import { admitChannel, admitPrincipal, callGuards, channelGuards, lobbyGuard } from './gateway/authority.js';
import { authenticateGatewayUpgrade } from './gateway/auth.js';
import { socketContext, tenantCalls } from './gateway/calls.js';
import { channelNotifyPlugin, dmNotifyPlugin, liveSubscribersForUsers, pageCursorChatOptions, pageUnreadNotifyPlugin, tenantMentionNotifyPlugin, type DmRouter, type PageReadReceiptHook } from './gateway/notify-plugins.js';
import { startStatsLine, statsIntervalMs, type RealtimeGatewayStore } from './gateway/stats.js';
import { peerOperationLingerMs, publishProofMaxAgeMs, realtimeGatewayRouting } from './gateway/env.js';
import { captureCallReaction, configuredCallReactionCapture, type CallReactionCapture } from './call-reactions.js';

// Everything the pre-split file exported, from where it lives now.
export { lobbyGuard, channelGuard } from './gateway/authority.js';
export { authenticateGatewayUpgrade, gatewayAuthFromClaims, realtimeGatewayEnabled, type RealtimeGatewayAuth } from './gateway/auth.js';
export { notifyMissedCall } from './gateway/calls.js';
export { dmNotifyPlugin, channelNotifyPlugin, tenantMentionNotifyPlugin, pageUnreadNotifyPlugin, pageCursorChatOptions, notifyChannelMessage, liveSubscribers, liveSubscribersForUsers } from './gateway/notify-plugins.js';
export { GATEWAY_STATS_TYPE, gatewayStatsLine, activeCallCount, statsIntervalMs, type GatewayStatsInput, type RealtimeGatewayStore } from './gateway/stats.js';
export { peerOperationLingerMs, socialChatIndexWrites, publishProofMaxAgeMs, realtimeGatewayRouting, realtimeFanoutRequested } from './gateway/env.js';
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
const USER_ADDRESSED = new Set(['call', 'call-page', 'call-chat', 'notification:new', 'notification:bulk-update', 'notification:read']);
function revalidatedRecipientFilter(inner: ClientMessageFilter): ClientMessageFilter {
  const revalidated = withPrincipalRevalidation({ filterClientMessage: inner }, recipientPrincipal).filterClientMessage;
  return args => {
    const frame = args.message && typeof args.message === 'object' ? args.message as Record<string, unknown> : null;
    const huddle = frame?.type === 'chat' && typeof frame.channel === 'string' && (frame.channel === 'orgiq:huddle' || frame.channel.startsWith('orgiq:huddle:'));
    return frame && (USER_ADDRESSED.has(frame.type as string) || huddle) ? revalidated(args) : inner(args);
  };
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
  routerFactory?: (hooks: Pick<RedisRealtimeRouterOptions, 'authorize' | 'filterClientMessage' | 'plugins' | 'publishProofMaxAgeMs'>) => RedisRealtimeRouter;
}

export type GatewayHandle = RealtimeHandle & { store: RealtimeGatewayStore; redis: GatewayRedisStore | null };

/** Ready transport before the host starts accepting upgrades. The synchronous
 * attach function remains available to existing single-gateway callers. */
export async function startRealtimeGateway(server: Server, opts: AttachGatewayOptions = {}): Promise<GatewayHandle & { ownership?: LeasedOwner }> {
  const routing = realtimeGatewayRouting();
  if (routing === 'local') return attachRealtimeGateway(server, opts);
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
        requestTimeoutMs: bound('REALTIME_GATEWAY_RECEIPT_TIMEOUT_MS', 3000),
        // realtime-modules 0.110 P6: a send's notify probe and its fan-out
        // reach a peer as one operation, so the peer's recipient checks
        // share one membership read (scopedMembers) instead of two.
        peerOperationLingerMs: peerOperationLingerMs() });
      return router;
    } });
    await router!.start();
    console.log('[realtime-gateway] Redis peer routing ready', { nodeId: router!.nodeId });
    return Object.assign(handle, { ownership: router! as LeasedOwner });
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
  const router = () => (handleRef?.router as unknown as DmRouter | undefined) ?? null;
  const getCtx = (clientId: string) => socketContext(handleRef?.router, clientId);
  const getLobby = async (callId: string) => (await baseStateStore.getCall(callId))?.lobbyName ?? null;
  const reactionCapture = opts.callReactionCapture === undefined ? configuredCallReactionCapture() : opts.callReactionCapture;
  const onReaction = captureCallReaction({ calls: baseStateStore, context: getCtx, store: reactionCapture });
  const notificationService = (): (NotificationSink & { replayUnreadForUser(clientId: string, userId: string): Promise<void> }) | null =>
    (handleRef?.services['notification'] as unknown as (NotificationSink & { replayUnreadForUser(clientId: string, userId: string): Promise<void> }) | undefined) ?? null;
  // Since realtime-modules 0.98.6 the router is the single authorization
  // point: a refused presence/reactions/cursor subscribe reaches no service
  // state and every fan-out runs `authorize` first, answering
  // `AUTHZ_CHANNEL_DENIED`. Do NOT also wire `presence({ authorizeChannel })`:
  // that hook answers silently and hides the router's refusal frame.
  const routerHooks: Pick<RedisRealtimeRouterOptions, 'authorize' | 'filterClientMessage' | 'plugins' | 'publishProofMaxAgeMs'> = {
    authorize: authorizeChannel,
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
        return frame.type === 'call-page'
          ? await pageRuntime?.filterSnapshot(clientId, frame as unknown as CallPageSnapshot) ?? null
          : await chatRuntime?.filterFrame(clientId, frame) ?? null;
      } catch { return null; }
    })),
    plugins: [
      dmNotifyPlugin(router),
      channelNotifyPlugin(router),
      tenantMentionNotifyPlugin(router),
      pageUnreadNotifyPlugin(router),
      workGraphStream.plugin,
    ],
  };
  const clusterRouter = opts.routerFactory?.(routerHooks);
  // The local router is built here rather than by attachRealtime so its
  // `authorize` is not wrapped by the principal revalidation (see above).
  const socketRouter = clusterRouter ?? new LocalRealtimeRouter({ ...routerHooks, logger });
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
    // Chat + presence channels are tenant-scoped like call lobbies.
    router: socketRouter,
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
      withHuddleChat(withAssessmentPageReferences(withDmPageReferences(chat({ ...chatOpts, chatStore: chatOpts.chatStore, maxChannelNameLength: 256,
        membershipStore: huddleMembershipStore(chatOpts.membershipStore, () => chatRuntime),
        // Page discussions keep a cursor per current reader, with no member
        // list (realtime-modules 0.115; lib/page-thread-unread.ts).
        ...pageCursorChatOptions(chatOpts.onReadReceipt as PageReadReceiptHook | undefined) }))),
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
        },
      }),
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
      // after); the host only requires a live connection.
      notifications({ store: inbox.store, authorize: async clientId => getCtx(clientId) !== null }),
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
  setCallMediaProofRuntime(new CallMediaProofRuntime({ calls: baseStateStore, router: handle.router, lobbyAllowed: lobbyGuard }));
  setNotificationSink(notificationService());
  setDiscussionInbox(handle.services['notification'] as unknown as DiscussionInbox);
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
  // A server-side thread post (lib/social-chat.ts postThreadMessage — the REST
  // work-item comment) is already stored; the ChatService's cache and the
  // channel's live readers hear of it the way they hear of a system card.
  setThreadLiveAppend(async (message) => {
    const chatService = handle.services['chat'] as unknown as { addToChannelHistory?(c: string, m: ChatMessage): void; broadcastMessage?(c: string, m: ChatMessage): Promise<void> } | undefined;
    chatService?.addToChannelHistory?.(message.channel, message);
    await chatService?.broadcastMessage?.(message.channel, message);
    // The page-unread item a socket send would have produced (pageUnreadNotifyPlugin).
    if (!pageCursorFamily(message.channel) || !message.userId) return;
    const others = (await socialChat().readReceiptStore.listReceipts(message.channel).catch(() => [])).map(c => c.userId).filter(u => u !== message.userId);
    if (!others.length) return;
    const live = await liveSubscribersForUsers(handle.router as unknown as DmRouter, message.channel, others);
    const senderName = typeof message.metadata?.['displayName'] === 'string' ? message.metadata['displayName'] : undefined;
    await notifyPageThreadMessage({ channel: message.channel, sender: message.userId, ...(senderName ? { senderName } : {}),
      message: { id: message.id, timestamp: message.timestamp }, text: message.message, live });
  });
  if (inbox.memory) void seedMockNotifications().catch(() => undefined);
  status = { gateway: 'on', store };
  ready = clusterRouter ? () => clusterRouter.isReady() : null;
  const where = redis ? (redisUrl ? `redis (${redisUrl.replace(/\/\/[^@/]*@/, '//***@')})` : 'redis (provided connection)') : 'memory';
  console.log(`[realtime-gateway] serving ${REALTIME_GATEWAY_PATH} (chat, presence, cursor, calls, notifications, work-graph); call state + inbox: ${where}; chat store: ${chatBackend.kind}`);
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
        setCallMediaProofRuntime(null);
        setNotificationSink(null);
        setDiscussionInbox(null);
        setDistillationGatewayTarget(null);
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
