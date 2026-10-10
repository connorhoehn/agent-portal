// Forward a chat message into another conversation (parity item 6). Pure model: what the new
// message says, what it carries and which targets may be offered. The quote is a NEW message in
// the target whose `metadata.forwardedFrom` the library's ChatPanel renders as "Forwarded from …".
// Authority stays the gateway's: the send is refused if the actor cannot post there, and the
// picker only lists conversations the actor can post to right now.
import { readDmPageDescriptor } from './dmPageReferences.ts';
import type { CallPageDescriptor } from './callPages.ts';

/** The gateway's default message ceiling (ChatService DEFAULT_MAX_MESSAGE_LENGTH). */
export const MAX_FORWARD_LENGTH = 1000;
const DM_CHANNEL = /^social:dm:/;

export interface ForwardableMessage {
  id?: string;
  userId?: string;
  displayName?: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface ForwardOrigin {
  channel: string;
  /** How the origin may be named to the recipient: "#general", or a neutral phrase for a private one. */
  label: string;
}

export interface ForwardedFromRef {
  messageId: string; channel: string; channelLabel: string; author: string; authorUserId?: string; timestamp?: string;
}

export interface ForwardSource {
  messageId: string; origin: ForwardOrigin; author: string; authorUserId?: string; text: string; timestamp?: string;
  /** The original's page reference (kind/id only); the reader's own authority resolves it. */
  page: CallPageDescriptor | null;
  attachmentNames: string[];
}

/** A private origin's name is not the forwarder's to publish; a public channel's is. */
export function originLabel(channel: string, name: string | null | undefined, isPublicChannel: boolean): string {
  return isPublicChannel && name ? `#${name}` : channel.startsWith('social:dm:') ? 'a direct message' : 'a private conversation';
}

export function buildForwardSource(message: ForwardableMessage, origin: ForwardOrigin): ForwardSource | null {
  const text = message.content.trim();
  if (!message.id || (!text && !attachmentNames(message).length)) return null;
  return {
    messageId: message.id, origin, author: message.displayName?.trim() || 'Unknown', text,
    ...(message.userId ? { authorUserId: message.userId } : {}), ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    page: readDmPageDescriptor(message.metadata?.pageReference), attachmentNames: attachmentNames(message),
  };
}

function attachmentNames(message: ForwardableMessage): string[] {
  const list = message.metadata?.attachments;
  return Array.isArray(list) ? list.flatMap(a => typeof (a as { name?: unknown })?.name === 'string' ? [(a as { name: string }).name] : []) : [];
}

export function forwardedFromRef(source: ForwardSource): ForwardedFromRef {
  return { messageId: source.messageId, channel: source.origin.channel, channelLabel: source.origin.label, author: source.author,
    ...(source.authorUserId ? { authorUserId: source.authorUserId } : {}), ...(source.timestamp ? { timestamp: source.timestamp } : {}) };
}

/**
 * Header (the library's `forwardAttributionLine`, passed in so its byte-exact de-duplication holds),
 * then the words. Files are NOT re-shared: an upload is readable only through its own channel's
 * authority, so the quote names them instead of copying or re-citing bytes. Truncates the words
 * rather than the header.
 */
export function composeForwardBody(source: ForwardSource, header: string): string {
  const files = source.attachmentNames.length ? `[Not forwarded: ${source.attachmentNames.join(', ')}]` : '';
  const room = MAX_FORWARD_LENGTH - header.length - 1;
  if (room <= 0) return header.slice(0, MAX_FORWARD_LENGTH);
  const words = [source.text, files].filter(Boolean).join('\n');
  return `${header}\n${words.length <= room ? words : `${words.slice(0, Math.max(room - 1, 1))}…`}`;
}

/** Message metadata for the NEW message. A page reference is carried only where a DM renders it. */
export function forwardMetadata(source: ForwardSource, target: string, displayName: string, deliveryId: string): Record<string, unknown> {
  return {
    displayName, clientDeliveryId: deliveryId, forwardedFrom: forwardedFromRef(source),
    ...(source.page && DM_CHANNEL.test(target) ? { pageReference: { kind: source.page.kind, id: source.page.id } } : {}),
  };
}

export type ForwardTargetKind = 'dm' | 'channel' | 'team' | 'initiative' | 'run' | 'work';
export interface ForwardTarget { channel: string; kind: ForwardTargetKind; /** Row name for scoped (non-Social) targets. */ label?: string; /** Picker heading override (work items sit under their initiative). */ section?: string }

/** The heading each scoped kind is listed under in the picker (the library's `section`). */
export const FORWARD_SECTION: Record<'team' | 'initiative' | 'run', string> = {
  team: 'Team discussions', initiative: 'Initiative discussions', run: 'Pipeline runs',
};

/** One tenant-scoped conversation a page registry lists (teams, initiatives, runs). */
export interface ScopedConversation { id: string; label: string }

/** An orgiq work item from the work list (`GET /api/graph/work`), grouped under its initiative. */
export interface WorkThread extends ScopedConversation { initiativeId: string; initiativeName: string; status?: string }

/** Closed items keep their thread, but forwarding into a finished item is noise; the list stays open work. */
const CLOSED_WORK = new Set(['done', 'cancelled']);
export const workSection = (initiativeName: string): string => `Work in ${initiativeName}`;

export interface ScopedSources {
  /** Orgiq: work items from the work list. */
  workItems?: readonly WorkThread[];
  /** Assessment: teams in the actor's read scope (`/api/assessment/teams`). */
  teams?: readonly ScopedConversation[];
  /** Orgiq: initiatives from the initiative list. */
  initiatives?: readonly ScopedConversation[];
  /** Pipelines: runs from the runs ledger. */
  runs?: readonly ScopedConversation[];
}

/** The gateway channel for each scoped kind (the same names the pages join). */
export const scopedChannel = {
  team: (id: string) => `assessment:team:${id}`,
  initiative: (id: string) => `orgiq:initiative:${id}`,
  run: (id: string) => `pipelines:run:${id}`,
  work: (id: string) => `orgiq:work:${id}`,
};

/**
 * Where the picker may offer to send: decided per target from what the composer itself checks
 * (a verified directory + send grant for DMs; membership + PostMessage for channels; the page's
 * own post capability for team / initiative / run threads), never the conversation being
 * forwarded from. Scoped sources are only offered in their own tenant.
 */
export function forwardTargets(input: {
  originChannel: string;
  dms: readonly { channel: string }[]; canSendDms: boolean;
  channels: readonly { channel: string; joined: boolean }[]; canPostChannels: boolean;
  tenant?: string | null;
  scoped?: ScopedSources;
  /** Per-tenant post authority, from the live capabilities: ViewAssessment / DispatchAgentRun / ViewPipelines. */
  canPostScoped?: boolean;
}): ForwardTarget[] {
  const scoped: ForwardTarget[] = [];
  if (input.canPostScoped && input.scoped) {
    const add = (kind: 'team' | 'initiative' | 'run', list: readonly ScopedConversation[] | undefined) => {
      for (const c of list ?? []) scoped.push({ channel: scopedChannel[kind](c.id), kind, label: c.label });
    };
    if (input.tenant === 'assessment') add('team', input.scoped.teams);
    if (input.tenant === 'orgiq') {
      add('initiative', input.scoped.initiatives);
      // Same rule as the work-item Discussion composer (DispatchAgentRun, already in canPostScoped).
      for (const w of input.scoped.workItems ?? []) {
        if (w.status && CLOSED_WORK.has(w.status)) continue;
        scoped.push({ channel: scopedChannel.work(w.id), kind: 'work', label: w.label, section: workSection(w.initiativeName) });
      }
    }
    if (input.tenant === 'pipelines') add('run', input.scoped.runs);
  }
  return [
    ...(input.canSendDms ? input.dms.map(d => ({ channel: d.channel, kind: 'dm' as const })) : []),
    ...(input.canPostChannels ? input.channels.filter(c => c.joined).map(c => ({ channel: c.channel, kind: 'channel' as const })) : []),
    ...scoped,
  ].filter((t, i, all) => t.channel !== input.originChannel && all.findIndex(o => o.channel === t.channel) === i);
}

/** How the origin is named to a recipient when it is a scoped page thread (a team or initiative name is page-level, not private chat). */
export function scopedOriginLabel(channel: string, scoped: ScopedSources): string | null {
  for (const [kind, list] of [['team', scoped.teams], ['initiative', scoped.initiatives], ['run', scoped.runs]] as const) {
    const hit = list?.find(c => scopedChannel[kind](c.id) === channel);
    if (hit) return hit.label;
  }
  const work = scoped.workItems?.find(w => scopedChannel.work(w.id) === channel);
  return work ? work.label : null;
}

/** Reads a received `forwardedFrom` for tests and hosts; tolerant of anything else. */
export function readForwardedFrom(value: unknown): ForwardedFromRef | null {
  const v = value as Partial<ForwardedFromRef> | null;
  return v && typeof v.messageId === 'string' && typeof v.channel === 'string' && typeof v.author === 'string'
    && typeof v.channelLabel === 'string' ? v as ForwardedFromRef : null;
}
