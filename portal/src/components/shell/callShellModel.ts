// What the shell's call means in THIS app: whose session owns it, which page
// it opens, which automation name its dock keeps, and the tenant its huddle
// conversation is asked under. The call itself — claims, placement, phases,
// counts, the pre-join check — is the library's call block host
// (ui-components 2.439, lib/conversationCall.tsx).
import { callChannelHref, initiativeFromChannel } from '../../lib/conversationCallModel.ts';
import { hrefFromCallChannel } from '../../pages/assessment/knowledge/documentCommentsModel.ts';

interface CallSessionScope {
  sub: string;
  tenant: string;
  masquerading: { actor: string; asUser: string } | null;
}

/** Credentials and refreshed role/name/grant objects do not own a media session. */
export function callScopeKey(session: CallSessionScope | null): string {
  return JSON.stringify(session
    ? [session.tenant, session.sub, session.masquerading?.actor ?? null, session.masquerading?.asUser ?? null]
    : null);
}

/** Preserve the call composites' test/automation names when their dock moves to the shell. */
export function shellCallDockTestId(channel: string | null, tenant: string | null): string {
  if (tenant === 'social') return 'social-call-dock';
  if (hrefFromCallChannel(channel)) return 'document-call-dock';
  if (initiativeFromChannel(channel)) return 'initiative-call-dock';
  if (channel?.startsWith('search:')) return 'search-call-dock';
  if (pageHuddleHref(channel)) return 'page-call-dock';
  return 'conversation-call-dock';
}

/**
 * A page huddle's lobby is the page's realtime family name (the library's
 * `useCallBlock(channel, { bind })`); this is the page it belongs to, for the dock's People
 * button after that page has unmounted. Only the canonical shapes.
 */
export function pageHuddleHref(channel: string | null): string | null {
  const team = /^assessment:team:(TEAM-[A-Za-z0-9-]{1,120})$/.exec(channel ?? '');
  if (team) return `/assessment/teams/${encodeURIComponent(team[1]!)}`;
  const run = /^pipelines:run:([^\s/?#]{1,256})$/.exec(channel ?? '');
  if (run) return `/pipelines/runs/${encodeURIComponent(run[1]!)}`;
  return null;
}

/** Canonical navigation still works after the initiating page has unmounted. */
export function callPeopleHref(channel: string | null, tenant: string | null): string | null {
  if (tenant === 'social') return '/social/contacts';
  const initiative = initiativeFromChannel(channel);
  if (initiative) return `/iq/projects/${encodeURIComponent(initiative)}?tab=contributors`;
  return callChannelHref(channel) ?? hrefFromCallChannel(channel) ?? pageHuddleHref(channel);
}

/** Accept keeps an already bound workspace (including a deck) and its leaf
 * selection. A call about another place still opens that canonical place. */
export function acceptedCallHref(channel: string | null, currentHref: string, boundChannel: string | null): string | null {
  if (!channel || channel === boundChannel) return null;
  const initiative = initiativeFromChannel(channel);
  if (initiative && initiative === initiativeFromChannel(boundChannel)) return null;
  const current = new URL(currentHref, 'http://local.invalid');
  if (initiative && (current.pathname === `/iq/projects/${encodeURIComponent(initiative)}`
    || (current.pathname === '/iq/search' && current.searchParams.get('scope') === initiative))) return null;
  return callChannelHref(channel) ?? hrefFromCallChannel(channel) ?? pageHuddleHref(channel);
}

/**
 * The huddle conversation is asked for under the session's tenant for every
 * joined call; which lobbies admit one is the server's rule alone
 * (middleware lib/call-access.ts `huddleLobbyTenant`, answered by
 * GET /api/calls/:id/chat — a refusal reads as `denied` in HuddleRoster). A
 * copy of that rule used to live here and silently excluded pipelines and
 * social; the client no longer decides.
 */
export function huddleChatScopeTenant(tenant: string | null, joined: boolean): string | null {
  return joined && tenant ? tenant : null;
}

/** A page huddle can be live before another person accepts an invitation.
 * The call's seat admits its conversation, not its media: `connecting` lasts
 * from the join until media is up (a slow SFU, or the signalling-only
 * fixture the meeting walks and E1 use, where it never ends), and the huddle
 * chat must bind through it. A read that lands before the gateway registers
 * the seat is retried by HuddleRoster (`retryRegistration`) and re-confirmed
 * on the call's accepted frame. A reconnect retains the existing call's roster checks. */
export function hasJoinedCall(call: { callId: string } | null | undefined, phase: string): boolean {
  return !!call?.callId && ['connecting', 'live', 'reconnecting'].includes(phase);
}

/**
 * Where a huddle can be started, in the viewing tenant's own words (UX walk D, 9 November 2026): each
 * tenant is its own product, so the footer never names objects another product has (an initiative in
 * Pipelines, a document in Access). Pipelines and Access have no huddle pages of their own.
 */
const HUDDLE_PLACES: Readonly<Record<string, string>> = {
  orgiq: 'open an initiative, team, run, document, conversation or person',
  assessment: 'open a team, a document or a conversation',
  social: 'open a conversation, a hangout or a contact',
};

/**
 * The footer's pre-call controls (Huddle, Message) on a page with no huddle of its own: hidden when the
 * viewer has no Social grant and the tenant has no huddle pages (the footer shows only what the tenant
 * and the grant give them); otherwise disabled with the tenant's own reason. A page that registered a
 * huddle always shows them, and its lobby decides the reasons.
 */
export function idleHuddleControls(input: { tenant: string | null | undefined; hasLobby: boolean; hasSocialGrant: boolean }):
  { show: false } | { show: true; startReason: string | null; messageReason: string | null } {
  if (input.hasLobby) return { show: true, startReason: null, messageReason: null };
  const places = input.tenant ? HUDDLE_PLACES[input.tenant] : undefined;
  if (!places && !input.hasSocialGrant) return { show: false };
  return { show: true, startReason: `This page has no huddle — ${places ?? 'open a conversation in Communication'}`, messageReason: 'No huddle here to message' };
}
