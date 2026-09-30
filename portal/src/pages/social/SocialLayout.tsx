// The social tenant's route parent (docs/social-tenant-design.md §4).
//
// Its hierarchy is the shell rail (NAV_ITEMS in components/shell/Layout.tsx,
// grouped Talk / Meet / People / Library / System), exactly as the assessment
// tenant's is, so there is no second rail here. App.tsx wraps this in
// `RequireTenant tenant="social"`.
//
// Since lane S2 it also hosts, for every social page:
//
//   - the tenant's call — the shell call host the orgiq and assessment shells
//     use (projects/InitiativeCallHost): ONE useConversationCall, so a room
//     call or a DM call keeps going while you move between pages, and an
//     incoming ring reaches you on any social page (its toast). The dock is
//     drawn HERE, above whichever page is open, so a call never needs its
//     page: nothing navigates on Accept;
//   - the call log's writer (socialCallLog.ts): platform-api keeps the log,
//     clients report to it — the host's callbacks for rung calls, and
//     RoomCallLog for a room walked into alone (no callback fires for that);
//   - presence: everyone standing in the workspace announces on
//     `social:lobby`, which is what Contacts shows as "here now".

import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { useSession } from '../../lib/auth';
import { realtimeTokenSource } from '../../lib/realtimeToken';
import { useRealtimeEndpoints } from '../../lib/useRealtimeEndpoints';
import { ConversationCallDock } from '../../lib/conversationCall';
import { InitiativeCallHost, useInitiativeCallHost, type OnCallHostEvent } from '../projects/InitiativeCallHost';
import { callLogEvents, reportCallLogEvents } from './socialCallLog';
import { roomSlugFromLobby, SOCIAL_PRESENCE_CHANNEL } from './socialPlatform';

/**
 * The call, wherever you are in the workspace: a room call or a DM call is
 * drawn here — above whichever page is open — from the moment it starts until
 * you leave it, so moving between pages never hides it.
 */
function SocialCallDock() {
  const host = useInitiativeCallHost();
  const navigate = useNavigate();
  if (!host || !host.lobby || host.call.phase === 'idle') return null;
  return (
    <ConversationCallDock
      call={host.call}
      title={host.lobby.title}
      onOpenPeople={() => navigate('/social/contacts')}
      selfName={host.self?.displayName ?? ''}
      compact
      data-testid="social-call-dock"
    />
  );
}

/**
 * A room is a place: walking in alone never "starts" a call in the hook's
 * sense (nobody answers), so no callback fires. Report the room's `joined`
 * when the call goes live and `ended` when it is over, off the phase.
 */
function RoomCallLog({ report }: { report: OnCallHostEvent }) {
  const host = useInitiativeCallHost();
  const phase = host?.call.phase ?? 'idle';
  const callId = host?.call.call?.callId ?? null;
  const lobbyName = host?.lobby?.lobbyName ?? null;
  const selfId = host?.self?.userId ?? '';
  const joined = useRef<{ callId: string; lobbyName: string } | null>(null);
  useEffect(() => {
    if (!lobbyName || !roomSlugFromLobby(lobbyName)) return;
    if (phase === 'live' && callId && joined.current?.callId !== callId) {
      joined.current = { callId, lobbyName };
      report('started', { callId, lobbyName, channel: lobbyName, peerUserIds: [] }, { host: selfId, selfId });
    } else if ((phase === 'idle' || phase === 'ended' || phase === 'failed') && joined.current) {
      const was = joined.current;
      joined.current = null;
      report('ended', { callId: was.callId, lobbyName: was.lobbyName, channel: was.lobbyName, peerUserIds: [] }, { host: selfId, selfId });
    }
  }, [phase, callId, lobbyName, selfId, report]);
  return null;
}

/** Be present in the workspace while any social page is open. */
function WorkspacePresence() {
  usePresence(SOCIAL_PRESENCE_CHANNEL, { join: true });
  return null;
}

const getToken = async () => (await realtimeTokenSource.get()).token;

export default function SocialLayout() {
  const { session } = useSession();
  const { platformApiUrl } = useRealtimeEndpoints(!!session);
  const baseRef = useRef(platformApiUrl);
  baseRef.current = platformApiUrl;
  const nameRef = useRef(session?.name ?? '');
  nameRef.current = session?.name ?? '';
  const onCallEvent = useCallback<OnCallHostEvent>((kind, event, ctx) => {
    const events = callLogEvents(kind, event, { ...ctx, ...(nameRef.current ? { selfName: nameRef.current } : {}) });
    void reportCallLogEvents(events, { baseUrl: baseRef.current, getToken });
  }, []);
  return (
    <InitiativeCallHost onCallEvent={onCallEvent}>
      <WorkspacePresence />
      <RoomCallLog report={onCallEvent} />
      <Stack gap="md">
        <SocialCallDock />
        <Outlet />
      </Stack>
    </InitiativeCallHost>
  );
}
