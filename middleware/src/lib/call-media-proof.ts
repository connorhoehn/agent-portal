// Proof of the current accepted gateway seat, for the native media service's
// immutable participant binding. This neither creates a seat nor grants access.
import { AppError } from './async-handler.js';
import { activeCallParticipant, currentCallChatGrant, type CallAuthority, type CallAccessOptions } from './call-access.js';
import { admitLobbyRead } from './gateway/authority.js';
import { currentLiveSession, sessionGatewayContext } from './live-principal.js';
import type { Session } from './session.js';

export interface CallMediaSeatProof {
  allowed: true; callId: string; lobbyName: string; clientId: string; userId: string;
  tenant: string; epoch: number; actor?: { sub: string; epoch: number };
}
export class CallMediaProofRuntime {
  constructor(private readonly options: CallAccessOptions) {}
  private async hostAllowed(session: Session, authority: CallAuthority, lobbyName: string): Promise<boolean> {
    // DMs have no page-family read route. Reuse the huddle's existing named
    // participant read rule; activeCallParticipant also applies lobbyGuard.
    if (/^orgiq:dm:[^:]+(?::[^:]+)+$/.test(lobbyName)) return currentCallChatGrant(session, authority, 'ViewSocial', lobbyName);
    return await admitLobbyRead(sessionGatewayContext(session), lobbyName) === 'ok';
  }
  async get(session: Session, callId: string, lobbyName: string, clientId: string): Promise<CallMediaSeatProof> {
    let current = await currentLiveSession(session);
    const accepted = this.options.calls.isAccepted;
    if (!accepted || !await accepted.call(this.options.calls, callId)) throw new AppError(403, 'Accepted call seat required');
    const first = await activeCallParticipant(this.options, callId, current);
    if (first.call.lobbyName !== lobbyName || !first.clientIds.includes(clientId)
      || !await this.hostAllowed(current, first.authority, lobbyName)) throw new AppError(403, 'Accepted call seat required');
    // Directory/resource I/O can outlive leaving, socket replacement, a tenant
    // switch or a terminal call. Re-read all proofs immediately before reply.
    current = await currentLiveSession(current);
    const latest = await activeCallParticipant(this.options, callId, current);
    if (latest.call.lobbyName !== lobbyName || !latest.clientIds.includes(clientId)
      || !await accepted.call(this.options.calls, callId)
      || !await this.hostAllowed(current, latest.authority, lobbyName)) throw new AppError(403, 'Accepted call seat required');
    current = await currentLiveSession(current);
    const final = await activeCallParticipant(this.options, callId, current);
    if (final.call.lobbyName !== lobbyName || !final.clientIds.includes(clientId)
      || !await accepted.call(this.options.calls, callId)) throw new AppError(403, 'Accepted call seat required');
    return { allowed: true, callId, lobbyName, clientId, userId: current.sub, tenant: current.tenant, epoch: current.epoch ?? 0,
      ...(current.act ? { actor: { sub: current.act.sub, epoch: current.act.epoch ?? 0 } } : {}) };
  }
}
let runtime: CallMediaProofRuntime | null = null;
export function setCallMediaProofRuntime(value: CallMediaProofRuntime | null): void { runtime = value; }
export function callMediaProofRuntime(): CallMediaProofRuntime {
  if (!runtime) throw new AppError(503, 'Call seat authority is unavailable');
  return runtime;
}
