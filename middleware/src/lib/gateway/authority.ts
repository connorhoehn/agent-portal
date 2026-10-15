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
// Since realtime-modules 0.116 the MECHANISM is the library's authority kit and
// this file holds only this host's DATA and business rules:
//   - `defineChannelFamilies` over lib/tenant-channels.ts's family table, with
//     the host namespaces (huddle chat, the distillation feed, flow runs, Social
//     decks) and name rules (team rosters, the Social channel membership mirror)
//     — the synchronous SHAPE guards `lobbyGuard` / `channelGuard`;
//   - `createChannelAuthority` — the fresh-per-request decisions (`admit*`):
//     the principal reloaded from the directory (lib/live-principal.ts
//     `getLivePrincipal`: epoch, grants, masquerade actor), host steps (a Social
//     action + membership proof), the family's Cedar action and page resource,
//     and a second reload after that I/O. Nothing here caches a positive verdict.
//
// The host copies the engine replaced (the hand-written shape guards and
// live-principal.ts's channel / call / lobby-read primitives) ran one release
// behind it under a dev parity assertion and were deleted at the 0.119 pin
// move after a clean run (jest at 100%, the dev BFF at 5%, a live clone check).
//
// Verdict shapes are the ones the plugins and routes already expected: a
// boolean for subscribe/publish/call/upload/reader/notification decisions, the
// four-way `'ok' | 'not-a-lobby' | 'gone' | 'denied'` for a lobby read. The
// facade contract (lib/gateway/__tests__/authority-facade.test.ts) pins both.

import {
  baseChannel, createChannelAuthority, defineChannelFamilies,
  type AuthorityScope, type CallStep, type ChannelStep, type GuardAuth as LibraryGuardAuth, type LobbyVerdict,
} from '@connorhoehnslalom/realtime-modules/server';
import type { FileUploadRow } from '@connorhoehnslalom/realtime-modules/fileupload';
import { inCallChatNamespace } from '../call-chat.js';
import { inDistillationNamespace, isDistillationChannel, mayReadDistillation } from '../distillation-channels.js';
import { inFlowRunNamespace, parseFlowRunChannel } from '../flow-runs/channel.js';
import { inSocialDeckNamespace, parseSocialDeckChannel, socialDeckPresenceChannel } from '../social-deck-channel.js';
import { SOCIAL_CHANNEL_PREFIX, slugForChannel, socialChat } from '../social-chat.js';
import { isSocialTeamMember } from '../../providers/social-platform.js';
import { pageResourceVisible, type PageResourceKind } from '../page-resources.js';
import {
  TENANT_CHANNEL_FAMILIES, TENANT_PARTITIONS, channelAuthorityFor, tenantChannelFamily,
  type ChannelAuthority, type TenantChannelFamily,
} from '../tenant-channels.js';
import {
  SOCIAL_WORK_GRAPH_CONVERSATION, authorizeConversationChat, authorizeFlowRunChannel,
  authorizeHuddleChannel, authorizeSocialDeckChannel, authorizeSocialWorkGraphChannel, currentSocialMembershipProof, getLivePrincipal,
  holdsChannelAuthority, huddleCallId, inSocialWorkGraphNamespace, initiativeDeckVisible, sessionGatewayContext,
  sessionMeets, socialActionRole, socialConversationReadable,
  type LiveCallGuards, type LiveChannelAuthorization, type LiveChannelGuards, type LiveGatewayAuth, type LiveGatewayPrincipal,
} from '../live-principal.js';
import { mayReadUpload } from '../gateway-attachments.js';
import { currentlyReadsTenantChannel } from '../social-notify.js';
import type { Session } from '../session.js';

/** What the shape guards read from a connection's auth context. */
export type GuardAuth = { userId?: unknown; org?: unknown; tenants?: unknown; role?: unknown };

// ── The family table, as the engine reads it ─────────────────────────────────

/** An initiative deck's row + budget tier (providers/initiative-decks.ts), asked
 * as the `orgiq:deck` family's channel resource. The host copy asked it inline
 * (live-principal.ts `admitChannel`); the table in
 * lib/tenant-channels.ts keeps no resource for it, so only the engine's view
 * carries it. */
const INITIATIVE_DECK = 'initiative-deck';
type GatewayFamily = Omit<TenantChannelFamily, 'channelResource'> & { channelResource?: PageResourceKind | typeof INITIATIVE_DECK };
const GATEWAY_FAMILY_TABLE: readonly GatewayFamily[] = TENANT_CHANNEL_FAMILIES
  .map(family => family.id === 'orgiq:deck' ? { ...family, channelResource: INITIATIVE_DECK } : family);

/** `social:team:<team slug>:<channel>` — a team's chat channel (design §4.3). */
const TEAM_CHANNEL = /^social:team:([^:]+):[^:]+$/;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/**
 * The shape mechanism (library) over this host's table and rules. A name's
 * partition must be the caller's tenant (`org`) or one the token's `tenants`
 * claim lists (E5); `<p>:dm:<a>:<b>…` admits only its ids (`dmLobbyAdmits`);
 * then, in order:
 *   - host namespaces (decided before the table; never call lobbies):
 *     `orgiq:huddle:<callId>` chat (exact name or `reactions:`, a token holding
 *     orgiq or assessment — the SEAT is asked by the engine every time),
 *     the `orgiq:distill:*` feed (a plain subscribe under the REST read gate),
 *     `<tenant>:flowrun:<runId>` (a plain subscribe in a held partition),
 *     `social:deck:<id>` (presence only, a social grant);
 *   - `social:team:<team>:<channel>` only for the team's roster, a malformed
 *     `social:team:` name never, `social:ch:<slug>` only for the channel's
 *     active members (chat, presence and its call lobby agree);
 *   - under orgiq / assessment / pipelines / access only a listed family, only
 *     for the services it offers, and only a `lobby: true` family as a call lobby
 *     (default deny, 2026-10-05);
 *   - any other `social:` name passes the shape (live Social actions decide it).
 */
const GATEWAY_FAMILIES = defineChannelFamilies<ChannelAuthority, GatewayFamily>(GATEWAY_FAMILY_TABLE, {
  partitions: TENANT_PARTITIONS,
  // Matchers are arrows, not the imported functions themselves: call-chat.ts
  // reaches this module through call-access.ts, so its exports may not be
  // initialised yet while this table is built.
  namespaces: [
    { id: 'call-chat', match: name => inCallChatNamespace(name), guard: (auth, channel, _kind, bare) => {
      const org = str(auth.org); const tenants = list(auth.tenants);
      return !!huddleCallId(bare) && (channel === bare || channel === `reactions:${bare}`) && !!str(auth.userId)
        && ['orgiq', 'assessment'].some(tenant => org === tenant || tenants.includes(tenant));
    } },
    { id: 'distillation', match: name => inDistillationNamespace(name), guard: (auth, channel, kind, bare) =>
      kind === 'subscribe' && channel === bare && isDistillationChannel(bare) && mayReadDistillation(auth as GuardAuth) },
    { id: 'flow-run', match: name => inFlowRunNamespace(name), guard: (auth, channel, kind, bare) => {
      const ref = parseFlowRunChannel(bare);
      return !!ref && kind === 'subscribe' && channel === bare && !!str(auth.userId)
        && (ref.tenant === str(auth.org) || list(auth.tenants).includes(ref.tenant));
    } },
    { id: 'social-deck', match: name => inSocialDeckNamespace(name), guard: (auth, channel, _kind, bare) => {
      const ref = parseSocialDeckChannel(bare);
      return !!ref && channel === socialDeckPresenceChannel(ref.deckId) && !!str(auth.userId)
        && (str(auth.org) === 'social' || list(auth.tenants).includes('social'));
    } },
  ],
  rules: (_auth, name, at) => {
    const team = TEAM_CHANNEL.exec(name);
    if (team) return isSocialTeamMember(team[1]!, at.userId);
    if (at.partition === 'social' && at.rest.startsWith('team:')) return false; // a malformed team name
    if (name.startsWith(SOCIAL_CHANNEL_PREFIX)) return !!slugForChannel(name) && socialChat().membershipStore.isActiveMember(name, at.userId);
    return undefined;
  },
  otherPartition: (_auth, _name, at) => at.partition === 'social',
});

// ── The synchronous shape guards ─────────────────────────────────────────────

/** May this connection use `lobbyName` as a call lobby (the shape, before any I/O)? */
export function lobbyGuard(auth: GuardAuth, lobbyName: string): boolean {
  return GATEWAY_FAMILIES.lobbyGuard(auth as LibraryGuardAuth, lobbyName);
}

/** May this connection subscribe to / publish on `channel` (the shape, before any I/O)? */
export function channelGuard(auth: GuardAuth | null, channel: string, kind: 'subscribe' | 'publish' = 'subscribe'): boolean {
  return GATEWAY_FAMILIES.guard(auth as LibraryGuardAuth | null, channel, kind);
}

// ── The engine ───────────────────────────────────────────────────────────────

/** The guard pair the host namespace handlers (flow runs, Social decks, the
 * work graph's conversations, huddle chat) compose with: the engine's own guard
 * and channel decision. */
const engineGuards: LiveChannelGuards = {
  guard: (auth, channel, kind) => GATEWAY_FAMILIES.guard(auth as LibraryGuardAuth, channel, kind),
  baseChannel,
  decide: args => AUTHORITY.authorizeChannel(args),
};

type Step<Q> = Q extends 'channel' ? ChannelStep<LiveGatewayPrincipal> : CallStep<LiveGatewayPrincipal>;

/** A Social name: the action (ViewSocial to read, PostMessage to post) and the
 * conversation's membership proof (shared across one library operation's
 * checks through `scope`), both rechecked on the reloaded principal. */
const socialChannelStep: Step<'channel'> = async (principal, q) => {
  if (!q.base.startsWith('social:')) return undefined;
  const role = await socialActionRole(principal.session, q.kind === 'subscribe' ? 'ViewSocial' : 'PostMessage');
  if (role === null) return false;
  const membership = await currentSocialMembershipProof(q.base, principal.session.sub, q.scope);
  if (!membership.allows()) { membership.dispose(); return false; }
  return { recheck: latest => !!latest.session.grants.social?.includes(role) && membership.allows(), dispose: membership.dispose };
};
/** The work graph's stream names are never a place to call into, well-formed or not. */
const workGraphLobbyStep: Step<'call'> = (_principal, q) => q.lobby && inSocialWorkGraphNamespace(q.lobby) ? false : undefined;
/** A Social call lobby: StartCall to act (ViewSocial to receive) and the lobby's membership, rechecked after the reload. */
const socialCallStep: Step<'call'> = async (principal, q) => {
  if (!q.lobby?.startsWith('social:')) return undefined;
  const role = await socialActionRole(principal.session, q.receiving ? 'ViewSocial' : 'StartCall');
  if (role === null) return false;
  const membership = await currentSocialMembershipProof(q.lobby, principal.session.sub);
  if (!membership.allows()) { membership.dispose(); return false; }
  return { recheck: latest => !!latest.session.grants.social?.includes(role) && membership.allows(), dispose: membership.dispose };
};

const AUTHORITY = createChannelAuthority<LiveGatewayPrincipal, ChannelAuthority, GatewayFamily>({
  families: GATEWAY_FAMILIES,
  principal: { load: ctx => getLivePrincipal(ctx), auth: principal => principal.auth as LibraryGuardAuth },
  holds: (principal, authority) => holdsChannelAuthority(principal.session, authority),
  meets: (principal, authority) => sessionMeets(principal.session, authority),
  // The REST read's 404 half, read now: a channel decision asks it for THIS
  // reader (an access request's read rule), a lobby decision for the page.
  resource: (kind, name, principal, use) => kind === INITIATIVE_DECK
    ? initiativeDeckVisible(name, principal.session)
    : use === 'channel' ? pageResourceVisible(kind as PageResourceKind, name, principal.session.sub) : pageResourceVisible(kind as PageResourceKind, name),
  namespaces: [
    // A flow run's private channel has exactly one reader: the run's requester (the durable row, now).
    { id: 'flow-run', match: base => inFlowRunNamespace(base), channel: args => authorizeFlowRunChannel(args, args.base, engineGuards) },
    // A Social deck's presence channel: owner or a current member of the source conversation.
    { id: 'social-deck', match: base => inSocialDeckNamespace(base), channel: args => authorizeSocialDeckChannel(args, args.base, engineGuards) },
    // `social:workgraph*` is default deny: only the family's own names pass.
    { id: 'social-workgraph-deny', match: base => inSocialWorkGraphNamespace(base) && !GATEWAY_FAMILIES.familyOf(base), channel: () => false },
    // The social work graph's per-conversation stream: ViewSocial AND the conversation's own chat read, now.
    { id: 'social-workgraph-conversation', match: base => SOCIAL_WORK_GRAPH_CONVERSATION.test(base),
      channel: args => authorizeSocialWorkGraphChannel(args, args.base, engineGuards) },
    // A huddle's chat: only current seats of that call, never a grant or partition alone.
    { id: 'call-chat', match: base => base === 'orgiq:huddle' || base.startsWith('orgiq:huddle:'),
      channel: args => authorizeHuddleChannel(args, args.base, engineGuards) },
  ],
  channelSteps: [socialChannelStep],
  callSteps: [workGraphLobbyStep, socialCallStep],
});

// ── The guard pairs the live-principal primitives take ───────────────────────

/** The one `{ guard, baseChannel, decide }` set for channel decisions (chat,
 * presence, reactions, cursor, uploads, pins, summaries, the work graph's
 * readers). `decide` is `admitChannel`, so a primitive that asks a channel
 * decision inside (uploads, conversation chat) asks the engine. */
export const channelGuards: LiveChannelGuards = { guard: channelGuard, baseChannel, decide: args => admitChannel(args) };

/** The `{ guard, getLobby }` pair for call decisions; `getLobby` resolves a
 * stored call's lobby (legacy accepted/status frames name only a callId).
 * The engine asks its own lobby guard; `guard` is the shape check the direct
 * recipient filter applies to a notification's channel. */
export function callGuards(getLobby: LiveCallGuards['getLobby'], guard: LiveCallGuards['guard'] = lobbyGuard): LiveCallGuards {
  return { guard, getLobby };
}

/** A call question with no stored call behind it (POST /api/realtime/lobby-access). */
export const noStoredCall: LiveCallGuards['getLobby'] = async () => null;

// ── The fresh-per-request decisions ──────────────────────────────────────────

type Context = Record<string, unknown> | null;
export type ChannelKind = 'subscribe' | 'publish';
export type LobbyReadVerdict = LobbyVerdict;

/**
 * May this socket (or REST caller standing in for one, `clientId: 'http'` /
 * `'rest:*'`) subscribe to or publish on `channel` NOW — the router's
 * `authorize` hook, the uploads' `authz`, the pins/summarize read, all one rule:
 * the shape, then the freshly reloaded session, Social action + membership,
 * the family's Cedar action and page resource, a second reload.
 */
export function admitChannel(args: LiveChannelAuthorization): Promise<boolean> {
  return AUTHORITY.authorizeChannel(args);
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
 * identity on invite (`verifyCaller`), the lobby's shape, the family's REST
 * read, Social StartCall + membership, the page resource, a second reload.
 */
export function admitCall(ctx: Context, action: string, payload: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return AUTHORITY.authorizeCall(ctx, action, payload, { getLobby: guards.getLobby });
}

/** A call frame about to be DELIVERED to this socket: the recipient's own fresh authority. */
export function admitCallRecipient(ctx: Context, data: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return AUTHORITY.authorizeCallRecipient(ctx, data, { getLobby: guards.getLobby });
}

/**
 * May this principal read a page lobby's call history NOW (`GET /api/calls`,
 * the plane's Active now): the family's read, the page existing now, the
 * partition rule. `'not-a-lobby'` is a name no tenant family lists as a lobby.
 */
export function admitLobbyRead(ctx: Context, lobby: string): Promise<LobbyReadVerdict> {
  return AUTHORITY.authorizeLobby(ctx, lobby, 'read');
}

/**
 * A page lobby's read verdict for a session the CALLER already holds current
 * (a REST route's session, a huddle seat's directory read) — no reload here:
 * the family table's lobby flag (`'not-a-lobby'`, also for a lobby of another
 * tenant than `tenant` when given), the family's read authority (`'denied'`),
 * the page existing now (`'gone'`). The one copy of the rule
 * agent-loop-create's meeting step and call-access's huddle grant asked by hand.
 */
export async function admitLobbyReadFor(session: Session, lobby: string, opts: { tenant?: string } = {}): Promise<LobbyReadVerdict> {
  const family = GATEWAY_FAMILIES.lobbyFamily(lobby);
  if (!family || (opts.tenant !== undefined && family.tenant !== opts.tenant)) return 'not-a-lobby';
  try {
    if (!await holdsChannelAuthority(session, family.read)) return 'denied';
    if (family.lobbyResource && !await pageResourceVisible(family.lobbyResource, lobby)) return 'gone';
    return 'ok';
  } catch { return 'denied'; }
}

/**
 * May this principal read (`subscribe`) or post to (`publish`) a non-Social
 * conversation's chat history NOW — pins, `/summarize`, the work graph's own
 * flow runs. Huddles ask their seat; tenant families ask `admitChannel` plus
 * the chat service's explicit membership rows. Social names are refused here
 * (they keep `admitSocialConversation` / routes/chat-pins.ts chatAccess).
 */
export function admitConversationChat(args: { ctx: Context; channel: string; kind: ChannelKind; clientId: string; scope?: AuthorityScope }): Promise<boolean> {
  return authorizeConversationChat(args, engineGuards);
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
  return mayReadUpload(found, ctx, engineGuards);
}

/**
 * The distillation feed's rule, as the cookie /realtime path asks it: a plain
 * subscribe on one of the three channels by a current session standing in
 * orgiq (or an admin). A publish is never admitted. The /ws path reaches the
 * same verdict through `channelGuard`'s distillation namespace under
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
 * notifications feature's admission, the `forgotten` call receipt's, and the
 * gateway's principal revalidation (lib/realtime-gateway.ts).
 */
export function admitPrincipal(ctx: Context): Promise<boolean> {
  return AUTHORITY.current(ctx);
}

/**
 * The producer side of the activity/pipeline features: a server-produced
 * frame leaves only onto a channel some family in the allowlist names
 * (lib/gateway-run-feed.ts). Default-deny on the way out as well as in.
 */
export function producerChannelAllowed(channel: string): boolean {
  return GATEWAY_FAMILIES.isProducerChannel(channel);
}

/**
 * A session's authority on one family name (read for `subscribe`, write for
 * `publish`), asked fresh against the session given — for a REST-side wrapper
 * that already holds a current session (lib/assessment-page-references.ts).
 */
export function holdsFamilyAuthority(session: Session, channel: string, kind: ChannelKind): Promise<boolean> {
  return AUTHORITY.holdsFamily({ session, auth: sessionGatewayContext(session) as LiveGatewayAuth }, channel, kind);
}
