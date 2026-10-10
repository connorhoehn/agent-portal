import { presenceAvatarUsers } from '../assessment/knowledge/knowledgeFormat.ts';

/** Tenant-prefixed so the gateway's channelGuard admits orgiq grant holders. */
export const initiativePresenceChannel = (id: string): string => `orgiq:initiative:${id}`;
export const workPresenceChannel = (id: string): string => `orgiq:work:${id}`;

/** A focused work item announces on its own channel; otherwise the initiative's. */
export function scopePresenceChannel(initiativeId: string, workItemId?: string | null): string {
  return workItemId ? workPresenceChannel(workItemId) : initiativePresenceChannel(initiativeId);
}

/** Only entries the gateway stamped with a userId count as people. */
export const scopePresenceUsers = (roster: Parameters<typeof presenceAvatarUsers>[0]) =>
  presenceAvatarUsers(roster.filter((entry) => typeof entry.metadata?.['userId'] === 'string'));
