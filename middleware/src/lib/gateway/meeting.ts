// The meeting feature on the /ws gateway (docs/meeting-rooms-app-goal.md M2):
// raised hands and breakout rooms for a call already running, the library's
// `meeting()` configured with this host's organizer rule, its store and one
// activity row per breakout session. A meeting IS a call: its id is the call's
// lobby (decision 1). Who may enter a room's media or chat is the authority
// facade's (lib/gateway/authority.ts `admitMeetingRoom`, `lobbyGuard`, the
// `meeting-room` namespace), which asks the service this feature registers.

import { RedisMeetingStateStore, meeting, type MeetingConfig, type MeetingState, type MeetingStateSubscriber } from '@connorhoehnslalom/realtime-modules/meeting';
import type { RealtimeFeature } from '@connorhoehnslalom/realtime-modules/server';
import type { CallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import { meetingOrganizer } from './authority.js';
import { publishChannelActivity } from '../gateway-run-feed.js';
import type { GatewayRedisStore } from '../redis-lite.js';

export interface MeetingFeatureOptions {
  /** The gateway's call state (the stored call's caller is an organizer). */
  calls: Pick<CallStateStore, 'getCall' | 'getCallIdsByClient'>;
  /** A socket's auth context, or null once it closed. */
  getCtx(clientId: string): Record<string, unknown> | null;
  /** The gateway's Redis when it routes as a cluster; memory otherwise (decision 6). */
  redis?: GatewayRedisStore | null;
  /** The cluster's dedicated pub/sub, so every replica's room mirror follows a write. */
  subscriber?: MeetingStateSubscriber | null;
  /** The Redis key prefix (REALTIME_GATEWAY_NAMESPACE). */
  namespace?: string;
}

/** The stored call in `lobby` this socket sits in, if any: whose caller organizes the meeting. */
async function callIn(calls: MeetingFeatureOptions['calls'], clientId: string, lobby: string) {
  for (const callId of clientId ? await calls.getCallIdsByClient(clientId) : []) {
    const call = await calls.getCall(callId);
    if (call?.lobbyName === lobby) return call;
  }
  return null;
}

/**
 * One activity row on the meeting's lobby when its breakout session opens
 * (the first room open) and when it closes (no room open), never per room,
 * per assignment or per hand. The row reaches only a lobby some family lists
 * (`publishChannelActivity`); Social and DM lobbies have no activity channel.
 */
export function breakoutActivity(): NonNullable<MeetingConfig['onChange']> {
  const open = new Set<string>();
  return ({ meetingId, userId, state }: { meetingId: string; userId: string; state: Readonly<MeetingState> }) => {
    const nowOpen = state.breakout.phase === 'open';
    if (nowOpen === open.has(meetingId)) return;
    if (nowOpen) open.add(meetingId); else open.delete(meetingId);
    const rooms = state.breakout.rooms.filter(room => room.state === 'open').length;
    // `system` is the library's breakout timer closing the rooms.
    const actor = userId && userId !== 'system' ? { userId } : undefined;
    void publishChannelActivity(meetingId, nowOpen ? 'breakout.opened' : 'breakout.closed', nowOpen ? { rooms } : {}, actor);
  };
}

/** The library's `meeting()` under this host's organizer rule and store. Rate limits are the library's defaults. */
export function tenantMeeting(opts: MeetingFeatureOptions): RealtimeFeature {
  return meeting({
    ...(opts.redis ? { store: new RedisMeetingStateStore({ get: key => opts.redis!.get(key) as Promise<string | null>,
      del: (...keys) => opts.redis!.del(...keys), command: (...args) => opts.redis!.command(...args) },
    { prefix: `${opts.namespace ?? 'orgiq-gateway'}:meeting:`, ...(opts.subscriber ? { subscriber: opts.subscriber } : {}) }) } : {}),
    // The asking socket must still be the user the library names.
    isOrganizer: async ({ meetingId, userId, clientId }) => {
      const ctx = opts.getCtx(clientId);
      if (!ctx || ctx['userId'] !== userId) return false;
      return meetingOrganizer(ctx, meetingId, await callIn(opts.calls, clientId, meetingId));
    },
    onChange: breakoutActivity(),
  });
}
