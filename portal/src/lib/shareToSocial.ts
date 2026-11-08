// Pure half of "Share to Social" for assessment decks (no React, so node:test
// loads it): reading the destinations endpoint, naming the file endpoint, and
// shaping the chat message. The component is
// components/decks/ShareToSocialAction.tsx.
import type { ChatAttachmentDescriptor } from '@connorhoehn/ui-components/social/rich-composer';

/** An attachment as a chat send carries it: the upload id and its display fields, never a URL. */
export type OutgoingAttachment = Omit<ChatAttachmentDescriptor, 'url'>;

/**
 * `metadata` for a send that carries files (empty when there are none). Since
 * realtime-modules 0.146 the gateway writes each attachment's download URL from
 * its id and refuses any other URL, so the one the upload reported is dropped.
 */
export const attachmentMetadata = (attachments: readonly ChatAttachmentDescriptor[]): { attachments?: OutgoingAttachment[] } =>
  attachments.length ? { attachments: attachments.map(({ url: _issued, ...rest }) => rest) } : {};

export interface ShareDestination {
  /** Gateway channel: `social:ch:<slug>` or `social:dm:<ids>`. */
  channel: string; kind: 'channel' | 'dm'; label: string; slug?: string; detail: string;
}
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

/** Channels first (they are the team audience), then DMs; malformed rows are dropped. */
export function readShareDestinations(value: unknown): ShareDestination[] {
  const row = object(value); if (!row) return [];
  const out: ShareDestination[] = [];
  for (const raw of Array.isArray(row.channels) ? row.channels : []) {
    const c = object(raw);
    if (!c || !text(c.channel) || !text(c.slug) || !text(c.name) || !c.channel.startsWith('social:ch:')) continue;
    const n = typeof c.memberCount === 'number' ? c.memberCount : null;
    out.push({ channel: c.channel, kind: 'channel', slug: c.slug, label: `#${c.name}`,
      detail: `${c.privacy === 'private' ? 'Private channel' : 'Channel'}${n !== null ? ` · ${n} member${n === 1 ? '' : 's'}` : ''}` });
  }
  for (const raw of Array.isArray(row.conversations) ? row.conversations : []) {
    const c = object(raw);
    if (!c || !text(c.channel) || !c.channel.startsWith('social:dm:') || !Array.isArray(c.peers)) continue;
    const names = c.peers.map(p => object(p)?.displayName).filter(text);
    if (!names.length) continue;
    out.push({ channel: c.channel, kind: 'dm', label: names.join(', '), detail: 'Direct message' });
  }
  return out;
}

export const deckFileUrl = (deckId: string, revisionId: string): string =>
  `/api/assessment/decks/${encodeURIComponent(deckId)}/revisions/${encodeURIComponent(revisionId)}/file`;

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const pptxName = (fileName: string): string => /\.pptx$/i.test(fileName) ? fileName : `${fileName}.pptx`;

/** Message text: the optional note, else the file name. */
export const shareMessageText = (fileName: string, note: string): string => note.trim() || fileName;

/** Attachments ride with a display-only `sourceDeck` (the file, not the deck, is what members can reach). */
export function shareMetadata(attachment: ChatAttachmentDescriptor, deckId: string, revisionId: string, displayName: string) {
  return { displayName, ...attachmentMetadata([attachment]), sourceDeck: { id: deckId, revisionId } };
}

/** The message has landed once the channel echoes one citing the uploaded attachment id. */
export function messageConfirmsShare(messages: readonly { metadata?: Record<string, unknown> }[], attachmentId: string): boolean {
  return messages.some(m => Array.isArray(m.metadata?.attachments)
    && (m.metadata!.attachments as unknown[]).some(a => object(a)?.id === attachmentId));
}

/** Where "Open conversation" goes; a DM opens in the shell panel instead (null). */
export const channelHref = (d: ShareDestination): string | null => d.kind === 'channel' && d.slug ? `/social/channels/${encodeURIComponent(d.slug)}` : null;
