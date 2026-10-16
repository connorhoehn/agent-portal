// The realtime channel families each non-Social tenant actually uses, and the
// REST authority each one mirrors. This is a default-deny allowlist: a name
// under `orgiq:`, `assessment:` or `pipelines:` that matches no family here
// (and is not a DM, distillation feed or reserved huddle) is refused, however
// many grants the caller holds. Until 2026-10-05 every grant holder in a
// partition could subscribe/publish to ANY name under it (realtime-parity
// gap #6/#8, work item A1).
//
// Two layers use this table:
//   - the synchronous guards (realtime-gateway.ts `channelGuard`/`lobbyGuard`)
//     check only the SHAPE: family, service and partition grant;
//   - the channel/call admission (lib/gateway/authority.ts `admitChannel`/`admitCall`) then
//     ask the family's authority against the freshly reloaded session, every
//     time, with no settled positive cache of their own.
//
// | family                        | REST read authority mirrored                                   | publish (content)          |
// |-------------------------------|----------------------------------------------------------------|----------------------------|
// | orgiq:invoke                  | /api/sessions: requireTenant('orgiq') + signed-in              | same                       |
// | orgiq:session:<id>            | /api/sessions/:id/events: requireTenant('orgiq') + signed-in   | same                       |
// | orgiq:initiative:<id>         | /api/graph/projects/:id: requireTenant('orgiq')                | DispatchAgentRun (comments)|
// |                               |   (every orgiq role); as a call lobby also the initiative      |                            |
// |                               |   existing now (lib/page-resources.ts, 2026-10-06)             |                            |
// | orgiq:work:<id>               | /api/graph/work-items/:id/comments: requireTenant('orgiq')     | DispatchAgentRun (comments)|
// | orgiq:workgraph[:<subject>]   | /api/work-graph/*: requireTenant('orgiq') + signed-in          | none (server hint/stream)  |
// |                               |   (a content-free refetch hint; the snapshot route re-decides  |                            |
// |                               |   every part per request, lib/work-graph/authority.ts)         |                            |
// | pipelines:workgraph[:<subject>] | /api/pipelines/work-graph/*: tenant + ViewPipelines         | none (server hint/stream)  |
// |                               |   (subjects `workspace` and `run:<id>`; the snapshot route    |                            |
// |                               |   re-decides every part per request, so approvals reach only   |                            |
// |                               |   ApproveStep holders — lib/work-graph/authority.ts)           |                            |
// | assessment:workgraph[:<subject>] | /api/assessment/work-graph/*: tenant + ViewAssessment  | none (server hint/stream)  |
// |                               |   (subjects `workspace` and `team:<id>`; the snapshot route    |                            |
// |                               |   re-decides every part per request — lib/work-graph/authority.ts) |                         |
// | social:workgraph[:<subject>]  | /api/social/work-graph/*: tenant + ViewSocial (the family)      | none (server hint/stream)  |
// |                               |   and, for `conversation:<channel>`, the conversation's own     |                            |
// |                               |   chat read NOW (live-principal.ts authorizeSocialWorkGraphChannel) |                        |
// | orgiq:deck:<id>               | /api/initiative-decks/:id: requireTenant('orgiq') + signed-in, | presence only              |
// |                               |   then the deck row + budget tier (live-principal.ts           |                            |
// |                               |   initiativeDeckVisible → providers/initiative-decks.ts)        |                            |
// | assessment:doc:<id|h:hash>    | /api/assessment/knowledge/doc: tenant + ViewAssessment         | ViewAssessment (comments)  |
// | assessment:team:<TEAM-id>     | /api/assessment/teams/:id: tenant + ViewAssessment + the team  | ViewAssessment             |
// |                               |   row now (lib/page-resources.ts); chat AND call lobby          |                            |
// | assessment:knowledge:<sec>    | /api/assessment/knowledge/tree: tenant + ViewAssessment        | presence only              |
// | assessment:deck:<id>          | /api/assessment/decks/:id: tenant + ViewAssessment             | presence only              |
// | pipelines:deck:<id>         | /api/pipelines/decks/:id: tenant + ViewPipelines               | presence only              |
// | pipelines:run:<id>            | /api/pipelines/runs/:id: tenant + ViewPipelines; as a call     | ViewPipelines              |
// |                               |   lobby also the run existing now (lib/page-resources.ts)      |                            |
// | pipelines:def:<id>            | /api/pipelines/definitions/:id: tenant + ViewPipelines         | ViewPipelines              |
// | access:req:<id>               | /api/access/requests/:id: tenant + ViewAccess + the request's  | ViewAccess (+ the row rule)|
// |                               |   read rule for THIS reader, now (requester, beneficiary,     |                            |
// |                               |   manager, live approver / past decider, access-admin) — the  |                            |
// |                               |   `access-request` channelResource (lib/access/thread.ts)     |                            |
// | <tenant>:lobby                | /api/people/shared: a current grant in <tenant>                | presence only              |
// | social|assessment:flowrun:<id>| the run's own REST read + requester (lib/flow-runs/channel.ts) | none (server emitEvent)    |
// | social:deck:<id>            | /api/chat/decks/:id: owner or CURRENT member of the source chat | presence only              |
//   (not a family here: Social is not a partition tenant. lib/social-deck-channel.ts holds
//   the shape, realtime-gateway.ts channelGuard refuses everything but presence:, and
//   live-principal.ts authorizeSocialDeckChannel asks the deck row + membership every time)
//   (decided by live-principal.ts authorizeFlowRunChannel against the
//   durable row, not by this table)
//
// Read cursors (`cursors: true`: orgiq:initiative, orgiq:work, assessment:doc,
// assessment:team, pipelines:run, access:req) are kept per CURRENT reader with no member
// list: the chat `read`/`receipts` verbs ask the family's READ authority on every
// frame (realtime-modules 0.115 cursorMode 'readers'; lib/page-thread-unread.ts).
//
// "Content" services (bare chat, `chat:`, `reactions:`, `pins:`, `activity:`)
// publish under the family's write authority; ephemeral services
// (`presence:`, `typing:`, `cursor:`) publish under its read authority, so a
// reader can still say "I am here" without being able to post.

import { defineChannelFamilies, type ChannelFamilies, type ChannelFamily } from '@connorhoehnslalom/realtime-modules/server';
import type { PageResourceKind } from './page-resources.js';

/** `social` appears ONLY for the `social:workgraph` family (it is not a partition tenant: TENANT_PARTITIONS stays three, and every other `social:` name keeps its own rules). */
export type PartitionTenant = 'orgiq' | 'assessment' | 'pipelines' | 'social' | 'access';
export type ChannelService = 'chat' | 'presence' | 'typing' | 'cursor' | 'reactions' | 'activity' | 'pins';

/** Who may act: the active (signed) session tenant must be `tenant` unless
 * `activeTenant` is false (grant holders anywhere), plus an optional Cedar action. */
export interface ChannelAuthority { tenant: PartitionTenant; activeTenant: boolean; action: string | null }

export interface TenantChannelFamily extends ChannelFamily<ChannelAuthority> {
  id: string;
  tenant: PartitionTenant;
  pattern: RegExp;
  services: ReadonlySet<ChannelService>;
  /** May this name also be a call lobby? */
  lobby: boolean;
  /** The page's resource row, asked fresh on every CALL decision on this lobby
   * (lib/page-resources.ts) — the REST read's 404 half. */
  lobbyResource?: PageResourceKind;
  /** The same, asked on every CHANNEL decision. Only where the read is cheap:
   * a run's existence is a full projection load, so `pipelines:run` chat keeps
   * the REST list's tenant+action rule and asks the run for calls only. */
  channelResource?: PageResourceKind;
  read: ChannelAuthority;
  /** null: no content publish at all. */
  write: ChannelAuthority | null;
  /** The page's discussion keeps read cursors for its CURRENT readers
   * (realtime-modules 0.115 `cursorMode: 'readers'`, lib/page-thread-unread.ts):
   * no member list — every `read`/`receipts` is admitted by `read` above, asked
   * fresh, and the unread badge reaches only people who pass it now. */
  cursors?: true;
}

// An id: up to 256 non-space characters, never a meeting room's suffix, so
// `<lobby>~breakout~<room>` can never read as an id of the family (decision 2,
// docs/meeting-rooms-app-goal.md; the authority facade splits rooms first).
const RID = '(?:(?!~breakout~)\\S){1,256}';
const ALL: ReadonlySet<ChannelService> = new Set(['chat', 'presence', 'typing', 'cursor', 'reactions', 'activity', 'pins']);
const DISCUSSION: ReadonlySet<ChannelService> = new Set(['chat', 'presence', 'typing', 'reactions']);
// A discussion whose page also shows a shared canvas (the work graph): pointers ride
// `cursor:<channel>` under the family's read authority, like its presence.
const DISCUSSION_CURSORS: ReadonlySet<ChannelService> = new Set(['chat', 'presence', 'typing', 'reactions', 'cursor']);
const PRESENCE: ReadonlySet<ChannelService> = new Set(['presence']);
// The library's activity service subscribes on the BARE channel name, which
// channelService() reads as `chat`. A server-push hint channel therefore offers
// only that bare subscribe; with `write: null` nobody can post to it (chat send,
// client activity publish), and presence/typing/reactions/pins are refused.
const SERVER_HINT: ReadonlySet<ChannelService> = new Set(['chat']);
/** A work-graph subject id: the REST route's own id rule (routes/work-graph.ts). */
export const WORK_GRAPH_SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WORK_GRAPH_FAMILY = /^orgiq:workgraph(?::(?:workspace|(?:initiative|person):[A-Za-z0-9][A-Za-z0-9._-]{0,99}))?$/;
/** The pipelines work graph's subjects: `workspace`, or one run (ids carry `:` — `job:<id>`, `bot-run:<id>`). */
export const PIPELINES_WORK_GRAPH_SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PIPELINES_WORK_GRAPH_FAMILY = /^pipelines:workgraph(?::(?:workspace|run:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/;
/** The assessment work graph's subjects: `workspace`, or one team (`team:TEAM-…`, the REST route's team id rule). */
export const ASSESSMENT_WORK_GRAPH_SUBJECT_ID = /^TEAM-[A-Za-z0-9-]{1,120}$/;
const ASSESSMENT_WORK_GRAPH_FAMILY = /^assessment:workgraph(?::(?:workspace|team:TEAM-[A-Za-z0-9-]{1,120}))?$/;
/** The social work graph's subjects: `workspace`, or one conversation by its chat channel name (`conversation:social:ch:<slug>`, `social:dm:<a>:<b>`, `social:team:<team>:<ch>`, `social:room:<slug>`). */
export const SOCIAL_CONVERSATION_ID = /^social:(?:ch|dm|team|room):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const SOCIAL_WORK_GRAPH_FAMILY = /^social:workgraph(?::(?:workspace|conversation:social:(?:ch|dm|team|room):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}))?$/;
const tenantOnly = (tenant: PartitionTenant, action: string | null = null): ChannelAuthority => ({ tenant, activeTenant: true, action });

export const TENANT_CHANNEL_FAMILIES: readonly TenantChannelFamily[] = [
  { id: 'orgiq:invoke', tenant: 'orgiq', pattern: /^orgiq:invoke$/, services: DISCUSSION, lobby: false,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq') },
  { id: 'orgiq:session', tenant: 'orgiq', pattern: new RegExp(`^orgiq:session:${RID}$`), services: DISCUSSION, lobby: false,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq') },
  // An initiative page (/iq/initiatives/:id): its discussion and its huddle. As a
  // call lobby it also asks the initiative existing now, like pipelines:run.
  { id: 'orgiq:initiative', tenant: 'orgiq', pattern: new RegExp(`^orgiq:initiative:${RID}$`), services: DISCUSSION_CURSORS, lobby: true,
    lobbyResource: 'orgiq-initiative', cursors: true,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq', 'DispatchAgentRun') },
  { id: 'orgiq:work', tenant: 'orgiq', pattern: new RegExp(`^orgiq:work:${RID}$`), services: DISCUSSION, lobby: false, cursors: true,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq', 'DispatchAgentRun') },
  // The work graph: the refetch hint on the exact name (lib/work-graph/live.ts),
  // and the workGraph() stream's per-subject router channels
  // `orgiq:workgraph:workspace|initiative:<id>|person:<id>` (lib/work-graph/stream.ts),
  // which carry no channel frames at all — the stream sends each viewer its own
  // frames directly. Same read authority as the REST snapshot; nobody publishes.
  { id: 'orgiq:workgraph', tenant: 'orgiq', pattern: WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false,
    read: tenantOnly('orgiq'), write: null },
  { id: 'pipelines:workgraph', tenant: 'pipelines', pattern: PIPELINES_WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: null },
  { id: 'assessment:workgraph', tenant: 'assessment', pattern: ASSESSMENT_WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false,
    read: tenantOnly('assessment', 'ViewAssessment'), write: null },
  // Social: the family is shape + service only (a bare server-hint subscribe, nobody publishes). The
  // conversation a subject names is asked fresh, per subscribe AND delivered frame, by
  // live-principal's authorizeSocialWorkGraphChannel, and again by every snapshot rebuild.
  { id: 'social:workgraph', tenant: 'social', pattern: SOCIAL_WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false,
    read: tenantOnly('social', 'ViewSocial'), write: null },
  { id: 'orgiq:deck', tenant: 'orgiq', pattern: new RegExp(`^orgiq:deck:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('orgiq'), write: null },
  { id: 'assessment:doc', tenant: 'assessment', pattern: new RegExp(`^assessment:doc:${RID}$`), services: ALL, lobby: true, cursors: true,
    read: tenantOnly('assessment', 'ViewAssessment'), write: tenantOnly('assessment', 'ViewAssessment') },
  // A team's page (/assessment/teams/:id): its discussion and its huddle.
  { id: 'assessment:team', tenant: 'assessment', pattern: /^assessment:team:TEAM-[A-Za-z0-9-]{1,120}$/, services: DISCUSSION_CURSORS, lobby: true,
    lobbyResource: 'assessment-team', channelResource: 'assessment-team', cursors: true,
    read: tenantOnly('assessment', 'ViewAssessment'), write: tenantOnly('assessment', 'ViewAssessment') },
  { id: 'assessment:knowledge', tenant: 'assessment', pattern: new RegExp(`^assessment:knowledge:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('assessment', 'ViewAssessment'), write: null },
  { id: 'assessment:deck', tenant: 'assessment', pattern: new RegExp(`^assessment:deck:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('assessment', 'ViewAssessment'), write: null },
  { id: 'pipelines:deck', tenant: 'pipelines', pattern: new RegExp(`^pipelines:deck:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: null },
  { id: 'pipelines:run', tenant: 'pipelines', pattern: new RegExp(`^pipelines:run:${RID}$`), services: DISCUSSION_CURSORS, lobby: true,
    lobbyResource: 'pipelines-run', cursors: true,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: tenantOnly('pipelines', 'ViewPipelines') },
  { id: 'pipelines:def', tenant: 'pipelines', pattern: new RegExp(`^pipelines:def:${RID}$`), services: DISCUSSION, lobby: false,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: tenantOnly('pipelines', 'ViewPipelines') },
  // A request record's discussion (/access/requests/:id; AccessRequest.thread),
  // with reader cursors. Admitted to who passes the request's REST read rule
  // NOW (lib/access/thread.ts via the `access-request` channel resource:
  // requester, beneficiary, the beneficiary's manager, live approvers and
  // past deciders, access-admin) standing in `access` with ViewAccess.
  { id: 'access:req', tenant: 'access', pattern: /^access:req:req-[A-Za-z0-9-]{1,64}$/, services: DISCUSSION, lobby: false, cursors: true,
    channelResource: 'access-request',
    read: tenantOnly('access', 'ViewAccess'), write: tenantOnly('access', 'ViewAccess') },
  ...(['orgiq', 'assessment', 'pipelines'] as const).map((tenant): TenantChannelFamily => ({
    id: `${tenant}:lobby`, tenant, pattern: new RegExp(`^${tenant}:lobby$`), services: PRESENCE, lobby: false,
    read: { tenant, activeTenant: false, action: null }, write: null,
  })),
];

export const TENANT_PARTITIONS: ReadonlySet<string> = new Set(['orgiq', 'assessment', 'pipelines', 'access']);

/**
 * The family MECHANISM over the table above (realtime-modules 0.116
 * `defineChannelFamilies`): the service prefixes (`presence|reactions|cursor|
 * chat|typing|activity|pins`, a bare name is chat — the library defaults), the
 * ephemeral services that publish under the read authority (`presence|typing|
 * cursor`), the default-deny partitions. The table stays this host's data.
 * The gateway's shape guards (lib/gateway/authority.ts) add the host
 * namespaces and name rules over the same table.
 */
export const TENANT_FAMILIES: ChannelFamilies<ChannelAuthority, TenantChannelFamily> =
  defineChannelFamilies<ChannelAuthority, TenantChannelFamily>(TENANT_CHANNEL_FAMILIES, { partitions: TENANT_PARTITIONS });

/** The presence channel the shell joins so people who share `tenant` see each other. */
export const tenantLobbyChannel = (tenant: string): string => `${tenant}:lobby`;

/** `presence:assessment:doc:1` → service presence; a bare name is chat. */
export function channelService(channel: string): { service: ChannelService; bare: string } {
  return TENANT_FAMILIES.serviceOf(channel) as { service: ChannelService; bare: string };
}

export function tenantChannelFamily(bare: string): TenantChannelFamily | null {
  return TENANT_FAMILIES.familyOf(bare);
}

/** A BARE chat name (no service prefix) on a family that keeps reader cursors, or null. */
export function pageCursorFamily(channel: string): TenantChannelFamily | null {
  if (channelService(channel).bare !== channel) return null;
  const family = tenantChannelFamily(channel);
  return family?.cursors && family.services.has('chat') ? family : null;
}

/** The authority a frame on `channel` must satisfy, or null when the service
 * or kind is not offered on that family at all (a refusal). */
export function channelAuthorityFor(family: TenantChannelFamily, channel: string, kind: 'subscribe' | 'publish'): ChannelAuthority | null {
  return TENANT_FAMILIES.authorityFor(family, channel, kind);
}
