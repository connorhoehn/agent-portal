// The words and routing of the team scorecard's dimension composer. No React,
// so node:test runs it alone. The page reference is the team plus the selected
// dimension; a stored reference carries kind/ID only, and a reader resolves the
// titles from its own authority. Chat posts to the team's discussion channel;
// Agent routes a command to the drafter, or to the review-deck build.

/** The team page's realtime family; the Discussion tab and this composer share it. */
export const teamDiscussionChannel = (teamId: string): string => `assessment:team:${teamId}`;

export interface DimensionReference { kind: 'assessment-dimension'; id: string }

/** `TEAM-001:7` — kind + ID, never a title. */
export const dimensionReferenceId = (teamId: string, dimensionId: string): string => `${teamId}:${dimensionId}`;

export function dimensionReference(teamId: string, dimensionId: string): DimensionReference {
  return { kind: 'assessment-dimension', id: dimensionReferenceId(teamId, dimensionId) };
}

/** Reads a stored reference back; null for anything that is not a well-formed dimension reference. */
export function parseDimensionReference(value: unknown): { teamId: string; dimensionId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  if (kind !== 'assessment-dimension' || typeof id !== 'string') return null;
  const m = /^(TEAM-[A-Za-z0-9-]{1,120}):([A-Za-z0-9_.-]{1,64})$/.exec(id);
  return m ? { teamId: m[1]!, dimensionId: m[2]! } : null;
}

export interface DimensionComposerPageReference {
  id: string;
  crumbs: string[];
  label: string;
  page: DimensionReference;
}

/** The chip as the composer header draws it — "Assessment › Teams › Team A › 7. Testing". */
export function dimensionPageReference(team: { id: string; name: string }, dimension: { id: string; title: string }): DimensionComposerPageReference {
  const crumbs = ['Assessment', 'Teams', team.name, `${dimension.id}. ${dimension.title}`];
  return { id: dimensionReferenceId(team.id, dimension.id), crumbs, label: crumbs.join(' › '), page: dimensionReference(team.id, dimension.id) };
}

export type AgentAction = 'summary' | 'followups' | 'deck';

export interface AgentCommand { id: AgentAction; trigger: string; label: string; description: string; capability: 'RunAssessmentAgent' | 'ScoreAssessment' }

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  { id: 'summary', trigger: '/summarize', label: 'Summarize evidence', description: 'Draft a summary of this dimension’s evidence', capability: 'RunAssessmentAgent' },
  { id: 'followups', trigger: '/followups', label: 'Draft follow-ups', description: 'Draft follow-up questions to close the open criteria', capability: 'RunAssessmentAgent' },
  { id: 'deck', trigger: '/deck', label: 'Review deck', description: 'Build the review deck for this team', capability: 'RunAssessmentAgent' },
];

/** Where an Agent-mode send goes. `null` action = text that is not a command. */
export function routeAgentText(text: string): { action: AgentAction | null; rest: string } {
  // Agent mode sends "/agent <text>"; the leading /agent is the mode, not a command.
  const m = /^\/(\w+)\b\s*([\s\S]*)$/.exec(text.trim().replace(/^\/agent\s+(?=\/)/, ''));
  const word = m?.[1]?.toLowerCase();
  const found = AGENT_COMMANDS.find(c => c.trigger === `/${word}` || (c.id === 'summary' && word === 'summary') || (c.id === 'followups' && word === 'followup'));
  return found ? { action: found.id, rest: m![2]!.trim() } : { action: null, rest: text.trim() };
}

export const AGENT_HELP = 'Agent mode runs a command: /summarize, /followups or /deck. Switch to Chat to message the team.';

export interface ComposerAccess { canChat: boolean; canAgent: boolean; readOnlyReason: string | null }

export const READER_REASON = 'Your role can read this team’s assessment but not score it or run the agent, so this composer is read-only.';

/**
 * Readers (neither ScoreAssessment nor RunAssessmentAgent) see the thread and a
 * read-only composer with the reason, as the initiative page's member state
 * does. Agent mode needs RunAssessmentAgent, the drafter's own gate.
 */
export function composerAccess(caps: { mayRead: boolean; canScore: boolean; canRunAgent: boolean }): ComposerAccess {
  const writer = caps.mayRead && (caps.canScore || caps.canRunAgent);
  return { canChat: writer, canAgent: writer && caps.canRunAgent, readOnlyReason: writer ? null : READER_REASON };
}
