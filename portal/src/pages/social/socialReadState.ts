/** Transport state only. A service 401 is not evidence that the portal session expired. */
export interface SocialListRead {
  data: unknown | null;
  isLoading: boolean;
  error: string | null;
}
export type SocialReadState = 'loading' | 'unavailable' | 'stale' | 'ready';
export function socialReadState(read: SocialListRead): SocialReadState {
  if (read.error) return read.data == null ? 'unavailable' : 'stale';
  if (read.isLoading && read.data == null) return 'loading';
  return 'ready';
}
export function socialReadLabel(source: string, read: SocialListRead): string | null {
  const state = socialReadState(read);
  return state === 'loading' ? `Loading ${source.toLocaleLowerCase()}…`
    : state === 'unavailable' ? `${source} couldn't load.`
    : state === 'stale' ? `${source} couldn't refresh.` : null;
}
export function conversationRailEmptyLabel(reads: readonly SocialListRead[], query: string): string {
  if (query.trim()) return 'No chats match this search';
  const states = reads.map(socialReadState);
  if (states.includes('unavailable')) return 'Some conversations are unavailable';
  if (states.includes('loading')) return 'Loading conversations…';
  if (states.includes('stale')) return 'Conversations could not be refreshed';
  return 'No conversations yet';
}
