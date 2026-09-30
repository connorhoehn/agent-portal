// Starting a call from a social page (docs/social-tenant-design.md §4.5).
//
// Not a second call stack: the one the shell hosts (SocialLayout →
// projects/InitiativeCallHost), which draws the dock. A page names WHERE:
//
//   - a room: its lobby `social:room:<slug>`, nobody rung — `start([])` opens
//     (or, through platform-api's session reuse, walks into) the room's call,
//     and platform-api's lobby check admits a private room's members only;
//   - people: the DM lobby `social:dm:<sorted ids>`, and they are rung.
//
// The host's hook reads its lobby from props, so a page binds first and starts
// once the binding has landed (the effect below), the way the document call
// does it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInitiativeCallHost } from '../projects/InitiativeCallHost';
import { callAvailability } from '../../lib/conversationCallModel';
import { dmLobby, roomLobby } from './socialPlatform';

type Pending = { lobbyName: string; targets: { userId: string; displayName: string }[] };

export interface SocialCall {
  /** Why a call cannot start right now, or null. */
  unavailable: string | null;
  /** The lobby of the call in progress, if any. */
  activeLobby: string | null;
  joinRoom: (room: { slug: string; name: string }) => void;
  callPeople: (people: { userId: string; displayName: string }[]) => void;
  leave: () => void;
  notice: string | null;
  clearNotice: () => void;
}

export function useSocialCall(): SocialCall {
  const host = useInitiativeCallHost();
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const call = host?.call ?? null;
  const bound = host?.lobby?.lobbyName ?? null;
  const inCall = !!call && call.phase !== 'idle' && call.phase !== 'ended' && call.phase !== 'failed';

  const availability = host
    ? callAvailability({
      gatewayConfigured: host.gatewayConfigured, connectionState: host.connectionState, platformApiUrl: host.platformApiUrl,
      signedIn: !!host.self, usersLoaded: true, targets: [{ userId: 'room', displayName: 'room' }],
    })
    : { ok: false as const, reason: 'Calls are not available here' };

  // Start once the host is bound to the lobby this page asked for.
  const start = call?.start;
  const rejoin = call?.rejoin;
  const live = call?.phase === 'idle' && !!call.call;
  useEffect(() => {
    const want = pending.current;
    if (!want || bound !== want.lobbyName || !start) return;
    pending.current = null;
    // A live call in this lobby (discovered by the host): walk into it.
    if (live && rejoin) void rejoin();
    else void start(want.targets);
  }, [bound, start, rejoin, live]);

  const begin = useCallback((lobbyName: string, title: string, channel: string, targets: Pending['targets']) => {
    if (!host) return;
    if (!availability.ok) { setNotice(availability.reason); return; }
    if (inCall) { setNotice(bound === lobbyName ? 'You are already in this call.' : 'You are already in a call. Leave it first.'); return; }
    setNotice(null);
    pending.current = { lobbyName, targets };
    host.bind({ lobbyName, title, channel });
    // Already bound to this lobby: the effect will not re-run, so start now.
    if (bound === lobbyName && host.call) {
      pending.current = null;
      if (live) void host.call.rejoin();
      else void host.call.start(targets);
    }
  }, [host, availability.ok, availability.ok ? null : availability.reason, inCall, bound, live]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    unavailable: availability.ok ? null : availability.reason,
    activeLobby: inCall ? bound : null,
    joinRoom: (room) => { const lobby = roomLobby(room.slug); begin(lobby, room.name, lobby, []); },
    callPeople: (people) => {
      const self = host?.self?.userId;
      const others = people.filter((p) => p.userId && p.userId !== self);
      if (!self || !others.length) { setNotice('Pick someone other than yourself to call.'); return; }
      const lobby = dmLobby([self, ...others.map((p) => p.userId)]);
      begin(lobby, others.map((p) => p.displayName).join(', '), lobby, others);
    },
    leave: () => { if (call) void call.leave(); },
    notice,
    clearNotice: () => setNotice(null),
  };
}
