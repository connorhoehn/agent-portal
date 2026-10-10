// The composer's command list for one reader of one conversation (pure: node-testable).

/**
 * `/agent` starts flows as the member, so it is offered only to a reader the
 * host has SAID may post here (its capabilities: PostMessage; a directory
 * listing; the server's own answer). A host that says nothing gets the list
 * without it — default closed, never `?? true` (audit A5). The same filter as
 * components/chat/chatCommandRegistry.ts `withoutAgent`, on the trigger alone.
 */
export function conversationCommands<T extends { trigger: string }>(list: readonly T[], maySend: boolean | undefined): T[] {
  return maySend === true ? [...list] : list.filter((c) => c.trigger !== '/agent');
}
