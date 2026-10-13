// Current socket/embedded authority comes from the directory. The signed
// identity fixes the source tenant, role, epoch and actor; a lookup may refresh
// grants, but must never silently select another identity or role.
import { AppError, SessionInvalidError } from './async-handler.js';
import { isAllowed } from './authz.js';
import { currentDocumentSessionEpoch, documentSessionId } from './document-session.js';
import { getUser, type UserInfo } from '../providers/identity.js';
import { ADMIN_ROLE, DEFAULT_ROLE, DEFAULT_TENANT, DEMO_SUB, TENANTS, demoFallbackAllowed, demoScopedGrants, permissiveGrants, type Session, type Grants } from './session.js';
import type { AuthorityScope } from '@connorhoehnslalom/realtime-modules/server';
import { socialChat } from './social-chat.js';
import { TENANT_PARTITIONS, channelAuthorityFor, tenantChannelFamily, type ChannelAuthority, type TenantChannelFamily } from './tenant-channels.js';
import { pageResourceVisible } from './page-resources.js';
import { PIPELINE_DECK_REVISE_KIND, inFlowRunNamespace, isConversationSummarizeKind, parseFlowRunChannel } from './flow-runs/channel.js';
import { flowRunStore } from './flow-runs/store.js';
import { inSocialDeckNamespace, parseSocialDeckChannel, socialDeckPresenceChannel } from './social-deck-channel.js';

export interface LiveGatewayAuth extends Record<string, unknown> {
  userId: string; displayName: string; org: string; role: string; tenants: string[];
  epoch: number; sessionIat: number;
}
export interface LiveGatewayPrincipal { session: Session; auth: LiveGatewayAuth }
type Context = Record<string, unknown> | null;

function epoch(value: unknown): number {
  const normalized = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) throw new SessionInvalidError('Invalid session provenance');
  return Number(normalized);
}
function provenance(session: Session): void {
  if (typeof session.sub !== 'string' || !session.sub || typeof session.role !== 'string' || !session.role
    || !TENANTS.includes(session.tenant) || !Number.isFinite(session.iat) || session.iat < 0) {
    throw new SessionInvalidError('Invalid session provenance');
  }
  epoch(session.epoch);
  if (session.act) {
    if (typeof session.act.sub !== 'string' || !session.act.sub) throw new SessionInvalidError('Invalid actor provenance');
    epoch(session.act.epoch);
  }
}
const detachedGrants = (grants: Grants): Grants => Object.fromEntries(Object.entries(grants)
  .map(([tenant, roles]) => [tenant, [...roles]]));
// The provider combines only reads queued before SQL dispatch. Sharing a
// query that already captured a snapshot would let a later action reuse
// pre-revocation authority while that older query is still outstanding.
function authoritativeUser(userId: string): Promise<UserInfo | null> {
  return getUser(userId, { authoritative: true }).then(user => user ? structuredClone(user) : null);
}

/** No directory outage or missing user falls back to a seed account. */
export async function currentLiveSession(session: Session): Promise<Session> {
  provenance(session);
  try {
    const demo = session.sub === DEMO_SUB && process.env['NODE_ENV'] !== 'production' && demoFallbackAllowed();
    if (demo) {
      if (await currentDocumentSessionEpoch(session.sub, session.tenant, documentSessionId(session)) === null) {
        throw new SessionInvalidError();
      }
      // The built-in demo directory excludes Social and Pipelines. Never use
      // token/cookie tenant claims to expand those fixed demo grants.
      const fixed = permissiveGrants();
      const initial = session.tenant === DEFAULT_TENANT && session.role === DEFAULT_ROLE
        && (session.grants.assessment?.length ?? 0) > 0;
      const grants = session.role === ADMIN_ROLE || initial ? fixed
        : demoScopedGrants(session.sub, session.tenant, session.role, fixed);
      return { ...session, grants, epoch: epoch(session.epoch) };
    }
    const [user, actor] = await Promise.all([
      authoritativeUser(session.sub),
      session.act ? authoritativeUser(session.act.sub) : Promise.resolve(null),
    ]);
    if (!user || user.epoch !== epoch(session.epoch) || !user.grants[session.tenant]?.includes(session.role)
      || (session.act && (!actor || actor.epoch !== epoch(session.act.epoch)
        || !Object.values(actor.grants).some(roles => roles.includes('admin'))))) {
      throw new SessionInvalidError();
    }
    return { ...session, name: user.displayName, grants: detachedGrants(user.grants), epoch: user.epoch };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'The identity store is unavailable');
  }
}

function socketSession(ctx: Context): Session {
  if (!ctx || typeof ctx.userId !== 'string' || typeof ctx.org !== 'string' || typeof ctx.role !== 'string') {
    throw new SessionInvalidError('Unauthenticated');
  }
  const actor = ctx.act;
  if (actor !== undefined && (!actor || typeof actor !== 'object' || Array.isArray(actor))) {
    throw new SessionInvalidError('Invalid actor provenance');
  }
  const act = actor as { sub?: unknown; epoch?: unknown } | undefined;
  // Only the fixed local demo uses signed tenant keys to distinguish its
  // initial browser persona from a deliberately narrowed selected persona.
  const fixedDemo = permissiveGrants();
  const demoGrants = ctx.userId === DEMO_SUB && Array.isArray(ctx.tenants)
    ? Object.fromEntries(Object.entries(fixedDemo).filter(([tenant]) => (ctx.tenants as unknown[]).includes(tenant))) : {};
  return {
    sub: ctx.userId, tenant: ctx.org as Session['tenant'], role: ctx.role as Session['role'],
    epoch: epoch(ctx.epoch), grants: demoGrants, iat: ctx.sessionIat === undefined ? 0 : Number(ctx.sessionIat),
    ...(act ? { act: { sub: act.sub as string, epoch: epoch(act.epoch), role: 'admin', tenant: 'orgiq', grants: {} } } : {}),
  };
}
export async function getLivePrincipal(ctx: Context): Promise<LiveGatewayPrincipal> {
  const session = await currentLiveSession(socketSession(ctx));
  // The directory-checked session is strict about its epoch (`epoch`); REST
  // routes holding a freshly signed session use the lenient default below.
  return { session, auth: { ...ctx, ...sessionGatewayContext(session, epoch) } as LiveGatewayPrincipal['auth'] };
}

/** The socket context the gateway would hold for this signed session (the same
 * identity; `getLivePrincipal` re-reads it from the directory). For REST routes
 * that ask a conversation's gateway authority. */
export function sessionGatewayContext(session: Session, epochOf: (value: unknown) => number = value => (value as number | undefined) ?? 0): Record<string, unknown> {
  return {
    userId: session.sub, displayName: session.name ?? session.sub, org: session.tenant, role: session.role,
    epoch: epochOf(session.epoch), sessionIat: session.iat,
    tenants: Object.entries(session.grants).filter(([, roles]) => roles.length > 0).map(([tenant]) => tenant),
    ...(session.act ? { act: { sub: session.act.sub, epoch: epochOf(session.act.epoch) } } : {}),
  };
}

/**
 * The first Social role the directory grants `current` whose policy allows
 * `action`, or null. The REST gate over it (fresh session, recheck after the
 * policy call) is lib/social-authority.ts `currentSocialActionSession` — the
 * one Social permission path; this primitive is shared with the gateway's
 * channel/call authorization below, which rechecks on its own schedule.
 */
export async function socialActionRole(current: Session, action: string): Promise<string | null> {
  let allowedRole: string | null = null;
  for (const role of current.grants.social ?? []) {
    if (await isAllowed({ sub: current.sub, tenant: 'social', role }, action)) { allowedRole = role; break; }
  }
  return allowedRole;
}

/** Explicit conversation rows can close a DM/team even when its name admits it. */
export async function currentSocialMembership(channel: string, userId: string): Promise<boolean> {
  const proof = await currentSocialMembershipProof(channel, userId);
  try { return proof.allows(); } finally { proof.dispose(); }
}
export interface SocialMembershipProof { channel: string; allows: () => boolean; dispose: () => void }
/**
 * Fresh membership for one check. With an active library `scope` (0.107: one
 * chat action or one fan-out) every check of that operation shares ONE durable
 * read per channel (MirroredMembershipStore.scopedMembers, key
 * `members:<channel>`). Fences, per check:
 *   - its own observer, registered before it asks, held until `dispose`;
 *   - the shared read's observer, registered before that read began and held
 *     until the scope closes. Once either fires the proof denies, and because
 *     the shared flag is sticky every remaining check of the operation on that
 *     channel denies too — a removal or peer hint mid-fan-out refuses the
 *     recipients still waiting. A closed scope is never consulted.
 */
export async function currentSocialMembershipProof(channel: string, userId: string, scope?: AuthorityScope): Promise<SocialMembershipProof> {
  const chat = socialChat(); await chat.ready;
  const observer = chat.membershipStore.observeChanges(channel);
  try {
    const shared = scope?.active ? chat.membershipStore.scopedMembers(channel, scope) : null;
    const read = shared ? await shared : null;
    const rows = read ? read.rows : await chat.membershipStore.listMembers(channel);
    const allowed = rows.length === 0 || rows.some(row => row.userId === userId && row.removedAt == null);
    return { channel, allows: () => allowed && !observer.changed() && !(read?.changed() ?? false), dispose: observer.dispose };
  } catch (error) { observer.dispose(); throw error; }
}

/** The active (signed) source tenant, or the cross-tenant admin — the same
 * rule as `requireTenant` — and a current grant in the family's tenant. */
function sessionMeets(session: Session, authority: ChannelAuthority): boolean {
  const granted = Object.entries(session.grants).some(([tenant, roles]) => tenant === authority.tenant && roles.length > 0);
  if (!authority.activeTenant) return granted || session.role === ADMIN_ROLE;
  return session.tenant === authority.tenant || session.role === ADMIN_ROLE;
}
/** Fresh per call: the policy decision is the REST route's own `isAllowed`. */
export async function holdsChannelAuthority(session: Session, authority: ChannelAuthority): Promise<boolean> {
  if (!sessionMeets(session, authority)) return false;
  if (!authority.action) return true;
  return isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, authority.action);
}

export interface LiveChannelAuthorization {
  kind: 'subscribe' | 'publish'; clientId: string; channel: string; ctx: Context;
  /** The library operation this check belongs to (0.107). Shares only the
   * Social membership read; directory, actor and policy are asked per check. */
  scope?: AuthorityScope;
}
export interface LiveChannelGuards {
  baseChannel: (channel: string) => string;
  guard: (auth: LiveGatewayAuth, channel: string, kind: 'subscribe' | 'publish') => boolean;
}
/** Requires the async-aware public router; never pass to a boolean-only hook. */
export async function authorizeLiveGatewayChannel(args: LiveChannelAuthorization, guards: LiveChannelGuards): Promise<boolean> {
  let membership: SocialMembershipProof | null = null;
  try {
    const base = guards.baseChannel(args.channel);
    // A flow run's private channel has exactly one reader; it never reaches
    // the Social or family rules below, which admit by grant or membership.
    if (inFlowRunNamespace(base)) return await authorizeFlowRunChannel(args, base, guards);
    // A Social deck's presence channel: owner or a current member of the source conversation.
    if (inSocialDeckNamespace(base)) return await authorizeSocialDeckChannel(args, base, guards);
    // `social:workgraph*` is default-deny: only the family's own names pass (the sync channel guard admits any `social:` name).
    if (inSocialWorkGraphNamespace(base) && !tenantChannelFamily(base)) return false;
    // The social work graph's per-conversation stream: the family's ViewSocial AND the conversation's own chat read, now.
    if (SOCIAL_WORK_GRAPH_CONVERSATION.test(base)) return await authorizeSocialWorkGraphChannel(args, base, guards);
    // A huddle's chat: only current seats of that call, never a grant or partition alone.
    if (base === 'orgiq:huddle' || base.startsWith('orgiq:huddle:')) return await authorizeHuddleChannel(args, base, guards);
    let principal = await getLivePrincipal(args.ctx);
    if (base.startsWith('social:')) {
      const allowedRole = await socialActionRole(principal.session, args.kind === 'subscribe' ? 'ViewSocial' : 'PostMessage');
      if (allowedRole === null) return false;
      membership = await currentSocialMembershipProof(base, principal.session.sub, args.scope);
      if (!membership.allows()) return false;
      principal = await getLivePrincipal(args.ctx);
      if (!principal.session.grants.social?.includes(allowedRole) || !membership.allows()) return false;
    }
    // A non-Social tenant family asks the same authority its REST read/write
    // route asks, against this freshly loaded session (lib/tenant-channels.ts).
    // A family the shape table refuses never reaches the policy call.
    const family = tenantChannelFamily(base);
    if (family) {
      const authority = channelAuthorityFor(family, args.channel, args.kind);
      if (!authority || !await holdsChannelAuthority(principal.session, authority)) return false;
      // An initiative deck is a per-resource read: the deck row now, and the
      // REST route's own budget-tier rule (providers/initiative-decks.ts).
      if (family.id === 'orgiq:deck' && !await initiativeDeckVisible(base, principal.session)) return false;
      // A page resource (a team) is the REST read's 404 half, read now.
      if (family.channelResource && !await pageResourceVisible(family.channelResource, base, principal.session.sub)) return false;
      // The policy/row I/O can outlive a revocation: reload once more and decide
      // the shape with only the grants that are current after it.
      principal = await getLivePrincipal(args.ctx);
      if (!sessionMeets(principal.session, authority)) return false;
    }
    // Existing namespace, DM, channel/team membership and distillation rules
    // still decide the resource, using only refreshed tenant grant keys.
    return guards.guard(principal.auth, args.channel, args.kind);
  } catch { return false; }
  finally { membership?.dispose(); }
}

/** Any name under the social work graph's namespace, well-formed or not. */
export const inSocialWorkGraphNamespace = (name: string): boolean => /^social:workgraph(?::|$)/.test(name);
const SOCIAL_WORK_GRAPH_CONVERSATION = /^social:workgraph:conversation:(social:(?:ch|dm|team|room):[A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/;

/**
 * May this principal read conversation `conversation`'s chat NOW — the authority `/api/chat/*` asks (routes/chat-pins.ts
 * chatAccess): the name's shape and membership rule (lobbyGuard: channel members, DM ids, team roster), then the chat
 * service's explicit membership rows. A room has no chat: it is the platform's visibility, which the graph's loader asks
 * with the rest of the rows, so the stream only checks the family for it.
 */
export async function socialConversationReadable(userId: string, conversation: string, guard: (auth: LiveGatewayAuth, channel: string, kind: 'subscribe' | 'publish') => boolean,
  auth: LiveGatewayAuth): Promise<boolean> {
  if (conversation.startsWith('social:room:')) return true;
  if (!guard(auth, conversation, 'subscribe')) return false;
  const chat = socialChat(); await chat.ready;
  const rows = await chat.membershipStore.listMembers(conversation);
  // chatAccess's own rule: explicit rows close a conversation; none leaves the name's rule (already passed) to decide.
  return rows.length === 0 || rows.some(row => row.userId === userId && row.removedAt == null);
}

/**
 * `social:workgraph:conversation:<channel>`: the family's read (active Social tenant + ViewSocial, current role grant) and
 * the conversation's chat read, asked per subscribe AND per delivered frame against the freshly reloaded session. A
 * non-member's subscribe is the same refusal as an unknown conversation. A second reload after the awaits denies a grant
 * revoked or an epoch bumped meanwhile.
 */
async function authorizeSocialWorkGraphChannel(args: LiveChannelAuthorization, base: string, guards: LiveChannelGuards): Promise<boolean> {
  const conversation = SOCIAL_WORK_GRAPH_CONVERSATION.exec(base)?.[1];
  const family = tenantChannelFamily(base);
  if (!conversation || !family) return false;
  const authority = channelAuthorityFor(family, args.channel, args.kind);
  if (!authority) return false;
  let principal = await getLivePrincipal(args.ctx);
  const role = await socialActionRole(principal.session, 'ViewSocial');
  if (role === null || !await holdsChannelAuthority(principal.session, authority)) return false;
  if (!await socialConversationReadable(principal.session.sub, conversation, guards.guard, principal.auth)) return false;
  principal = await getLivePrincipal(args.ctx);
  return !!principal.session.grants.social?.includes(role) && sessionMeets(principal.session, authority)
    && guards.guard(principal.auth, args.channel, args.kind);
}

/**
 * `orgiq:deck:<deckId>` (presence only): exactly GET /api/initiative-decks/:id's
 * visibility — `deckViewerFor` (budget-read roles, else ManageBudgets) and
 * `visibleDeck` (the durable row, read now; a budget deck is invisible below the
 * tier). A malformed id, an unknown deck and a hidden budget deck are one
 * refusal. Asked on every subscribe and delivered frame; the caller reloads the
 * session afterwards, so a grant/epoch revoked during this I/O denies.
 */
async function initiativeDeckVisible(base: string, session: Session): Promise<boolean> {
  const deckId = base.slice('orgiq:deck:'.length);
  const decks = await import('../providers/initiative-decks.js');
  return (await decks.visibleDeck(deckId, await decks.deckViewerFor(session))) !== null;
}

/**
 * `<tenant>:flowrun:<runId>` (lib/flow-runs/channel.ts): a plain subscribe by
 * the run's requester, nothing else. Asked per subscribe AND per delivered
 * frame (the router re-authorizes every recipient), each time against:
 *   - the freshly reloaded session (epoch, grant, actor — currentLiveSession);
 *   - the durable `flow_runs` row read now (no positive cache): unknown,
 *     another tenant's, or someone else's run is one indistinguishable refusal;
 *   - the REST read the run's tenant asks: assessment = active tenant +
 *     ViewAssessment; social = ViewSocial + current membership of the run's
 *     conversation (the summarize route's chatAccess);
 *   - a second session reload after those awaits, so a grant revoked or an
 *     epoch bumped while the policy/row/membership I/O was pending denies.
 * Publish (any service) and service-prefixed names (presence:, reactions:, …)
 * are refused outright: frames come only from the server's emitEvent.
 */
async function authorizeFlowRunChannel(args: LiveChannelAuthorization, base: string, guards: LiveChannelGuards): Promise<boolean> {
  const ref = parseFlowRunChannel(base);
  if (!ref || args.kind !== 'subscribe' || args.channel !== base) return false;
  let membership: SocialMembershipProof | null = null;
  try {
    let principal = await getLivePrincipal(args.ctx);
    const run = await flowRunStore.get(ref.runId);
    if (!run || run.tenant !== ref.tenant || run.requestedBy !== principal.session.sub) return false;
    // A conversation /summarize run (osm-/asm-/psm-): exactly the authority
    // that conversation's chat history has now, then the requester again.
    if (isConversationSummarizeKind(run.kind)) {
      if (!await authorizeConversationChat({ ctx: args.ctx, channel: run.scope, kind: 'subscribe', clientId: args.clientId }, guards)) return false;
      principal = await getLivePrincipal(args.ctx);
      return principal.session.sub === run.requestedBy;
    }
    if (ref.tenant === 'social') {
      const role = await socialActionRole(principal.session, 'ViewSocial');
      if (role === null) return false;
      membership = await currentSocialMembershipProof(run.scope, principal.session.sub, args.scope);
      if (!membership.allows()) return false;
      principal = await getLivePrincipal(args.ctx);
      if (!principal.session.grants.social?.includes(role) || !membership.allows()) return false;
      // The run's conversation still admits this person by name (DM ids, team roster, channel rows).
      return guards.guard(principal.auth, run.scope, 'subscribe') && membership.allows();
    }
    // A run report deck's agent revise (pdr-): the REST read is requireTenant('pipelines') + ViewPipelines
    // + requester (GET /api/pipelines/decks/:id/runs/:runId), asked fresh like assessment's below.
    if (ref.tenant === 'pipelines') {
      if (run.kind !== PIPELINE_DECK_REVISE_KIND) return false;
      const authority: ChannelAuthority = { tenant: 'pipelines', activeTenant: true, action: 'ViewPipelines' };
      if (!await holdsChannelAuthority(principal.session, authority)) return false;
      principal = await getLivePrincipal(args.ctx);
      return sessionMeets(principal.session, authority) && principal.session.sub === run.requestedBy;
    }
    // Only assessment's evidence drafts remain; any other tenant's run kind is unknown here.
    if (ref.tenant !== 'assessment' || run.kind.endsWith('.summarize')) return false;
    const authority: ChannelAuthority = { tenant: 'assessment', activeTenant: true, action: 'ViewAssessment' };
    if (!await holdsChannelAuthority(principal.session, authority)) return false;
    principal = await getLivePrincipal(args.ctx);
    return sessionMeets(principal.session, authority) && principal.session.sub === run.requestedBy;
  } catch { return false; }
  finally { membership?.dispose(); }
}

/**
 * `orgiq:huddle:<callId>` chat (and `reactions:` on it), asked per subscribe,
 * publish AND delivered frame (the router re-authorizes every recipient):
 *   - the shape (`channelGuard`: exact name, chat or reactions only, an orgiq
 *     grant in the token);
 *   - the freshly reloaded session;
 *   - `CallChatRuntime.assertChannelAccess`: for a gateway connection, that
 *     connection is a current, non-departed seat of the call with the
 *     session's provenance, its person an active member, holding the
 *     huddle's Social grant (PostMessage to publish), fenced by its seat
 *     epoch; for a REST caller (`http`, `rest:*`), the session's own seat;
 *   - a second reload, so a grant revoked or epoch bumped meanwhile denies.
 */
async function authorizeHuddleChannel(args: LiveChannelAuthorization, base: string, guards: LiveChannelGuards): Promise<boolean> {
  const callId = huddleCallId(base);
  if (!callId) return false;
  try {
    const first = await getLivePrincipal(args.ctx);
    if (!guards.guard(first.auth, args.channel, args.kind)) return false;
    const { callChatRuntime } = await import('./call-chat.js');
    await callChatRuntime().assertChannelAccess(callId, args.clientId, first.session, args.kind === 'publish');
    const latest = await getLivePrincipal(args.ctx);
    return latest.session.sub === first.session.sub && guards.guard(latest.auth, args.channel, args.kind);
  } catch { return false; }
}

/** `orgiq:huddle:<callId>` (lib/call-chat.ts `callChatChannel`) → callId; null otherwise. */
export function huddleCallId(channel: string): string | null {
  const m = channel.match(/^orgiq:huddle:([a-zA-Z0-9:_-]{1,256})$/);
  return m ? m[1]! : null;
}

/** The chat-bearing family of a non-Social tenant conversation (a bare chat name), or null. */
export function summarizableFamily(channel: string): TenantChannelFamily | null {
  const family = tenantChannelFamily(channel);
  return family && TENANT_PARTITIONS.has(family.tenant) && family.services.has('chat') ? family : null;
}

/**
 * May this principal read (`subscribe`) or post to (`publish`) the chat history
 * of a non-Social conversation NOW — the authority the gateway already applies
 * to that conversation's chat, reused for `/summarize` (REST and its private
 * run channel). No settled cache: every call reloads the directory session.
 *   - a tenant family (`orgiq:initiative|work|session|invoke`, `assessment:doc`,
 *     `pipelines:run|def`): `authorizeLiveGatewayChannel` on the bare chat name
 *     (family shape, active tenant, the family's Cedar action, partition and
 *     DM rules), then the chat service's own membership gate (explicit rows
 *     close a conversation to non-members), then a second reload so a grant
 *     or epoch revoked during that I/O denies;
 *   - a huddle (`orgiq:huddle:<callId>`): the call-chat participant authority
 *     (`CallChatRuntime.assertMember`: an actual connected seat with matching
 *     provenance, an active history floor, and the huddle's Social grant —
 *     PostMessage to post), then a second reload.
 * Social conversations are refused here: they keep chatAccess.
 */
export async function authorizeConversationChat(
  args: { ctx: Context; channel: string; kind: 'subscribe' | 'publish'; clientId: string; scope?: AuthorityScope },
  guards: LiveChannelGuards,
): Promise<boolean> {
  try {
    const first = await getLivePrincipal(args.ctx);
    const callId = huddleCallId(args.channel);
    if (callId) {
      const { callChatRuntime } = await import('./call-chat.js');
      await callChatRuntime().assertMember(callId, first.session, args.kind === 'publish');
      const latest = await getLivePrincipal(args.ctx);
      return latest.session.sub === first.session.sub;
    }
    const family = summarizableFamily(args.channel);
    if (!family) return false;
    if (!await authorizeLiveGatewayChannel({ kind: args.kind, clientId: args.clientId, channel: args.channel, ctx: args.ctx,
      ...(args.scope ? { scope: args.scope } : {}) }, guards)) return false;
    const chat = socialChat(); await chat.ready;
    const rows = await chat.membershipStore.listMembers(args.channel);
    if (rows.length && !rows.some(row => row.userId === first.session.sub && row.removedAt == null)) return false;
    const latest = await getLivePrincipal(args.ctx);
    const authority = channelAuthorityFor(family, args.channel, args.kind);
    return !!authority && latest.session.sub === first.session.sub && sessionMeets(latest.session, authority);
  } catch { return false; }
}

/**
 * `social:deck:<deckId>` (lib/social-deck-channel.ts): presence only, as
 * `presence:social:deck:<id>`. Asked per subscribe AND per delivered frame, each
 * time against the freshly reloaded session and the durable deck row (no
 * positive cache). Admitted: the deck's owner, or a person who is a CURRENT
 * member of the conversation the deck was built from (the REST read in
 * routes/social-deck.ts `readableDeck`), both holding ViewSocial now. An unknown
 * deck and someone else's deck are one indistinguishable refusal. A second
 * reload after the awaits denies a grant revoked or an epoch bumped meanwhile.
 */
async function authorizeSocialDeckChannel(args: LiveChannelAuthorization, base: string, guards: LiveChannelGuards): Promise<boolean> {
  const ref = parseSocialDeckChannel(base);
  if (!ref || args.channel !== socialDeckPresenceChannel(ref.deckId)) return false;
  let membership: SocialMembershipProof | null = null;
  try {
    let principal = await getLivePrincipal(args.ctx);
    const role = await socialActionRole(principal.session, 'ViewSocial');
    if (role === null) return false;
    const { socialDeckStore } = await import('../providers/social-decks.js');
    const deck = await socialDeckStore.getDeck(ref.deckId);
    if (!deck) return false;
    const owner = deck.createdBy === principal.session.sub;
    if (!owner) {
      membership = await currentSocialMembershipProof(deck.channel, principal.session.sub, args.scope);
      if (!membership.allows()) return false;
    }
    principal = await getLivePrincipal(args.ctx);
    if (!principal.session.grants.social?.includes(role)) return false;
    if (owner) return principal.session.sub === deck.createdBy && guards.guard(principal.auth, args.channel, args.kind);
    // The source conversation still admits this person by name (DM ids, team roster, channel rows).
    return !!membership && guards.guard(principal.auth, deck.channel, 'subscribe') && membership.allows()
      && guards.guard(principal.auth, args.channel, args.kind);
  } catch { return false; }
  finally { membership?.dispose(); }
}

/**
 * May this principal read the call history of a page lobby NOW — the same
 * authority a call on that lobby asks (the family's read authority, the page's
 * resource existing now, the name's partition rule), minus the Social
 * membership half that only `social:` lobbies carry. `not-a-lobby` means the
 * name is no tenant call lobby at all; `denied` a family the reader may not read.
 * No settled cache: the directory session is reloaded before and after the I/O.
 */
export async function authorizeCallLobbyRead(ctx: Context, lobby: string, guard: (auth: LiveGatewayAuth, lobby: string) => boolean): Promise<'ok' | 'not-a-lobby' | 'gone' | 'denied'> {
  const family = tenantChannelFamily(lobby);
  if (!family || !family.lobby || !TENANT_PARTITIONS.has(family.tenant)) return 'not-a-lobby';
  try {
    let principal = await getLivePrincipal(ctx);
    if (!await holdsChannelAuthority(principal.session, family.read)) return 'denied';
    if (family.lobbyResource && !await pageResourceVisible(family.lobbyResource, lobby)) return 'gone';
    principal = await getLivePrincipal(ctx);
    return sessionMeets(principal.session, family.read) && guard(principal.auth, lobby) ? 'ok' : 'denied';
  } catch { return 'denied'; }
}

export interface LiveCallGuards {
  guard: (auth: LiveGatewayAuth, lobby: string) => boolean;
  /** Public call state resolves legacy accepted/status frames without a lobby. */
  getLobby: (callId: string) => Promise<string | null>;
}
/** Fresh action admission; recipient reads use their own ViewSocial policy. */
export async function authorizeLiveGatewayCall(ctx: Context, action: string, data: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return liveCallDecision(ctx, action, data, guards, false);
}
export async function authorizeLiveGatewayCallRecipient(ctx: Context, data: Record<string, unknown>, guards: LiveCallGuards): Promise<boolean> {
  return liveCallDecision(ctx, 'receive', data, guards, true);
}
async function liveCallDecision(ctx: Context, action: string, data: Record<string, unknown>, guards: LiveCallGuards, receiving: boolean): Promise<boolean> {
  let membership: SocialMembershipProof | null = null;
  try {
    let principal = await getLivePrincipal(ctx);
    let payload = data ?? {};
    const nested = payload.data;
    if (payload.callId == null && payload.lobbyName == null && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      payload = { ...(nested as Record<string, unknown>), ...payload };
    }
    if (action === 'invite' && payload.callerId !== principal.session.sub) return false;
    const explicit = typeof payload.lobbyName === 'string' && payload.lobbyName ? payload.lobbyName : null;
    const callId = typeof payload.callId === 'string' && payload.callId ? payload.callId : null;
    const stored = callId ? await guards.getLobby(callId) : null;
    // A frame cannot rename an existing Social call into a less restricted
    // source lobby to bypass its current action or membership authority.
    if (stored && explicit && stored !== explicit) return false;
    const lobby = stored ?? explicit;
    // The work graph's stream names are never a place to call into, well-formed or not.
    if (lobby && inSocialWorkGraphNamespace(lobby)) return false;
    if (receiving && !lobby) return false;
    let socialRole: string | null = null;
    if (lobby?.startsWith('social:')) {
      socialRole = await socialActionRole(principal.session, receiving ? 'ViewSocial' : 'StartCall');
      if (socialRole === null) return false;
      membership = await currentSocialMembershipProof(lobby, principal.session.sub);
      if (!membership.allows()) return false;
    }
    // A tenant family lobby (`orgiq:initiative:<id>`, `assessment:doc:<id>`)
    // asks its REST read authority for every action, ringing included.
    const family = lobby ? tenantChannelFamily(lobby) : null;
    if (family && (!family.lobby || !await holdsChannelAuthority(principal.session, family.read))) return false;
    // A page lobby (`assessment:team:<id>`, `pipelines:run:<id>`,
    // `orgiq:initiative:<id>`) also asks
    // its resource now, for every action including delivery: a deleted team
    // or pruned run fences the call the way its page 404s.
    if (family?.lobbyResource && lobby && !await pageResourceVisible(family.lobbyResource, lobby)) return false;
    // Both the public call lookup and policy/membership I/O may outlive a
    // source switch. The signed source role never changes during this check.
    principal = await getLivePrincipal(ctx);
    if (socialRole && !principal.session.grants.social?.includes(socialRole)) return false;
    if (family && !sessionMeets(principal.session, family.read)) return false;
    return (!membership || membership.allows()) && (!lobby || guards.guard(principal.auth, lobby));
  } catch { return false; }
  finally { membership?.dispose(); }
}
