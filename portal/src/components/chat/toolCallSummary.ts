// toolCallSummary — one muted line of behind-the-scenes semantics for a
// completed turn, built from the tool calls the AG-UI stream captured
// (useAgentStream attaches them to each finalized assistant message). No new
// plumbing: if the hook recorded nothing, this renders nothing.

// Order matters — the specific supervisor tools are matched before the generic
// patterns, otherwise `build_graph` reads as "queried the org graph" (it
// writes) and `get_expertise_scores` falls through to its raw function name.
//
// These phrases name DATA, never an agent. A user reading "asked the Scoring
// specialist" learns our topology; "read expertise scores" tells them where
// the answer came from, which is the thing they asked.
const FRIENDLY: Array<[RegExp, string]> = [
  [/get_expertise_scores/i, 'read expertise scores'],
  [/get_strategic_advice/i, 'ran an advisory analysis'],
  [/search_organization/i, 'searched the org'],
  [/ingest_documents/i, 'ingested documents'],
  [/build_graph/i, 'updated the org graph'],
  [/retriev|knowledge/i, 'searched knowledge base'],
  [/query_graph|graph|sql/i, 'queried the org graph'],
  [/fetch_web|browse|web_page/i, 'fetched a web page'],
  [/sandbox|interpreter/i, 'ran code'],
  [/memory/i, 'recalled memory'],
];

/**
 * The same FRIENDLY mapping `summarizeToolCalls` uses, exposed per-call so a
 * tool-call strip (InvokePage's MessageBubble pills) can read "searched
 * knowledge base" instead of a raw tool id, without duplicating this table.
 * Unknown tools keep their raw name.
 */
export function friendlyToolName(name: string): string {
  return FRIENDLY.find(([re]) => re.test(name))?.[1] ?? name;
}

/**
 * Summarize a turn's tool calls, e.g. 'searched knowledge base ×3 · queried
 * the org graph'. Unknown tools keep their raw name. Returns null when there
 * is nothing to say.
 */
export function summarizeToolCalls(toolCalls: Array<{ name: string }> | undefined): string | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  const counts = new Map<string, number>();
  for (const tc of toolCalls) {
    if (!tc?.name) continue;
    const label = friendlyToolName(tc.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return Array.from(counts.entries())
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ');
}
