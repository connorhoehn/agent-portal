export interface SearchAgent { id: string; name: string }
export type SearchCommandResult = { text: string; agentId?: string; prefix?: string; error?: never } | { error: string; text?: never; agentId?: never; prefix?: never };
/** Only an explicit slash command chooses an agent; ordinary questions auto-route. */
export function parseSearchCommand(text: string, agents: SearchAgent[], selectedAgentId?: string): SearchCommandResult {
  const value = text.trim();
  if (!value.startsWith('/')) return { text: value };
  const token = value.match(/^\/([^\s]+)(?:\s+|$)/)?.[1]?.toLowerCase();
  if (token !== 'agent') return { error: 'Unknown command. Use /agent to choose an available agent.' };
  const argument = value.replace(/^\/agent\s*/i, '');
  const matches = agents.flatMap(agent => [agent.id, agent.name].flatMap(label =>
    argument.toLowerCase() === label.toLowerCase() || argument.toLowerCase().startsWith(`${label.toLowerCase()} `)
      ? [{ agent, label }] : []));
  const selected = selectedAgentId ? matches.find(match => match.agent.id === selectedAgentId) : undefined;
  const longest = matches.sort((a, b) => b.label.length - a.label.length)[0];
  const match = selected ?? longest;
  if (!match || (selectedAgentId && !selected)) return { error: 'Choose an available agent after /agent.' };
  if (!selectedAgentId && matches.some(other => other.label.toLowerCase() === match.label.toLowerCase() && other.agent.id !== match.agent.id)) return { error: 'Use the agent ID to distinguish agents with the same name.' };
  const question = argument.slice(match.label.length).trim();
  if (!question) return { error: 'Add a question after the agent name.' };
  const prefixLength = value.length - argument.length + match.label.length;
  return { text: question, agentId: match.agent.id, prefix: value.slice(0, prefixLength) };
}
