// Who an AgentCore Memory transcript belongs to. Pure, so routes and tests
// use it without the Memory client (providers/memory.ts) in the graph.

/**
 * The Memory actor for a signed-in session: one transcript space per user per
 * tenant. Always derived from the session, never from the request, because a
 * caller-chosen actor reads (and feeds the model) someone else's conversation.
 * Null without a session: such a caller has no transcript to read or write.
 * Characters outside AgentCore's conservative id set are replaced.
 */
export function memoryActor(session: { sub?: string | null; tenant?: string | null } | null | undefined): string | null {
  if (!session?.sub || !session.tenant) return null;
  return `${session.tenant}_${session.sub}`.replace(/[^A-Za-z0-9_-]/g, '-');
}
