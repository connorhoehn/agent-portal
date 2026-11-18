// The interview call's loss, for both sides of the room (the panel's InterviewRoomPage, the candidate's JoinRoom). The rules
// are lib/interviewsRoom.ts's (`nextCallLoss`, the lost call section); this hook feeds them what the call host and the raw
// gateway frames say, leaves the dead call, and joins the call that is on in the lobby once it is back.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCallHost } from './conversationCall';
import { useGatewayFrames } from './gatewayFrames';
import { holdsLostCall, nextCallLoss, refusedCallOf, rejoinsAfterLoss, type CallLoss, type CallLossEvent } from './interviewsRoom.ts';

const HELD = new Set(['calling', 'connecting', 'live', 'reconnecting']);

export interface InterviewCallLoss {
  /** The call this viewer lost while the interview is live; null when nothing is lost. */
  loss: CallLoss | null;
  /** The lead's restart: the bound start, the same one the first join ran (the interview record is unchanged). */
  restart: (() => void) | null;
}

/** `lobbyName` is the interview's lobby while the interview is live (null otherwise: nothing can be lost then). */
export function useInterviewCallLoss(lobbyName: string | null): InterviewCallLoss {
  const host = useCallHost();
  const { gateway } = useGatewayFrames();
  const here = !!lobbyName && host?.lobby?.lobbyName === lobbyName;
  const phase = host?.call.phase ?? 'idle';
  const held = here && HELD.has(phase) ? host?.call.call?.callId ?? null : null;
  // The lobby's live call while this client holds none (the library's discovery of the lobby).
  const lobbyCallId = here && (phase === 'idle' || phase === 'ended') ? host?.call.call?.callId ?? null : null;
  const joinedCallId = here && (phase === 'live' || phase === 'reconnecting') ? held : null;

  const [loss, setLoss] = useState<CallLoss | null>(null);
  const lastJoined = useRef<string | null>(null);
  const apply = useCallback((event: CallLossEvent) => setLoss((prev) => nextCallLoss(prev, event, lastJoined.current)), []);

  useEffect(() => { if (!lobbyName) { lastJoined.current = null; apply({ kind: 'closed' }); } }, [lobbyName, apply]);
  useEffect(() => {
    if (!joinedCallId) return;
    lastJoined.current = joinedCallId;
    apply({ kind: 'joined', callId: joinedCallId });
  }, [joinedCallId, apply]);
  // The library tears a call down on a server end it hears (the others' sockets were up): its reason says nobody chose it.
  const endedReason = here && phase === 'ended' ? host?.call.ended?.reason ?? null : null;
  useEffect(() => {
    if (endedReason && lastJoined.current) apply({ kind: 'ended', callId: lastJoined.current, reason: endedReason });
  }, [endedReason, apply]);
  // The call service's refusals arrive only as raw frames (the library's call hook reads its invitation refusals alone).
  const listen = gateway.onMessage;
  useEffect(() => {
    if (!lobbyName) return;
    return listen((frame) => {
      const callId = refusedCallOf(frame);
      if (callId) apply({ kind: 'refused', callId });
    });
  }, [listen, lobbyName, apply]);

  // Leave the dead call once: its clock and its "2 joined" stop, and the next call can be joined.
  const leave = host?.call.leave;
  useEffect(() => { if (holdsLostCall(loss, held)) void leave?.(); }, [loss, held, leave]);
  // Join the call that is on in the lobby (the lead's restart, or the others' call that went on).
  const rejoin = host?.call.rejoin;
  useEffect(() => { if (rejoinsAfterLoss(loss, lobbyCallId)) void rejoin?.(); }, [loss, lobbyCallId, rejoin]);

  return { loss: lobbyName ? loss : null, restart: host?.startBound ?? null };
}
