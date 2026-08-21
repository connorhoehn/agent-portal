// toolCallSummary — one muted line of behind-the-scenes semantics for a
// completed turn, built from the tool calls the AG-UI stream captured
// (useAgentStream attaches them to each finalized assistant message). No new
// plumbing: if the hook recorded nothing, this renders nothing.

const FRIENDLY: Array<[RegExp, string]> = [
  [/retriev|knowledge/i, 'searched knowledge base'],
  [/query_graph|graph|sql/i, 'queried the org graph'],
  [/fetch_web|browse|web_page/i, 'fetched a web page'],
  [/sandbox|interpreter/i, 'ran code'],
  [/memory/i, 'recalled memory'],
];

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
    const label = FRIENDLY.find(([re]) => re.test(tc.name))?.[1] ?? tc.name;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return Array.from(counts.entries())
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ');
}
