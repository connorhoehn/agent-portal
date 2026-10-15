// The HOST COPY of the gateway's synchronous shape guards, exactly as
// lib/gateway/authority.ts held them until realtime-modules 0.116 (byte-for-byte
// but for the names). The live guards are now the library's
// `defineChannelFamilies` over lib/tenant-channels.ts (lib/gateway/authority.ts);
// these stay ONE release behind them so the dev parity assertion
// (lib/gateway/authority-parity.ts) can compare every verdict.
//
// DELETE with the parity assertion at the next realtime-modules pin move
// (0.117, plan C3 step 5), together with live-principal.ts's host channel/call/
// lobby-read copies (`authorizeLiveGatewayChannel`, `authorizeLiveGatewayCall`,
// `authorizeLiveGatewayCallRecipient`, `authorizeCallLobbyRead`).

import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { inCallChatNamespace } from '../call-chat.js';
import { inDistillationNamespace, isDistillationChannel, mayReadDistillation } from '../distillation-channels.js';
import { inFlowRunNamespace, parseFlowRunChannel } from '../flow-runs/channel.js';
import { inSocialDeckNamespace, parseSocialDeckChannel, socialDeckPresenceChannel } from '../social-deck-channel.js';
import { SOCIAL_CHANNEL_PREFIX, slugForChannel, socialChat } from '../social-chat.js';
import { isSocialTeamMember } from '../../providers/social-platform.js';
import { TENANT_PARTITIONS, channelAuthorityFor, tenantChannelFamily, type TenantChannelFamily } from '../tenant-channels.js';
import { huddleCallId } from '../live-principal.js';

export type GuardAuth = { userId?: unknown; org?: unknown; tenants?: unknown; role?: unknown };

/** `social:team:<team slug>:<channel>` — a team's chat channel (design §4.3). */
const TEAM_CHANNEL = /^social:team:([^:]+):[^:]+$/;


/**
 * May this connection use `lobbyName`? The partition is the name's first
 * segment (`<p>:…`), admitted when it is the caller's own tenant (`org`) or
 * any tenant the token's `tenants` claim lists — the grant list
 * (docs/social-tenant-design.md E5, §4.2: "slowly contextually embed" needs an
 * orgiq page to open a `social:` channel for a user who holds a social grant).
 * Then, whatever the partition:
 *   - `<p>:dm:<a>:<b>…` (the shape `dmLobbyName(ids, { prefix: '<p>:' })`
 *     builds) only when the caller is one of the ids;
 *   - `social:team:<team>:<channel>` only for the team's members (the BFF's
 *     in-process copy of platform-api's roster, providers/social-platform.ts).
 * Under `orgiq:`/`assessment:`/`pipelines:` only a family lib/tenant-channels.ts
 * lists as a lobby (`orgiq:initiative:<id>`, `assessment:doc:<id>`) is a call
 * lobby; anything else is refused (default deny, 2026-10-05). Social rooms
 * and other `social:` names stay governed by live-principal's Social actions.
 * The family's resource authority itself is asked asynchronously against the
 * reloaded session (live-principal.ts), never here.
 */
export function legacyLobbyGuard(auth: GuardAuth, lobbyName: string): boolean {
  // Call chat is an HTTP-authorized application conversation, not a lobby.
  if (inCallChatNamespace(lobbyName)) return false;
  // The distillation feed is a server push, not a place to call into.
  if (inDistillationNamespace(lobbyName)) return false;
  // So is a flow run's private status channel.
  if (inFlowRunNamespace(lobbyName)) return false;
  // A Social deck's presence channel is not a place to call into either.
  if (inSocialDeckNamespace(lobbyName)) return false;
  return admitName(auth, lobbyName, family => family.lobby);
}

/** The partition, DM, team and Social-channel rules shared by lobbies and
 * channels; `familyAllows` decides a name under a non-Social tenant partition. */
function admitName(auth: GuardAuth, name: string, familyAllows: (family: TenantChannelFamily) => boolean): boolean {
  const org = typeof auth.org === 'string' ? auth.org : '';
  const userId = typeof auth.userId === 'string' ? auth.userId : '';
  if (!userId) return false;
  const tenants = Array.isArray(auth.tenants) ? auth.tenants.filter((t): t is string => typeof t === 'string' && !!t) : [];
  const cut = name.indexOf(':');
  if (cut <= 0) return false;
  const partition = name.slice(0, cut);
  if (partition !== org && !tenants.includes(partition)) return false;
  const rest = name.slice(cut + 1);
  if (!rest) return false;
  if (rest === 'dm' || rest.startsWith('dm:')) {
    const ids = rest.slice(3).split(':').filter(Boolean);
    return ids.includes(userId);
  }
  const team = TEAM_CHANNEL.exec(name);
  if (team) return isSocialTeamMember(team[1]!, userId);
  if (partition === 'social' && rest.startsWith('team:')) return false; // a malformed team name
  // A channel's CALL lobby is the channel: `social:ch:<slug>` admits the
  // channel's active members only, the same rows chat on it checks. Until
  // 2026-09-30 only chat asked membership, so any social grant holder could
  // ring or join a private channel's call (social chat-workspace walk).
  if (name.startsWith(SOCIAL_CHANNEL_PREFIX)) {
    return !!slugForChannel(name) && socialChat().membershipStore.isActiveMember(name, userId);
  }
  if (TENANT_PARTITIONS.has(partition)) {
    const family = tenantChannelFamily(name);
    return !!family && familyAllows(family);
  }
  return partition === 'social';
}

/**
 * May this connection subscribe to / publish on `channel` (chat, presence)?
 * The same rule as lobbies (2026-09-29; widened to the token's `tenants` by
 * E5): only channels whose partition the caller holds a grant in, a
 * `<p>:dm:<a>:<b>…` channel only when the caller is one of the ids, a team
 * channel only for the team's members. Before this, `lobbyGuard` scoped calls
 * only, and every orgiq persona could join `assessment:doc:<id>` — read its
 * history and post into it (assessment isolation walk, 2026-09-29).
 * Under a non-Social tenant only the families in lib/tenant-channels.ts, and
 * only the services each offers, pass this shape check (2026-10-05).
 */
export function legacyChannelGuard(auth: GuardAuth | null, channel: string, kind: 'subscribe' | 'publish' = 'subscribe'): boolean {
  if (auth == null) return false;
  const bare = baseChannel(channel);
  // `orgiq:huddle:<callId>` (lib/call-chat.ts): shape only here — chat on
  // the exact name or reactions on it, for a token holding orgiq or assessment
  // (an assessment team page's huddle shares the namespace). Whether this
  // CONNECTION is a current seat of that call is asked fresh by
  // live-principal's authorizeHuddleChannel, every time (never a grant alone).
  if (inCallChatNamespace(bare)) {
    const callId = huddleCallId(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!callId && (channel === bare || channel === `reactions:${bare}`) && typeof auth.userId === 'string' && !!auth.userId
      && ['orgiq', 'assessment'].some(tenant => org === tenant || tenants.includes(tenant));
  }
  // `orgiq:distill:*` (lib/distillation-channels.ts): only the server pushes
  // there, so a client may hold a plain subscription — no service prefix, no
  // publish — and only under the REST read gate (active tenant orgiq, or admin).
  // The partition rule alone would let any orgiq grant holder publish forged
  // frames to every reader, and admit someone standing in another tenant.
  if (inDistillationNamespace(bare)) {
    return kind === 'subscribe' && channel === bare && isDistillationChannel(bare) && mayReadDistillation(auth);
  }
  // `<tenant>:flowrun:<runId>` (lib/flow-runs/channel.ts): shape only here —
  // a plain subscribe, never a publish or a service prefix, in a partition the
  // caller holds. Whether this caller requested the run is asked against the
  // durable row by live-principal's authorizeFlowRunChannel, every time.
  if (inFlowRunNamespace(bare)) {
    const ref = parseFlowRunChannel(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!ref && kind === 'subscribe' && channel === bare && typeof auth.userId === 'string' && !!auth.userId
      && (ref.tenant === org || tenants.includes(ref.tenant));
  }
  // `social:deck:<id>` (lib/social-deck-channel.ts): shape only here — the
  // presence service on a well-formed deck id, in a partition the caller holds.
  // Whether this caller owns the deck or is a current member of its source
  // conversation is asked fresh by live-principal's authorizeSocialDeckChannel.
  if (inSocialDeckNamespace(bare)) {
    const ref = parseSocialDeckChannel(bare);
    const org = typeof auth.org === 'string' ? auth.org : '';
    const tenants = Array.isArray(auth.tenants) ? auth.tenants : [];
    return !!ref && channel === socialDeckPresenceChannel(ref.deckId) && typeof auth.userId === 'string' && !!auth.userId
      && (org === 'social' || tenants.includes('social'));
  }
  // Membership for a `social:ch:<slug>` channel (design §4.2) is asked inside
  // admitName, so chat, presence and the channel's call lobby agree.
  return admitName(auth, bare, family => channelAuthorityFor(family, channel, kind) !== null);
}
