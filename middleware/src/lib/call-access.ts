// Current call identity is shared by page pins and huddle chat. Token claims
// establish provenance; directory epochs/grants establish current authority.
import type { ActiveCallStateView, CallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import type { RealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { AppError } from './async-handler.js';
import { currentDocumentSessionEpoch, documentSessionId } from './document-session.js';
import { getUser } from '../providers/identity.js';
import { DEMO_SUB, demoFallbackAllowed, type Grants, type Session } from './session.js';
import { holdsChannelAuthority } from './live-principal.js';
import { tenantChannelFamily } from './tenant-channels.js';
import { pageResourceVisible } from './page-resources.js';

export interface CallAuthority { displayName: string; grants: Grants }
/** The tenants whose sockets page pins (OrgIQ only) and huddle chat resolve. */
export type CallTenant = 'orgiq' | 'assessment';
const ORGIQ_ONLY: readonly CallTenant[] = ['orgiq'];
/** Huddle chat: OrgIQ lobbies, and an assessment team page's huddle (`assessment:team:<id>`). */
export const HUDDLE_CHAT_TENANTS: readonly CallTenant[] = ['orgiq', 'assessment'];
/** The tenant a huddle-bearing lobby belongs to, or null (Social, documents, pipelines, malformed). */
export function huddleLobbyTenant(lobbyName: string): CallTenant | null {
  if (lobbyName.startsWith('orgiq:')) return 'orgiq';
  return /^assessment:team:TEAM-[A-Za-z0-9-]{1,120}$/.test(lobbyName) ? 'assessment' : null;
}
export async function currentCallAuthority(session: Session, tenants: readonly CallTenant[] = ORGIQ_ONLY): Promise<CallAuthority> {
  if (!tenants.includes(session.tenant as CallTenant)) {
    throw new AppError(403, tenants.length === 1 ? 'This call requires an OrgIQ session' : 'This call requires an OrgIQ or assessment session');
  }
  try {
    const isDemo = session.sub === DEMO_SUB && process.env['NODE_ENV'] !== 'production' && demoFallbackAllowed();
    if (isDemo) {
      if (await currentDocumentSessionEpoch(session.sub, session.tenant, documentSessionId(session)) === null) {
        throw new AppError(401, 'The session is no longer current. Sign in again.');
      }
      return { displayName: session.name ?? session.sub, grants: session.grants };
    }
    const [user, actor] = await Promise.all([
      getUser(session.sub, { authoritative: true }),
      session.act ? getUser(session.act.sub, { authoritative: true }) : Promise.resolve(null),
    ]);
    if (!user || user.epoch !== (session.epoch ?? 0) || !user.grants[session.tenant]?.includes(session.role)
      || (session.act && (!actor || actor.epoch !== (session.act.epoch ?? 0)
        || !Object.values(actor.grants).some(roles => roles.includes('admin'))))) {
      throw new AppError(401, 'The session is no longer current. Sign in again.');
    }
    return { displayName: user.displayName, grants: user.grants };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'The identity store is unavailable');
  }
}

export function callContextSession(ctx: Record<string, unknown> | undefined, tenants: readonly CallTenant[] = ORGIQ_ONLY): Session | null {
  if (!ctx || typeof ctx.userId !== 'string' || !tenants.includes(ctx.org as CallTenant) || typeof ctx.role !== 'string') return null;
  const tenant = ctx.org as CallTenant;
  if (!Number.isSafeInteger(ctx.epoch) || Number(ctx.epoch) < 0) return null;
  const act = ctx.act as { sub?: unknown; epoch?: unknown } | undefined;
  if (act && (typeof act.sub !== 'string' || !Number.isSafeInteger(act.epoch) || Number(act.epoch) < 0)) return null;
  return {
    sub: ctx.userId, name: typeof ctx.displayName === 'string' ? ctx.displayName : undefined,
    tenant, role: ctx.role as Session['role'], epoch: Number(ctx.epoch),
    grants: { [tenant]: [ctx.role] }, iat: Number(ctx.sessionIat) || 0,
    ...(act ? { act: { sub: act.sub as string, epoch: Number(act.epoch), role: 'admin' as const,
      tenant, grants: {} } } : {}),
  };
}
export function callProvenance(session: Session): string {
  return JSON.stringify([session.sub, session.tenant, session.role, session.epoch ?? 0, session.act?.sub ?? null, session.act?.epoch ?? 0]);
}
export function connectedCallSession(router: RealtimeRouter, clientId: string, tenants: readonly CallTenant[] = ORGIQ_ONLY): Session | null {
  return router.isClientLive?.(clientId) === true ? callContextSession(router.getClientData?.(clientId)?.userContext, tenants) : null;
}
/** REST-originated readers need the owning replica's current registration.
 * Keep the synchronous helper for immediate local disconnect invalidation. */
export async function resolveConnectedCallSession(router: RealtimeRouter, clientId: string, tenants: readonly CallTenant[] = ORGIQ_ONLY): Promise<Session | null> {
  if (!router.resolveClientData) return connectedCallSession(router, clientId, tenants);
  try {
    const data = await router.resolveClientData(clientId);
    if (!data?.userContext || router.getClientData?.(clientId)?.userContext !== data.userContext) return null;
    return callContextSession(data.userContext, tenants);
  } catch { throw new AppError(503, 'The call connection directory is unavailable'); }
}

export interface CallAccessOptions {
  calls: CallStateStore;
  router: RealtimeRouter;
  lobbyAllowed: (auth: Record<string, unknown>, lobby: string) => boolean;
  authority?: (session: Session) => Promise<CallAuthority>;
}
export async function activeCallParticipant(opts: CallAccessOptions, callId: string, session: Session,
  options: { allowAssessmentDocument?: boolean } = {}): Promise<{
  call: ActiveCallStateView; authority: CallAuthority; clientIds: string[];
}> {
  const readAuthority = opts.authority ?? (value => currentCallAuthority(value, HUDDLE_CHAT_TENANTS));
  const authority = await readAuthority(session);
  const call = await opts.calls.getCall(callId);
  if (!call) throw new AppError(404, 'Call is no longer active');
  // A huddle belongs to its lobby's tenant; a session standing elsewhere is not a seat of it.
  const tenant = huddleLobbyTenant(call.lobbyName)
    ?? (options.allowAssessmentDocument && /^assessment:doc:[A-Za-z0-9:_-]{1,256}$/.test(call.lobbyName) ? 'assessment' : null);
  if (!tenant) throw new AppError(403, 'This call requires an OrgIQ lobby');
  if (tenant !== session.tenant) throw new AppError(403, 'Join this call before opening its conversation');
  const key = callProvenance(session);
  const connected = await Promise.all(call.participantClientIds.map(id => resolveConnectedCallSession(opts.router, id, HUDDLE_CHAT_TENANTS)));
  const clientIds = call.participantClientIds.filter((_, index) => connected[index] && callProvenance(connected[index]!) === key);
  if (!clientIds.length || !opts.lobbyAllowed({ userId: session.sub, org: session.tenant, role: session.role,
    tenants: Object.keys(authority.grants) }, call.lobbyName)) throw new AppError(403, 'Join this call before opening its conversation');
  // A distributed connection-directory read can outlive identity revocation.
  const latest = await readAuthority(session);
  if (!opts.lobbyAllowed({ userId: session.sub, org: session.tenant, role: session.role,
    tenants: Object.keys(latest.grants) }, call.lobbyName)) throw new AppError(403, 'Join this call before opening its conversation');
  return { call, authority: latest, clientIds };
}

/**
 * A seated huddle participant speaks and chats under the stored lobby's read
 * authority. This is neither Social embedding nor a page-discussion write:
 * an OrgIQ member may join/chat without PostMessage or DispatchAgentRun.
 * The action selectors are kept for the runtime's read/write contract; both
 * require the same lobby authority, with the actual seat checked separately.
 */
export async function currentCallChatGrant(session: Session, authority: CallAuthority, _action: 'ViewSocial' | 'PostMessage',
  lobbyName: string): Promise<boolean> {
  const tenant = huddleLobbyTenant(lobbyName);
  if (!tenant || session.tenant !== tenant || !authority.grants[tenant]?.includes(session.role)) return false;
  const family = tenantChannelFamily(lobbyName);
  // DMs have no tenant family; the caller's ID membership is lobbyGuard's.
  if (!family) return tenant === 'orgiq' && /^orgiq:dm:[^:]+(?::[^:]+)+$/.test(lobbyName);
  if (!family.lobby || family.tenant !== tenant || !await holdsChannelAuthority({ ...session, grants: authority.grants }, family.read)) return false;
  return !family.lobbyResource || await pageResourceVisible(family.lobbyResource, lobbyName);
}
