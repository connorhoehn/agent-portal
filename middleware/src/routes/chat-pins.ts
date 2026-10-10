// The REST half of realtime-modules' usePins. Pin state uses its own library
// store; access follows the same grant and membership rules as the socket.
//
// Two kinds of conversation carry pins:
//   - Social (`social:ch|team|dm:*`): `chatAccess` — current Social grants
//     (ViewSocial to read, PostMessage to pin/unpin) plus channel/DM/team
//     membership;
//   - a tenant discussion (`orgiq:initiative|work:<id>`, `pipelines:run|def:<id>`,
//     `assessment:doc:<id>`, `assessment:team:<TEAM-id>`) or a huddle (`orgiq:huddle:<callId>`): `tenantPinAccess` — exactly the authority the
//     gateway applies to that conversation's chat, asked fresh on every request
//     (live-principal.ts `authorizeConversationChat`: the family's active
//     tenant + Cedar action, the chat service's membership rows, and a
//     directory reload after that I/O). Reading pins asks the family's read
//     authority; pin/unpin ask its content-publish authority
//     (lib/tenant-channels.ts: DispatchAgentRun for orgiq, ViewPipelines,
//     ViewAssessment). Every write re-asks after its own I/O, so a revocation
//     during the message/author lookup stores nothing.
// Either way the server derives excerpt, author and time from the stored
// original, honours the member's history floor and hides deleted originals;
// body fields beyond channel/messageId (text, author, pinnedBy, tenant, actor)
// are never trusted.
import { Router, type Request } from 'express';
import { PIN_PREVIEW_MAX, type ChatMessage, type PinnedMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { isAllowed } from '../lib/authz.js';
import { admitConversationChat, admitSocialConversation } from '../lib/gateway/authority.js';
import { getLivePrincipal, huddleCallId, sessionGatewayContext, summarizableFamily, type LiveGatewayAuth } from '../lib/live-principal.js';
import { callChatRuntime } from '../lib/call-chat.js';
import { realtimeSigningSecret, verifyRealtimeToken } from '../lib/realtime-token.js';
import { dmChannelFor, dmMembers, notifySocialPinsChanged, socialChat } from '../lib/social-chat.js';
import { transcriptLines, type TranscriptLine } from '../lib/conversation-summarize.js';
import { getUser } from '../providers/identity.js';

export const chatPinsRouter = Router();

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new ValidationError(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

/**
 * Who is calling, and may they do `action` in Social at all (grants + policy,
 * NOT conversation membership). Callers that need a membership must use
 * chatAccess; a deck's owner is read through this.
 */
export async function socialSubject(req: Request, action: 'ViewSocial' | 'PostMessage'): Promise<string> {
  let sub: string;
  const authorization = req.get('authorization');
  if (authorization !== undefined) {
    const secret = realtimeSigningSecret();
    if (!secret) throw new AppError(503, 'Realtime token verification is unavailable');
    const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
    if (!token) throw new AppError(401, 'A realtime bearer token is required');
    try {
      const claims = await verifyRealtimeToken(token, secret);
      if (claims.org !== 'social' && !claims.tenants?.includes('social')) throw new Error('no social grant');
      sub = claims.sub;
    } catch { throw new AppError(401, 'The realtime token is invalid or expired'); }
  } else {
    // No anonymous demo fallback: its grants deliberately exclude Social.
    if (!req.session) throw new AppError(401, 'Unauthenticated');
    sub = req.session.sub;
  }
  let user;
  try { user = await getUser(sub, { authoritative: true }); }
  catch { throw new AppError(503, 'The identity store is unavailable'); }
  const needed = action;
  let allowed = false;
  for (const role of user?.grants.social ?? []) {
    if (await isAllowed({ sub, role, tenant: 'social' }, needed)) { allowed = true; break; }
  }
  if (!allowed) throw new AppError(403, 'Forbidden');
  return sub;
}

/**
 * The one conversation-read gate for /api/chat. `action` defaults to the
 * route's method (GET reads, anything else posts); a caller that only reads
 * through a POST (the /summarize command) names ViewSocial itself.
 */
export async function chatAccess(req: Request, channel: string, action?: 'ViewSocial' | 'PostMessage'): Promise<string> {
  if (!/^social:(?:ch:[a-z0-9][a-z0-9-]{0,39}|team:[^:]+:[^:]+|dm:[^:]+(?::[^:]+)+)$/.test(channel)) {
    throw new ValidationError('channel must name a social channel, team channel or direct message');
  }
  const members = dmMembers(channel);
  if (members && (new Set(members).size < 2 || dmChannelFor(members) !== channel)) {
    throw new ValidationError('direct message channel must use sorted, distinct member ids');
  }
  const needed: 'ViewSocial' | 'PostMessage' = action ?? (req.method === 'GET' ? 'ViewSocial' : 'PostMessage');
  const sub = await socialSubject(req, needed);
  // The name's shape and membership (channel rows, DM ids, team roster), then
  // the chat service's explicit conversation rows, which can close a team
  // channel or tenant-prefixed DM the name alone would admit (lib/gateway/authority.ts).
  if (!await admitSocialConversation(sub, channel, { userId: sub, org: 'social', tenants: ['social'] } as LiveGatewayAuth)) {
    throw new AppError(403, 'Not a member of this conversation');
  }
  return sub;
}

/** The tenant discussion families that carry shared pins (see the header). */
export const TENANT_PIN_FAMILIES: ReadonlySet<string> = new Set(['orgiq:initiative', 'orgiq:work', 'pipelines:run', 'pipelines:def', 'assessment:doc', 'assessment:team']);

export function tenantPinChannel(channel: string): boolean {
  // A huddle (`orgiq:huddle:<callId>`): its participant authority (an actual
  // seat, an active history floor, the huddle's Social grant; PostMessage to pin).
  if (huddleCallId(channel)) return true;
  const family = summarizableFamily(channel);
  return !!family && TENANT_PIN_FAMILIES.has(family.id);
}

/** The gateway context for this request: the realtime bearer's claims, else the cookie session. */
async function requestContext(req: Request): Promise<Record<string, unknown>> {
  const authorization = req.get('authorization');
  if (authorization !== undefined) {
    const secret = realtimeSigningSecret();
    if (!secret) throw new AppError(503, 'Realtime token verification is unavailable');
    const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
    if (!token) throw new AppError(401, 'A realtime bearer token is required');
    let claims;
    try { claims = await verifyRealtimeToken(token, secret); }
    catch { throw new AppError(401, 'The realtime token is invalid or expired'); }
    // The same context the gateway's upgrade builds from this token.
    return {
      userId: claims.sub, displayName: claims.displayName || claims.sub, org: claims.org,
      tenants: Array.isArray(claims.tenants) ? claims.tenants.filter((t): t is string => typeof t === 'string') : [],
      role: typeof claims.role === 'string' ? claims.role : '', epoch: claims.epoch ?? 0,
      sessionIat: Number((claims as unknown as { iat?: number }).iat) || 0,
      ...(claims.act ? { act: { sub: claims.act.sub, epoch: claims.act.epoch ?? 0 } } : {}),
    };
  }
  if (!req.session) throw new AppError(401, 'Unauthenticated');
  return sessionGatewayContext(req.session);
}

/**
 * May this caller read (`subscribe`) or pin/unpin (`publish`) on a tenant
 * discussion now. Asked fresh per call; returns the authenticated user id.
 */
export async function tenantPinAccess(req: Request, channel: string, kind: 'subscribe' | 'publish'): Promise<string> {
  const ctx = await requestContext(req);
  const ok = await admitConversationChat({ ctx, channel, kind, clientId: 'rest:pins' });
  if (!ok) throw new AppError(403, kind === 'publish' ? 'You cannot pin in this conversation' : 'You cannot read this conversation');
  return ctx['userId'] as string;
}

/** One gate for every pin route: Social keeps chatAccess; a tenant discussion asks its family. Returns the caller and a `recheck()` for after the lookups. */
async function pinAccess(req: Request, channel: string, kind: 'subscribe' | 'publish'): Promise<{ userId: string; recheck: () => Promise<void> }> {
  if (channel.startsWith('social:')) return { userId: await chatAccess(req, channel), recheck: async () => undefined };
  if (tenantPinChannel(channel)) {
    // The session itself first, so a stale one answers as what it is. The live
    // gate reads the directory fresh and refuses a cookie whose epoch another
    // sign-in or tenant switch has bumped — but `authorizeConversationChat`
    // folds every failure into `false`, so that 401 (or a 503 directory outage)
    // used to reach the reader as "You cannot read this conversation" (403),
    // while the BFF's own REST reads still admitted the cookie for up to
    // GRANTS_REFRESH_S (2026-10-07: an admin's Pinned banner on orgiq:work).
    // Only here, before the first decision: a revocation DURING the request
    // (the recheck below) stays a refusal.
    await getLivePrincipal(await requestContext(req));
    const userId = await tenantPinAccess(req, channel, kind);
    // Asked again after the message/author lookups, which can outlive a
    // revocation: nothing is returned or stored unless the same caller still
    // holds the authority. Social re-checks nothing here (chatAccess is the gate).
    return { userId, recheck: async () => { if (await tenantPinAccess(req, channel, kind) !== userId) throw new AppError(403, 'Forbidden'); } };
  }
  throw new ValidationError('channel must name a social conversation or a tenant discussion');
}

/** Match ChatService's strictly-after membership history rule. */
export async function historyFloor(channel: string, userId: string): Promise<number | null> {
  const callId = huddleCallId(channel);
  if (callId) return callChatRuntime().memberFloor(callId, userId);
  const member = await socialChat().membershipStore.getMember(channel, userId);
  const floor = member?.historyFrom ? Date.parse(member.historyFrom) : NaN;
  return Number.isFinite(floor) ? floor : null;
}

/** The one visibility rule: not deleted, and strictly after the member's history floor. */
export function messageVisible(message: ChatMessage, floor: number | null): boolean {
  if (message.deletedAt || message.metadata?.['deleted'] === true) return false;
  if (floor !== null) {
    const sent = Date.parse(message.timestamp);
    if (!Number.isFinite(sent) || sent <= floor) return false;
  }
  return true;
}

export async function visibleMessage(channel: string, messageId: string, floor: number | null): Promise<ChatMessage | null> {
  const store = socialChat().chatStore;
  if (!store.getMessage) throw new AppError(503, 'Message lookup is unavailable');
  const message = await store.getMessage(channel, messageId);
  return message && messageVisible(message, floor) ? message : null;
}

export async function messageAuthor(message: ChatMessage): Promise<string> {
  if (message.userId) {
    // Authenticated authors never take their display name from the pin body
    // or client-controlled message metadata. A deleted identity keeps its id.
    try { return (await getUser(message.userId, { authoritative: true }))?.displayName || message.userId; }
    catch { throw new AppError(503, 'The identity store is unavailable'); }
  }
  const legacyName = message.metadata?.['displayName'];
  return typeof legacyName === 'string' && legacyName.trim() ? legacyName : 'Unknown';
}

/**
 * What `userId` may read of one stored chat channel now: their history floor,
 * deletions and the range, with each author resolved once. Callers must have
 * already passed the channel's own read authority.
 */
export async function readChatLines(channel: string, userId: string, sinceMs: number | null): Promise<TranscriptLine[]> {
  const floor = await historyFloor(channel, userId);
  const visible = (await socialChat().chatStore.listMessages(channel, 500)).filter(m => messageVisible(m, floor));
  const names = new Map<string, string>();
  const withAuthors = [];
  for (const message of visible) {
    const key = message.userId ?? '';
    if (!names.has(key)) names.set(key, await messageAuthor(message));
    withAuthors.push({ message, author: names.get(key)! });
  }
  return transcriptLines(withAuthors, sinceMs);
}

function messagePreview(message: ChatMessage): string {
  const flat = message.message.replace(/\s+/g, ' ').trim();
  return flat.length > PIN_PREVIEW_MAX ? `${flat.slice(0, PIN_PREVIEW_MAX - 1)}…` : flat;
}

// A pin may point beyond the recent history window. Resolve that one original
// with the same membership, history and retention checks as the pin itself.
chatPinsRouter.get('/message', asyncHandler(async (req, res) => {
  const channel = text(req.query['channel'], 'channel', 240);
  const messageId = text(req.query['messageId'], 'messageId', 256);
  const { userId, recheck } = await pinAccess(req, channel, 'subscribe');
  const found = await visibleMessage(channel, messageId, await historyFloor(channel, userId));
  if (!found) throw new NotFoundError('No available message with that id');
  // A huddle original carries its page reference resolved now, like its live frames.
  const callId = huddleCallId(channel);
  const message = callId ? await callChatRuntime().render(callId, found) : found;
  await recheck();
  res.json({ message });
}));

chatPinsRouter.get('/pins', asyncHandler(async (req, res) => {
  const channel = text(req.query['channel'], 'channel', 240);
  const { userId, recheck } = await pinAccess(req, channel, 'subscribe');
  const floor = await historyFloor(channel, userId);
  const visible: PinnedMessage[] = [];
  for (const pin of await socialChat().pinsStore.list(channel)) {
    const message = await visibleMessage(channel, pin.messageId, floor);
    if (!message) continue;
    // Pins refer to current server messages; edits/deletes and retention must
    // not leave a second, untrusted copy of their content in the Pinned view.
    visible.push({ ...pin, preview: messagePreview(message), author: await messageAuthor(message), sentAt: message.timestamp });
  }
  await recheck();
  res.json({ channel, pins: visible });
}));

chatPinsRouter.post('/pins', asyncHandler(async (req, res) => {
  const channel = text(req.body?.channel, 'channel', 240);
  const messageId = text(req.body?.messageId, 'messageId', 256);
  const { userId: pinnedBy, recheck } = await pinAccess(req, channel, 'publish');
  const message = await visibleMessage(channel, messageId, await historyFloor(channel, pinnedBy));
  if (!message) throw new NotFoundError('No available message with that id');
  const author = await messageAuthor(message);
  // A tenant discussion stores nothing unless the same caller still holds its publish authority.
  await recheck();
  // The installed client still sends text/author/sentAt for compatibility;
  // only the stored message can supply the shared pin's content and identity.
  const pin = await socialChat().pinsStore.pin({ channelId: channel, messageId, pinnedBy,
    text: message.message, author, sentAt: message.timestamp });
  notifySocialPinsChanged(channel);
  res.json({ pin });
}));

chatPinsRouter.delete('/pins', asyncHandler(async (req, res) => {
  const channel = text(req.body?.channel, 'channel', 240);
  const messageId = text(req.body?.messageId, 'messageId', 256);
  await pinAccess(req, channel, 'publish');
  await socialChat().pinsStore.unpin(channel, messageId);
  notifySocialPinsChanged(channel);
  res.json({ ok: true });
}));
