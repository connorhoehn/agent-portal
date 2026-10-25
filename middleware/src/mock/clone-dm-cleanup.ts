// Clone DMs are disposable test conversations. Remove their fixture rows on
// identity deletion/expiry, including worlds no longer active in a request.
// This does not reset fixtures or touch the persona's own conversations.
import { parseDmLobby } from '@connorhoehn/realtime-modules/call';
import { fixtureRegistry, removeFixtureRows } from './core/index.js';

const channelFields: ReadonlyArray<readonly [string, string]> = [
  ['social.channel-messages', 'channel'], ['social.channel-members', 'channel'],
  ['social.dm-joins', 'channel'], ['social.read-cursors', 'channel'],
  ['social.pins', 'channelId'], ['gateway.reactions', 'channel'], ['gateway.uploads', 'channel'],
];
const listeners = new Set<() => void>();

/** The gateway drops its message cache after fixture data has been removed. */
export function onCloneDmCleanup(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function removeCloneDmFixtures(cloneId: string): number {
  let removed = 0;
  for (const [key, field] of channelFields) {
    const fixture = fixtureRegistry.get(key);
    if (!fixture) continue;
    removed += removeFixtureRows(fixture, row => {
      const channel = (row as Record<string, unknown> | null)?.[field];
      if (typeof channel !== 'string') return false;
      const tenant = channel.split(':', 1)[0];
      const dm = parseDmLobby(channel, { prefix: `${tenant}:` });
      return dm?.kind === 'dm' && dm.members.includes(cloneId);
    });
  }
  if (removed) for (const listener of listeners) {
    try { listener(); } catch (error) { console.warn('[clone-dm-cleanup] cache refresh failed', error); }
  }
  return removed;
}
