// Which conversations a freshly arrived inbox item touched. The shell's inbox
// feed (the gateway's notifications, already filtered server-side to what this
// reader may read) names the channel; the rail refetches its own list when a new
// message item appears, so a DM row and its unread badge move without
// subscribing to any channel's history.

import { socialInbox, type SocialInboxEntry } from './socialChat.ts';

/** Channels of social `message`/`mention` items whose ids are not in `seen`, in arrival order, once each. */
export function newMessageChannels(entries: readonly SocialInboxEntry[], seen: ReadonlySet<string>): { channels: string[]; ids: string[] } {
  const channels: string[] = [];
  const ids: string[] = [];
  for (const entry of socialInbox(entries)) {
    if (seen.has(entry.id)) continue;
    ids.push(entry.id);
    const kind = entry.payload?.['kind'] ?? entry.type;
    if ((kind === 'message' || kind === 'mention') && typeof entry.channel === 'string' && entry.channel && !channels.includes(entry.channel)) channels.push(entry.channel);
  }
  return { channels, ids };
}
