// The calls feature on the /ws gateway: the library's `calls()` configured
// with this host's admission (lib/gateway/authority.ts `admitCall`) and the
// missed-call producer (docs/social-tenant-design.md §3.4 row 6). The call-page
// and huddle-chat runtimes that observe a call's lifecycle are composed in
// lib/realtime-gateway.ts and reached here through accessors.
//
// realtime-modules 0.116 owns three things this file used to do by hand:
//   - `verifyCaller` (default on): an invite must name the socket's
//     authenticated user as `callerId` — the engine checks it again in
//     `admitCall`;
//   - `refuseEmptyTargets` (default on): an untargeted invite, which would ring
//     every connected client in every tenant, is refused (was `canCall`);
//   - `onCallMissed` carries `targetUserIds` and `channel` (was the invite
//     ledger `recordInvite`).

import { calls, type RealtimeFeature, type RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import type { CallCrossNodePubSub, CallStateStore } from '@connorhoehn/realtime-modules/call';
import { conversationHref, notify, pageHuddleHref, parseDmLobby } from '../social-notify.js';
import { admitCall, callGuards, lobbyGuard } from './authority.js';

const MISSED_BODY: Record<string, string> = {
  cancelled: 'The call ended before anyone answered.',
  declined: 'The call was declined.',
  'no-answer': 'Nobody answered.',
};

/** Row 6: an invite that never became a call → its targets (the library's rung set, else a DM lobby's other members). */
export async function notifyMissedCall(summary: { callId: string; lobbyName: string; callerId: string; callerName?: string; reason: string;
  targetUserIds?: string[]; channel?: string }): Promise<void> {
  const tenant = summary.lobbyName.split(':')[0] ?? '';
  if (!tenant) return;
  const dm = parseDmLobby(summary.lobbyName);
  const targets = (summary.targetUserIds?.length ? summary.targetUserIds : dm?.members ?? []).filter((u) => u !== summary.callerId);
  if (!targets.length) return;
  const channel = summary.channel ?? null;
  const href = conversationHref(tenant, summary.lobbyName, channel);
  const page = pageHuddleHref(summary.lobbyName, channel);
  const caller = summary.callerName || summary.callerId;
  await notify(targets, {
    type: 'call-missed',
    title: `Missed call from ${caller}`,
    body: MISSED_BODY[summary.reason] ?? 'Missed call.',
    channel: channel ?? summary.lobbyName,
    payload: { tenant, kind: 'call-missed', callId: summary.callId, lobbyName: summary.lobbyName, callerId: summary.callerId, callerName: caller, reason: summary.reason, ...(channel ? { channel } : {}) },
    action: { label: page ? (tenant === 'orgiq' ? 'Open the initiative' : 'Open the page') : 'Open the conversation', href },
  });
}

/** A lobby refusal with the gateway's log line (the frame itself carries no reason). */
export function guardWithLog(auth: Record<string, unknown>, lobbyName: string): boolean {
  const ok = lobbyGuard(auth, lobbyName);
  if (!ok) {
    console.warn(`[realtime-gateway] refused lobby '${lobbyName}' for user '${String(auth['userId'] ?? '?')}' (org '${String(auth['org'] ?? '?')}')`);
  }
  return ok;
}

export interface CallsFeatureOptions {
  /** The lifecycle-observed state store the feature holds calls in. */
  stateStore: CallStateStore;
  /** The unobserved store a stored call's lobby is read from (legacy accepted/status frames name only a callId). */
  getLobby: (callId: string) => Promise<string | null>;
  /** The connected socket's auth context, or null once it is gone. */
  getCtx: (clientId: string) => Record<string, unknown> | null;
  /** The leased peer router's cross-node call pub/sub (REALTIME_GATEWAY_ROUTER=redis). */
  crossNodePubSub?: CallCrossNodePubSub;
  /** Terminal cleanup for the call-page and huddle-chat runtimes. */
  onCallEnded: (summary: { callId: string; lobbyName: string; participantClientIds: string[] }) => void;
}

/** The library's calls feature under this host's admission. */
export function tenantCalls(opts: CallsFeatureOptions): RealtimeFeature {
  const guards = callGuards(opts.getLobby);
  return calls({
    stateStore: opts.stateStore,
    ...(opts.crossNodePubSub ? { crossNodePubSub: opts.crossNodePubSub } : {}),
    config: {
      // The engine normalises the flat/nested envelopes and proves `callerId`
      // on invite; a refusal whose lobby the shape guard refuses is logged.
      authorize: async (clientId: string, action: string, data: Record<string, unknown>) => {
        const ctx = opts.getCtx(clientId);
        const allowed = await admitCall(ctx, action, data ?? {}, guards);
        if (!allowed && ctx) {
          const nested = data?.['data'];
          const lobby = data?.['lobbyName'] ?? (nested && typeof nested === 'object' ? (nested as Record<string, unknown>)['lobbyName'] : undefined);
          if (typeof lobby === 'string' && lobby) guardWithLog(ctx, lobby);
        }
        return allowed;
      },
      onCallMissed: summary => notifyMissedCall(summary),
      onCallEnded: opts.onCallEnded,
    },
  });
}

/** The connected socket's auth context from the router (null once the socket is gone). */
export function socketContext(router: RealtimeRouter | null | undefined, clientId: string): Record<string, unknown> | null {
  return router?.getClientData?.(clientId)?.userContext ?? null;
}
