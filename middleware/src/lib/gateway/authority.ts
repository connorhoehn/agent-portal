// The ONE authority entry for the realtime gateway (docs/audit/2026-10-07-audit-plan.md
// D12, the gateway split — docs/realtime-validation/2026-10-08/gateway-split.md).
//
// The gateway is two things that used to share one file: the GATEWAY (socket
// admission, routing, fan-out, leases — lib/realtime-gateway.ts and the feature
// wiring under lib/gateway/) and AUTHORITY (who may do what on which name).
// This module is the whole of the second: every feature plugin, every REST route
// that asks a conversation's gateway authority, and the cookie /realtime path
// decide through the functions below, and none carries a rule of its own.
//
// Two layers, both here:
//   - the synchronous SHAPE guards `lobbyGuard` / `channelGuard` (the partition,
//     DM, team, Social-channel and family/service rules — a name is refused
//     before any I/O);
//   - the fresh-per-request decisions (`admit*`), which are lib/live-principal.ts's
//     directory-backed checks (epoch, grants, masquerade actor, Cedar policy,
//     Social membership, page resource, a second reload after the I/O) composed
//     over those guards. Nothing here caches a positive verdict.
//
// Verdict shapes are the ones the plugins and routes already expected: a
// boolean for subscribe/publish/call/upload/reader/notification decisions, the
// four-way `'ok' | 'not-a-lobby' | 'gone' | 'denied'` for a lobby read.
//
// Byte-for-byte: `lobbyGuard`, `admitName` and `channelGuard` are the functions
// lib/realtime-gateway.ts held until 2026-10-08, unchanged; the `admit*`
// functions are exactly `<live-principal primitive>(args, { guard, baseChannel })`
// with the guard pair every caller used to assemble by hand. The facade
// contract (lib/gateway/__tests__/authority-facade.test.ts) pins both.

import { baseChannel, type AuthorityScope } from '@connorhoehnslalom/realtime-modules/server';
import type { FileUploadRow } from '@connorhoehnslalom/realtime-modules/fileupload';
import { inCallChatNamespace } from '../call-chat.js';
import { inDistillationNamespace, isDistillationChannel, mayReadDistillation } from '../distillation-channels.js';
import { inFlowRunNamespace, parseFlowRunChannel } from '../flow-runs/channel.js';
import { inSocialDeckNamespace, parseSocialDeckChannel, socialDeckPresenceChannel } from '../social-deck-channel.js';
import { SOCIAL_CHANNEL_PREFIX, slugForChannel, socialChat } from '../social-chat.js';
import { isSocialTeamMember } from '../../providers/social-platform.js';
import { TENANT_PARTITIONS, channelAuthorityFor, tenantChannelFamily, type TenantChannelFamily } from '../tenant-channels.js';
import {
  authorizeCallLobbyRead, authorizeConversationChat, authorizeLiveGatewayCall, authorizeLiveGatewayCallRecipient,
  authorizeLiveGatewayChannel, getLivePrincipal, holdsChannelAuthority, huddleCallId, socialConversationReadable,
  type LiveCallGuards, type LiveChannelAuthorization, type LiveChannelGuards, type LiveGatewayAuth,
} from '../live-principal.js';
import { mayReadUpload } from '../gateway-attachments.js';
import { currentlyReadsTenantChannel } from '../social-notify.js';
import type { Session } from '../session.js';

// ── The synchronous shape guards ─────────────────────────────────────────────

/** `social:team:<team slug>:<channel>` — a team's chat channel (design §4.3). */
const TEAM_CHANNEL = /^social:team:([^:]+):[^:]+$/;

export type GuardAuth = { userId?: unknown; org?: unknown; tenants?: unknown; role?: unknown };

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
  // the exact name or reactions on it, for a token holding orgiq or assessment
  // (an assessment team page's huddle shares the namespace). Whether this
  // CONNECTION is a current seat of that call is asked fresh by
  // live-principal's authorizeHuddleChannel, every time (never a grant alone).
  if (inCallChatNamespace(bare)) {
    const callId = huddleCallId(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!callId && (channel === bare || channel === `reactions:${bare}`) && typeof auth.userId === 'string' && !!auth.userId
      && ['orgiq', 'assessment'].some(tenant => org === tenant || tenants.includes(tenant));
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
 * (`chat:social:dm:a:b` → `social:dm:a:b`). No library service, portal hook or
 * host producer names a channel with the wider `chat|typing|activity|pins` set
 * this gateway once stripped itself, so a name carrying one keeps its prefix
 * as its partition, which is never a tenant, and fails closed.
 *
 * @deprecated kept as an alias for existing importers; use `baseChannel`.
 */
export const stripServicePrefix: (channel: string) => string = baseChannel;

// ── The guard pairs the live-principal primitives take ───────────────────────

/** The one `{ guard, baseChannel }` pair for channel decisions (chat, presence,
 * reactions, cursor, uploads, pins, summaries, the work graph's readers). */
export const channelGuards: LiveChannelGuards = { guard: channelGuard, baseChannel };

/** The `{ guard, getLobby }` pair for call decisions; `getLobby` resolves a
 * stored call's lobby (legacy accepted/status frames name only a callId). */
export function callGuards(getLobby: LiveCallGuards['getLobby'], guard: LiveCallGuards['guard'] = lobbyGuard): LiveCallGuards {
  return { guard, getLobby };
}

/** A call question with no stored call behind it (POST /api/realtime/lobby-access). */
export const noStoredCall: LiveCallGuards['getLobby'] = async () => null;

// ── The fresh-per-request decisions ──────────────────────────────────────────

type Context = Record<string, unknown> | null;
export type ChannelKind = 'subscribe' | 'publish';
export type LobbyReadVerdict = Awaited<ReturnType<typeof authorizeCallLobbyRead>>;

/**
 * May this socket (or REST caller standing in for one, `clientId: 'http'` /
 * `'rest:*'`) subscribe to or publish on `channel` NOW — the router's
 * `authorize` hook, the uploads' `authz`, the pins/summarize read, all one rule:
 * the shape (`channelGuard`), then the freshly reloaded session, the family's
 * Cedar action, Social membership, the page resource, a second reload.
 */
export function admitChannel(args: LiveChannelAuthorization): Promise<boolean> {
  return authorizeLiveGatewayChannel(args, channelGuards);
}

/** `admitChannel` for a subscribe. */
export function admitSubscribe(ctx: Context, channel: string, opts: { clientId?: string; scope?: AuthorityScope } = {}): Promise<boolean> {
  return admitChannel({ kind: 'subscribe', clientId: opts.clientId ?? 'http', channel, ctx, ...(opts.scope ? { scope: opts.scope } : {}) });
}

/** `admitChannel` for a publish. */
export function admitPublish(ctx: Context, channel: string, opts: { clientId?: string; scope?: AuthorityScope } = {}): Promise<boolean> {
  return admitChannel({ kind: 'publish', clientId: opts.clientId ?? 'http', channel, ctx, ...(opts.scope ? { scope: opts.scope } : {}) });
}

/**
 * A pointer on a page canvas: the library's cursor service subscribes and
 * publishes as `cursor:<channel>`, and the family's READ authority admits an
 * ephemeral service (lib/tenant-channels.ts). Exactly the router's decision.
 */
export function admitCursor(ctx: Context, channel: string, kind: ChannelKind, opts: { clientId?: string; scope?: AuthorityScope } = {}): Promise<boolean> {
  const name = channel.startsWith('cursor:') ? channel : `cursor:${channel}`;
  return admitChannel({ kind, clientId: opts.clientId ?? 'http', channel: name, ctx, ...(opts.scope ? { scope: opts.scope } : {}) });
}

/**
 * A call frame (`invite`/`join`/`accepted`/…): the caller proves its own
 * identity on invite, the lobby's shape, the family's REST read, Social
 * StartCall + membership, the page resource, a second reload.
 */
export function admitCall(ctx: Context, action: string, payload: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return authorizeLiveGatewayCall(ctx, action, payload, guards);
}

/** A call frame about to be DELIVERED to this socket: the recipient's own fresh authority. */
export function admitCallRecipient(ctx: Context, data: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return authorizeLiveGatewayCallRecipient(ctx, data, guards);
}

/**
 * May this principal read a page lobby's call history NOW (`GET /api/calls`,
 * the plane's Active now): the family's read, the page existing now, the
 * partition rule. `'not-a-lobby'` is a name no tenant family lists as a lobby.
 */
export function admitLobbyRead(ctx: Context, lobby: string): Promise<LobbyReadVerdict> {
  return authorizeCallLobbyRead(ctx, lobby, lobbyGuard);
}

/**
 * May this principal read (`subscribe`) or post to (`publish`) a non-Social
 * conversation's chat history NOW — pins, `/summarize`, the work graph's own
 * flow runs. Huddles ask their seat; tenant families ask `admitChannel` plus
 * the chat service's explicit membership rows. Social names are refused here
 * (they keep `admitSocialConversation` / routes/chat-pins.ts chatAccess).
 */
export function admitConversationChat(args: { ctx: Context; channel: string; kind: ChannelKind; clientId: string; scope?: AuthorityScope }): Promise<boolean> {
  return authorizeConversationChat(args, channelGuards);
}

/**
 * May `userId` read Social conversation `conversation`'s chat NOW — the
 * `/api/chat/*` rule: the name's shape and membership (channel rows, DM ids,
 * team roster), then the chat service's explicit rows. The chat backend is
 * awaited first, so a cold Dynamo mirror never answers for the rows.
 */
export async function admitSocialConversation(userId: string, conversation: string, auth: LiveGatewayAuth): Promise<boolean> {
  await socialChat().ready;
  return socialConversationReadable(userId, conversation, channelGuard, auth);
}

/**
 * The stored-file read rule, one for the download, the Files list and the
 * conversation's shared work: the uploader, or someone who may subscribe to the
 * conversation now and whose history floor is older than the file.
 */
export function admitUploadRead(found: FileUploadRow, ctx: Record<string, unknown>): Promise<boolean> {
  return mayReadUpload(found, ctx, channelGuards);
}

/**
 * The distillation feed's rule, as the cookie /realtime path asks it: a plain
 * subscribe on one of the three channels by a current session standing in
 * orgiq (or an admin). A publish is never admitted. The /ws path reaches the
 * same verdict through `channelGuard`'s distillation branch under
 * `admitChannel`; the facade contract asserts the two agree.
 */
export async function admitDistillation(ctx: Context, channel: string, kind: ChannelKind): Promise<boolean> {
  if (kind === 'publish' || !isDistillationChannel(channel)) return false;
  try { return mayReadDistillation((await getLivePrincipal(ctx)).auth); } catch { return false; }
}

/** May a frame for this principal be DELIVERED on the distillation feed now (the /realtime filter). */
export async function admitDistillationDelivery(ctx: Context): Promise<boolean> {
  try { return mayReadDistillation((await getLivePrincipal(ctx)).auth); } catch { return false; }
}

/**
 * May `userId` read a tenant family's chat NOW, asked by id rather than by
 * socket (the user need not be connected): reader cursors, page-thread unread
 * items and mentions. The family's read over every role the directory grants,
 * the page resource, the explicit membership rows.
 */
export function admitReader(userId: string, channel: string, scope?: AuthorityScope): Promise<boolean> {
  return currentlyReadsTenantChannel(userId, channel, scope);
}

/**
 * Is this socket's principal still current (epoch, grants, actor) — the
 * notifications feature's admission, and the `forgotten` call receipt's.
 */
export async function admitPrincipal(ctx: Context): Promise<boolean> {
  try { await getLivePrincipal(ctx); return true; } catch { return false; }
}

/**
 * The producer side of the activity/pipeline features: a server-produced
 * frame leaves only onto a channel some family in the allowlist names
 * (lib/gateway-run-feed.ts). Default-deny on the way out as well as in.
 */
export function producerChannelAllowed(channel: string): boolean {
  return tenantChannelFamily(channel) !== null;
}

/**
 * A session's authority on one family name (read for `subscribe`, write for
 * `publish`), asked fresh against the session given — for a REST-side wrapper
 * that already holds a current session (lib/assessment-page-references.ts).
 */
export async function holdsFamilyAuthority(session: Session, channel: string, kind: ChannelKind): Promise<boolean> {
  const family = tenantChannelFamily(baseChannel(channel));
  const authority = family ? channelAuthorityFor(family, channel, kind) : null;
  return !!authority && holdsChannelAuthority(session, authority);
}
