// Proof of the current accepted gateway seat, for the native media service's
// immutable participant binding. This neither creates a seat nor grants access.
import { AppError } from './async-handler.js';
import { activeCallParticipant, currentCallChatGrant, type CallAuthority, type CallAccessOptions } from './call-access.js';
import { admitLobbyRead, admitMeetingRoom, splitMeetingRoom } from './gateway/authority.js';
import { currentLiveSession, sessionGatewayContext } from './live-principal.js';
import type { Session } from './session.js';
import { assessmentSourceFromCallChannel, readAssessmentDocument } from './assessment-document-context.js';

export interface CallMediaSeatProof {
  allowed: true; callId: string; lobbyName: string; clientId: string; userId: string;
  tenant: string; epoch: number; actor?: { sub: string; epoch: number };
  documentContext?: { tenant: 'assessment'; sourceId: string; lobbyName: string };
}
export class CallMediaProofRuntime {
  constructor(private readonly options: CallAccessOptions) {}
  private async hostAllowed(session: Session, authority: CallAuthority, lobbyName: string): Promise<boolean> {
    // DMs have no page-family read route. Reuse the huddle's existing named
    // participant read rule; activeCallParticipant also applies lobbyGuard.
    if (/^orgiq:dm:[^:]+(?::[^:]+)+$/.test(lobbyName)) return currentCallChatGrant(session, authority, 'ViewSocial', lobbyName);
    return await admitLobbyRead(sessionGatewayContext(session), lobbyName) === 'ok';
  }
  /**
   * The seat proof for `lobbyName`, which is the call's own lobby or one of
   * its meeting rooms (`<call lobby>~breakout~<room>`, docs/meeting-rooms-app-goal.md
   * B3): a room's media leg is the same call's seat, so every check below
   * runs on the call's lobby, and the room must admit this user now at each
   * re-read. The proof names the lobby asked for, the one the leg is in.
   */
  async get(session: Session, callId: string, lobbyName: string, clientId: string, documentSourceId?: string): Promise<CallMediaSeatProof> {
    const room = splitMeetingRoom(lobbyName);
    if (room === false) throw new AppError(403, 'Accepted call seat required');
    const callLobby = room ? room.base : lobbyName;
    const roomAllowed = async (userId: string): Promise<boolean> => !room || admitMeetingRoom(userId, lobbyName);
    const isDocument = lobbyName.startsWith('assessment:doc:');
    if (isDocument !== (documentSourceId !== undefined)) throw new AppError(403, 'Verified document call source required');
    const seatOptions = { allowAssessmentDocument: isDocument };
    const documentAllowed = async (channel: unknown): Promise<boolean> => !isDocument || (session.tenant === 'assessment'
      && assessmentSourceFromCallChannel(channel) === documentSourceId
      && !!await readAssessmentDocument(documentSourceId!, lobbyName));
    let current = await currentLiveSession(session);
    const accepted = this.options.calls.isAccepted;
    if (!accepted || !await accepted.call(this.options.calls, callId)) throw new AppError(403, 'Accepted call seat required');
    const first = await activeCallParticipant(this.options, callId, current, seatOptions);
    if (first.call.lobbyName !== callLobby || !first.clientIds.includes(clientId)
      || !await this.hostAllowed(current, first.authority, callLobby)
      || !await roomAllowed(current.sub)
      || !await documentAllowed(first.call.channel)) throw new AppError(403, 'Accepted call seat required');
    // Directory/resource I/O can outlive leaving, socket replacement, a tenant
    // switch or a terminal call. Re-read all proofs immediately before reply.
    current = await currentLiveSession(current);
    const latest = await activeCallParticipant(this.options, callId, current, seatOptions);
    if (latest.call.lobbyName !== callLobby || !latest.clientIds.includes(clientId)
      || !await accepted.call(this.options.calls, callId)
      || !await this.hostAllowed(current, latest.authority, callLobby)
      || !await roomAllowed(current.sub)
      || !await documentAllowed(latest.call.channel)) throw new AppError(403, 'Accepted call seat required');
    current = await currentLiveSession(current);
    const final = await activeCallParticipant(this.options, callId, current, seatOptions);
    if (final.call.lobbyName !== callLobby || !final.clientIds.includes(clientId)
      || !await accepted.call(this.options.calls, callId)
      || (isDocument && assessmentSourceFromCallChannel(final.call.channel) !== documentSourceId)) throw new AppError(403, 'Accepted call seat required');
    return { allowed: true, callId, lobbyName, clientId, userId: current.sub, tenant: current.tenant, epoch: current.epoch ?? 0,
      ...(current.act ? { actor: { sub: current.act.sub, epoch: current.act.epoch ?? 0 } } : {}),
      ...(isDocument ? { documentContext: { tenant: 'assessment' as const, sourceId: documentSourceId!, lobbyName } } : {}) };
  }
}
let runtime: CallMediaProofRuntime | null = null;
export function setCallMediaProofRuntime(value: CallMediaProofRuntime | null): void { runtime = value; }
export function callMediaProofRuntime(): CallMediaProofRuntime {
  if (!runtime) throw new AppError(503, 'Call seat authority is unavailable');
  return runtime;
}
