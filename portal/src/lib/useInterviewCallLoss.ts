// The interview call's loss, for both sides of the room (the panel's InterviewRoomPage, the candidate's JoinRoom). The rules
// are lib/interviewsRoom.ts's (`nextCallLoss`, the lost call section); this hook feeds them what the call host and the raw
// gateway frames say, leaves the dead call, and joins the call that is on in the lobby once it is back.
//
// The server's answer is what decides, never a wait: every reconnect re-sends `watch` for the lobby and the call service answers
// with the lobby's occupancy. A client whose media did not come back reads "connecting" and re-announces nothing, so a refusal may
// never come; the occupancy snapshot always does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseLobbyOccupancy } from '@connorhoehn/realtime-modules/client/video';
import { useCallHost } from './conversationCall';
import { useGatewayFrames } from './gatewayFrames';
import { holdsLostCall, nextCallLoss, refusedCallOf, rejoinsAfterLoss, seatConfirmed, type CallLoss, type CallLossEvent } from './interviewsRoom.ts';

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
  // The call this viewer is seated in: its media came up (live), or the server reported it live in the lobby (below). Only that call
  // can be lost, so a call still being started (connecting, not yet seated) is never mistaken for a lost one.
  const seat = useCallback((callId: string) => { lastJoined.current = callId; apply({ kind: 'joined', callId }); }, [apply]);
  useEffect(() => { if (joinedCallId) seat(joinedCallId); }, [joinedCallId, seat]);
  // The library tears a call down on a server end it hears (the others' sockets were up): its reason says nobody chose it.
  const endedReason = here && phase === 'ended' ? host?.call.ended?.reason ?? null : null;
  useEffect(() => {
    if (endedReason && lastJoined.current) apply({ kind: 'ended', callId: lastJoined.current, reason: endedReason });
  }, [endedReason, apply]);
  // The server's word on the call, as raw frames: its refusals (the library's call hook reads its invitation refusals alone), and the
  // lobby's occupancy, which answers every reconnect's `watch` (the library only uses it to discover a call it does not hold).
  const heldRef = useRef(held);
  heldRef.current = held;
  const listen = gateway.onMessage;
  useEffect(() => {
    if (!lobbyName) return;
    return listen((frame) => {
      const callId = refusedCallOf(frame);
      if (callId) { apply({ kind: 'refused', callId }); return; }
      const f = frame as { type?: unknown; action?: unknown; data?: unknown };
      if (f?.type !== 'call' || f.action !== 'lobby-occupancy') return;
      const occ = parseLobbyOccupancy(f.data);
      if (occ?.lobbyName !== lobbyName) return;
      const lobbyCall = occ.active ? occ.callId : null;
      // The server reports this client's call live in the lobby: it is seated there, whatever its media is doing.
      if (seatConfirmed(lobbyCall, heldRef.current)) seat(lobbyCall!);
      else apply({ kind: 'lobby', callId: lobbyCall, held: heldRef.current });
    });
  }, [listen, lobbyName, apply, seat]);

  // Leave the dead call once: its clock and its "2 joined" stop, and the next call can be joined.
  const leave = host?.call.leave;
  useEffect(() => { if (holdsLostCall(loss, held)) void leave?.(); }, [loss, held, leave]);
  // Join the call that is on in the lobby (the lead's restart, or the others' call that went on).
  const rejoin = host?.call.rejoin;
  useEffect(() => { if (rejoinsAfterLoss(loss, lobbyCallId)) void rejoin?.(); }, [loss, lobbyCallId, rejoin]);

  return { loss: lobbyName ? loss : null, restart: host?.startBound ?? null };
}
