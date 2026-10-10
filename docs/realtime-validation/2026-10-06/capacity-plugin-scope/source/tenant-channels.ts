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
//   - `authorizeLiveGatewayChannel`/call admission (live-principal.ts) then
//     ask the family's authority against the freshly reloaded session, every
//     time, with no settled positive cache of their own.
//
// | family                        | REST read authority mirrored                                   | publish (content)          |
// |-------------------------------|----------------------------------------------------------------|----------------------------|
// | orgiq:invoke                  | /api/sessions: requireTenant('orgiq') + signed-in              | same                       |
// | orgiq:session:<id>            | /api/sessions/:id/events: requireTenant('orgiq') + signed-in   | same                       |
// | orgiq:initiative:<id>         | /api/graph/projects/:id: requireTenant('orgiq')                | DispatchAgentRun (comments)|
// | orgiq:work:<id>               | /api/graph/work-items/:id/comments: requireTenant('orgiq')     | DispatchAgentRun (comments)|
// | orgiq:workgraph[:<subject>]   | /api/work-graph/*: requireTenant('orgiq') + signed-in          | none (server hint/stream)  |
// |                               |   (a content-free refetch hint; the snapshot route re-decides  |                            |
// |                               |   every part per request, lib/work-graph/authority.ts)         |                            |
// | orgiq:deck:<id>               | /api/initiative-decks/:id: requireTenant('orgiq') + signed-in, | presence only              |
// |                               |   then the deck row + budget tier (live-principal.ts           |                            |
// |                               |   initiativeDeckVisible → providers/initiative-decks.ts)        |                            |
// | assessment:doc:<id|h:hash>    | /api/assessment/knowledge/doc: tenant + ViewAssessment         | ViewAssessment (comments)  |
// | assessment:knowledge:<sec>    | /api/assessment/knowledge/tree: tenant + ViewAssessment        | presence only              |
// | assessment:deck:<id>          | /api/assessment/decks/:id: tenant + ViewAssessment             | presence only              |
// | pipelines:deck:<id>         | /api/pipelines/decks/:id: tenant + ViewPipelines               | presence only              |
// | pipelines:run:<id>            | /api/pipelines/runs/:id: tenant + ViewPipelines                | ViewPipelines              |
// | pipelines:def:<id>            | /api/pipelines/definitions/:id: tenant + ViewPipelines         | ViewPipelines              |
// | <tenant>:lobby                | /api/people/shared: a current grant in <tenant>                | presence only              |
// | social|assessment:flowrun:<id>| the run's own REST read + requester (lib/flow-runs/channel.ts) | none (server emitEvent)    |
// | social:deck:<id>            | /api/chat/decks/:id: owner or CURRENT member of the source chat | presence only              |
//   (not a family here: Social is not a partition tenant. lib/social-deck-channel.ts holds
//   the shape, realtime-gateway.ts channelGuard refuses everything but presence:, and
//   live-principal.ts authorizeSocialDeckChannel asks the deck row + membership every time)
//   (decided by live-principal.ts authorizeFlowRunChannel against the
//   durable row, not by this table)
//
// "Content" services (bare chat, `chat:`, `reactions:`, `pins:`, `activity:`)
// publish under the family's write authority; ephemeral services
// (`presence:`, `typing:`, `cursor:`) publish under its read authority, so a
// reader can still say "I am here" without being able to post.

export type PartitionTenant = 'orgiq' | 'assessment' | 'pipelines';
export type ChannelService = 'chat' | 'presence' | 'typing' | 'cursor' | 'reactions' | 'activity' | 'pins';

/** Who may act: the active (signed) session tenant must be `tenant` unless
 * `activeTenant` is false (grant holders anywhere), plus an optional Cedar action. */
export interface ChannelAuthority { tenant: PartitionTenant; activeTenant: boolean; action: string | null }

export interface TenantChannelFamily {
  id: string;
  tenant: PartitionTenant;
  pattern: RegExp;
  services: ReadonlySet<ChannelService>;
  /** May this name also be a call lobby? */
  lobby: boolean;
  read: ChannelAuthority;
  /** null: no content publish at all. */
  write: ChannelAuthority | null;
}

const SERVICE = /^(presence|reactions|cursor|chat|typing|activity|pins):/;
const EPHEMERAL: ReadonlySet<ChannelService> = new Set(['presence', 'typing', 'cursor']);
const RID = '\\S{1,256}';
const ALL: ReadonlySet<ChannelService> = new Set(['chat', 'presence', 'typing', 'cursor', 'reactions', 'activity', 'pins']);
const DISCUSSION: ReadonlySet<ChannelService> = new Set(['chat', 'presence', 'typing', 'reactions']);
const PRESENCE: ReadonlySet<ChannelService> = new Set(['presence']);
// The library's activity service subscribes on the BARE channel name, which
// channelService() reads as `chat`. A server-push hint channel therefore offers
// only that bare subscribe; with `write: null` nobody can post to it (chat send,
// client activity publish), and presence/typing/reactions/pins are refused.
const SERVER_HINT: ReadonlySet<ChannelService> = new Set(['chat']);
/** A work-graph subject id: the REST route's own id rule (routes/work-graph.ts). */
export const WORK_GRAPH_SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WORK_GRAPH_FAMILY = /^orgiq:workgraph(?::(?:workspace|(?:initiative|person):[A-Za-z0-9][A-Za-z0-9._-]{0,99}))?$/;
const tenantOnly = (tenant: PartitionTenant, action: string | null = null): ChannelAuthority => ({ tenant, activeTenant: true, action });

export const TENANT_CHANNEL_FAMILIES: readonly TenantChannelFamily[] = [
  { id: 'orgiq:invoke', tenant: 'orgiq', pattern: /^orgiq:invoke$/, services: DISCUSSION, lobby: false,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq') },
  { id: 'orgiq:session', tenant: 'orgiq', pattern: new RegExp(`^orgiq:session:${RID}$`), services: DISCUSSION, lobby: false,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq') },
  { id: 'orgiq:initiative', tenant: 'orgiq', pattern: new RegExp(`^orgiq:initiative:${RID}$`), services: DISCUSSION, lobby: true,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq', 'DispatchAgentRun') },
  { id: 'orgiq:work', tenant: 'orgiq', pattern: new RegExp(`^orgiq:work:${RID}$`), services: DISCUSSION, lobby: false,
    read: tenantOnly('orgiq'), write: tenantOnly('orgiq', 'DispatchAgentRun') },
  // The work graph: the refetch hint on the exact name (lib/work-graph/live.ts),
  // and the workGraph() stream's per-subject router channels
  // `orgiq:workgraph:workspace|initiative:<id>|person:<id>` (lib/work-graph/stream.ts),
  // which carry no channel frames at all — the stream sends each viewer its own
  // frames directly. Same read authority as the REST snapshot; nobody publishes.
  { id: 'orgiq:workgraph', tenant: 'orgiq', pattern: WORK_GRAPH_FAMILY, services: SERVER_HINT, lobby: false,
    read: tenantOnly('orgiq'), write: null },
  { id: 'orgiq:deck', tenant: 'orgiq', pattern: new RegExp(`^orgiq:deck:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('orgiq'), write: null },
  { id: 'assessment:doc', tenant: 'assessment', pattern: new RegExp(`^assessment:doc:${RID}$`), services: ALL, lobby: true,
    read: tenantOnly('assessment', 'ViewAssessment'), write: tenantOnly('assessment', 'ViewAssessment') },
  { id: 'assessment:knowledge', tenant: 'assessment', pattern: new RegExp(`^assessment:knowledge:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('assessment', 'ViewAssessment'), write: null },
  { id: 'assessment:deck', tenant: 'assessment', pattern: new RegExp(`^assessment:deck:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('assessment', 'ViewAssessment'), write: null },
  { id: 'pipelines:deck', tenant: 'pipelines', pattern: new RegExp(`^pipelines:deck:${RID}$`), services: PRESENCE, lobby: false,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: null },
  { id: 'pipelines:run', tenant: 'pipelines', pattern: new RegExp(`^pipelines:run:${RID}$`), services: DISCUSSION, lobby: false,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: tenantOnly('pipelines', 'ViewPipelines') },
  { id: 'pipelines:def', tenant: 'pipelines', pattern: new RegExp(`^pipelines:def:${RID}$`), services: DISCUSSION, lobby: false,
    read: tenantOnly('pipelines', 'ViewPipelines'), write: tenantOnly('pipelines', 'ViewPipelines') },
  ...(['orgiq', 'assessment', 'pipelines'] as const).map((tenant): TenantChannelFamily => ({
    id: `${tenant}:lobby`, tenant, pattern: new RegExp(`^${tenant}:lobby$`), services: PRESENCE, lobby: false,
    read: { tenant, activeTenant: false, action: null }, write: null,
  })),
];

export const TENANT_PARTITIONS: ReadonlySet<string> = new Set(['orgiq', 'assessment', 'pipelines']);

/** The presence channel the shell joins so people who share `tenant` see each other. */
export const tenantLobbyChannel = (tenant: string): string => `${tenant}:lobby`;

/** `presence:assessment:doc:1` → service presence; a bare name is chat. */
export function channelService(channel: string): { service: ChannelService; bare: string } {
  const m = SERVICE.exec(channel);
  return m ? { service: m[1] as ChannelService, bare: channel.slice(m[0].length) } : { service: 'chat', bare: channel };
}

export function tenantChannelFamily(bare: string): TenantChannelFamily | null {
  return TENANT_CHANNEL_FAMILIES.find(family => family.pattern.test(bare)) ?? null;
}

/** The authority a frame on `channel` must satisfy, or null when the service
 * or kind is not offered on that family at all (a refusal). */
export function channelAuthorityFor(family: TenantChannelFamily, channel: string, kind: 'subscribe' | 'publish'): ChannelAuthority | null {
  const { service } = channelService(channel);
  if (!family.services.has(service)) return null;
  if (kind === 'subscribe' || EPHEMERAL.has(service)) return family.read;
  return family.write;
}
