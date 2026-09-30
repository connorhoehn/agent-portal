// The social call log's writer (docs/social-tenant-design.md §4.4, lane S2).
//
// platform-api keeps the call history (`/api/calls/log`, CallLogRepository),
// but only clients report to it — `POST /api/calls/log/events`, an idempotent
// reducer — and no library hook does (realtime-examples' own useCallLog lives
// in its frontend; queued in docs/ui-components-queue.md). So the social call
// host reports its own events, as that frontend does:
//
//   - a room is a PLACE: walking in is `joined` (platform-api writes only the
//     reporter's row for it), leaving is `ended`;
//   - a call you started: `invite` then `accepted` once someone answers, or
//     `invite` then `missed` when nobody did — the caller's report is the
//     shared fact and writes every rung person's row;
//   - a call you answered: `accepted`, naming its host as the caller;
//   - either side's hang-up: `ended`.
//
// Pure: `callLogEvents` builds the bodies, `reportCallLogEvents` posts them
// fire-and-forget (a lost report costs one history row, never the call).

import { dmIds, roomSlugFromLobby } from './socialPlatform.ts';

export type CallLogAction = 'invite' | 'accepted' | 'ended' | 'missed' | 'joined';

export interface CallLogEventBody {
  callId: string;
  action: CallLogAction;
  callerId: string;
  callerName?: string;
  targetUserIds: string[];
  lobbyName: string;
}

export interface CallHostEventLike {
  callId: string;
  lobbyName: string;
  peerUserIds: string[];
  direction?: 'outgoing' | 'incoming';
}

/** Only `social:` lobbies are the social log's to write. */
const isSocial = (lobby: string) => lobby.startsWith('social:');

export function callLogEvents(
  kind: 'started' | 'ended' | 'missed',
  e: CallHostEventLike,
  ctx: { host: string | null; selfId: string; selfName?: string },
): CallLogEventBody[] {
  if (!ctx.selfId || !e.callId || !isSocial(e.lobbyName)) return [];
  const base = { callId: e.callId, lobbyName: e.lobbyName };
  const me = { callerId: ctx.selfId, ...(ctx.selfName ? { callerName: ctx.selfName } : {}) };
  if (roomSlugFromLobby(e.lobbyName)) {
    if (kind === 'started') return [{ ...base, ...me, action: 'joined', targetUserIds: [] }];
    if (kind === 'ended') return [{ ...base, ...me, action: 'ended', targetUserIds: [] }];
    return [];
  }
  if (!dmIds(e.lobbyName)) return [];
  const peers = e.peerUserIds.filter((id) => id && id !== ctx.selfId);
  const mine = !ctx.host || ctx.host === ctx.selfId;
  if (kind === 'missed') {
    // The callee's side of a missed ring is written by the caller's report.
    return e.direction === 'outgoing' && peers.length
      ? [{ ...base, ...me, action: 'invite', targetUserIds: peers }, { ...base, ...me, action: 'missed', targetUserIds: peers }]
      : [];
  }
  if (kind === 'started') {
    return mine
      ? [{ ...base, ...me, action: 'invite', targetUserIds: peers }, { ...base, ...me, action: 'accepted', targetUserIds: peers }]
      : [{ ...base, callerId: ctx.host!, action: 'accepted', targetUserIds: [ctx.selfId] }];
  }
  return [mine
    ? { ...base, ...me, action: 'ended', targetUserIds: peers }
    : { ...base, callerId: ctx.host!, action: 'ended', targetUserIds: [ctx.selfId] }];
}

export async function reportCallLogEvents(
  events: CallLogEventBody[],
  opts: { baseUrl: string | null; getToken: () => Promise<string>; fetchImpl?: typeof fetch },
): Promise<void> {
  if (!events.length || !opts.baseUrl) return;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const token = await opts.getToken();
    // In order: `invite` before `accepted`/`missed`, so the row exists to update.
    for (const event of events) {
      await doFetch(`${opts.baseUrl}/api/calls/log/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...event, at: new Date().toISOString() }),
      });
    }
  } catch {
    // Fire-and-forget: the reducer is idempotent, and the call itself is unaffected.
  }
}
