// The calls feature on the /ws gateway: the library's `calls()` configured
// with this host's admission (lib/gateway/authority.ts `admitCall`), the
// invite ledger a missed call reads, and the missed-call producer
// (docs/social-tenant-design.md §3.4 row 6). The call-page and huddle-chat
// runtimes that observe a call's lifecycle are composed in
// lib/realtime-gateway.ts and reached here through accessors.

import { calls, type RealtimeFeature, type RealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import type { CallCrossNodePubSub, CallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import { conversationHref, notify, pageHuddleHref, parseDmLobby } from '../social-notify.js';
import { admitCall, callGuards, lobbyGuard } from './authority.js';

/** Invites seen by `calls({ config.authorize })`, so a missed call knows who was rung and from where. */
const invites = new Map<string, { targets: string[]; channel: string | null; at: number }>();
const INVITE_TTL_MS = 10 * 60_000;

export function recordInvite(action: string, data: { callId?: unknown; targetUserIds?: unknown; channel?: unknown }): void {
  if (action !== 'invite' || typeof data?.callId !== 'string') return;
  const now = Date.now();
  for (const [id, v] of invites) if (now - v.at > INVITE_TTL_MS) invites.delete(id);
  const targets = Array.isArray(data.targetUserIds) ? data.targetUserIds.filter((t): t is string => typeof t === 'string') : [];
  // A later invite on the same call (someone added mid-ring) widens the audience; it never replaces it.
  const before = invites.get(data.callId);
  invites.set(data.callId, { targets: [...new Set([...(before?.targets ?? []), ...targets])],
    channel: typeof data.channel === 'string' ? data.channel : before?.channel ?? null, at: now });
}

const MISSED_BODY: Record<string, string> = {
  cancelled: 'The call ended before anyone answered.',
  declined: 'The call was declined.',
  'no-answer': 'Nobody answered.',
};

/** Row 6: an invite that never became a call → its targets (from the invite, else a DM lobby's other members). */
export async function notifyMissedCall(summary: { callId: string; lobbyName: string; callerId: string; callerName?: string; reason: string }): Promise<void> {
  const seen = invites.get(summary.callId);
  invites.delete(summary.callId);
  const tenant = summary.lobbyName.split(':')[0] ?? '';
  if (!tenant) return;
  const dm = parseDmLobby(summary.lobbyName);
  const targets = (seen?.targets.length ? seen.targets : dm?.members ?? []).filter((u) => u !== summary.callerId);
  if (!targets.length) return;
  const channel = seen?.channel ?? null;
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
  onCallEnded: (summary: { callId: string; participantClientIds: string[] }) => void;
}

/** The library's calls feature under this host's admission. */
export function tenantCalls(opts: CallsFeatureOptions): RealtimeFeature {
  const guards = callGuards(opts.getLobby, guardWithLog);
  return calls({
    stateStore: opts.stateStore,
    ...(opts.crossNodePubSub ? { crossNodePubSub: opts.crossNodePubSub } : {}),
    config: {
      // The library trusts callerId on invite. Prove it at this host
      // boundary before it becomes call ownership (including stop rights).
      // Normalize the same flat/nested envelopes the public service accepts.
      authorize: async (clientId: string, action: string, data: Record<string, unknown>) => {
        let payload = data ?? {};
        const nested = payload['data'];
        if (payload['callId'] == null && payload['lobbyName'] == null
          && nested && typeof nested === 'object' && !Array.isArray(nested)) {
          payload = { ...(nested as Record<string, unknown>), ...payload };
        }
        const allowed = await admitCall(opts.getCtx(clientId), action, payload, guards);
        if (!allowed) return false;
        recordInvite(action, payload);
        return true;
      },
      // An invite with no targets is fanned out to every connected
      // client — every tenant. The portal's hooks always target.
      canCall: (_callerId: string, targetUserIds: string[]) => targetUserIds.length > 0,
      onCallMissed: (summary: { callId: string; lobbyName: string; callerId: string; callerName?: string; reason: string }) => notifyMissedCall(summary),
      onCallEnded: opts.onCallEnded,
    },
  });
}

/** The connected socket's auth context from the router (null once the socket is gone). */
export function socketContext(router: RealtimeRouter | null | undefined, clientId: string): Record<string, unknown> | null {
  return router?.getClientData?.(clientId)?.userContext ?? null;
}
