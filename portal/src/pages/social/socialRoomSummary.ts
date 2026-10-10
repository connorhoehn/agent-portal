// The private summary card of a ROOM-call recording (docs/agentic-flows-migration.md
// slice 7). A room has no chat conversation to carry the card, so the Recordings pane
// draws it and the requester picks where Post goes: a channel they belong to or a DM.
// The BFF asks the normal channel authority for that target (routes/social-summarize.ts).
// Pure, so node:test covers it without a DOM.

import { SOCIAL_SUMMARIZE_BASE, summarizeApi, type PostedSummary, type SummarizeApi } from '../../components/chat/conversationSummarize.ts';
import type { SocialChannel, SocialDm } from './socialChat.ts';

export interface RoomSummaryTarget { channel: string; label: string }

/** A room's call lobby (`social:room:<slug>`): the only lobby whose recording this flow serves (a DM call uses its DM). */
export const isRoomLobby = (lobby: string): boolean => /^social:room:[a-z0-9][a-z0-9-]{0,63}$/.test(lobby);

/** The run's argument text: the BFF reads only the recording id for a room. */
export const roomSummarizeText = (recordingId: string): string => `--recording ${recordingId}`;

/** Where Post may go: channels the person has joined, then their direct messages. The BFF re-checks each. */
export function roomSummaryTargets(channels: readonly SocialChannel[], dms: readonly SocialDm[]): RoomSummaryTarget[] {
  return [
    ...channels.filter(c => c.joined).map(c => ({ channel: c.channel, label: `# ${c.name}` })),
    ...dms.map(d => ({ channel: d.channel, label: d.peers.map(p => p.displayName).join(', ') || d.channel })),
  ];
}

/** The summarize API for one room card: start and status are the shared ones; Post carries the chosen target. */
export function roomSummarizeApi(getTarget: () => string | null, doFetch: typeof fetch = fetch): SummarizeApi {
  const base = summarizeApi(SOCIAL_SUMMARIZE_BASE);
  return {
    ...base,
    async requestPost(runId): Promise<PostedSummary> {
      const channel = getTarget();
      if (!channel) throw new Error('Choose where to post it first.');
      const res = await doFetch(`${SOCIAL_SUMMARIZE_BASE}/runs/${encodeURIComponent(runId)}/post`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel }),
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* fall back to the generic message */ }
      if (!res.ok) throw new Error(typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : 'The summary could not be posted.');
      const posted = body as PostedSummary;
      if (posted.channel !== channel) throw new Error('This summary was addressed to another conversation.');
      return posted;
    },
  };
}
