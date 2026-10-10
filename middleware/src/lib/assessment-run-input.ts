import type * as M from '../mock/assessment.js';

/**
 * Review-deck commands (docs/assessment-deck-goal.md decision 4): a completed
 * run writes one deck revision through providers/assessment-decks.ts.
 */
export const DECK_COMMANDS: ReadonlySet<string> = new Set(['draft-review-deck', 'revise-review-deck']);

export interface AssessmentDispatchInput {
  agentId: string;
  payload: Record<string, unknown>;
}

export function assessmentRunInput(
  command: string, args: Record<string, unknown>, teamId: string | null,
  evidence: M.EvidenceLogItem[], submission: M.SubmissionEnvelope | undefined,
  rubric: M.RubricDimensionDef[],
  // The grounded drafter input a review-deck command carries, built by
  // providers/assessment-decks.ts from the provider's facts (decision 3 of
  // docs/assessment-deck-goal.md) — never read from the request body.
  deckInput?: Record<string, unknown>,
): AssessmentDispatchInput {
  const base = { tenant: 'assessment', team_id: teamId, command };
  if (DECK_COMMANDS.has(command)) {
    if (!teamId || !deckInput) throw new Error(`${command} is launched from the review-deck routes, which supply its input`);
    return { agentId: 'orgiq-assessment-drafter', payload: { ...base, mode: command, ...deckInput } };
  }
  if (['score-dimensions', 'process-self-assessment', 'classify-transcript'].includes(command)) {
    const sourceDocument = args['document'];
    const explicitText = sourceDocument && typeof sourceDocument === 'object' && 'text' in sourceDocument
      && typeof sourceDocument.text === 'string' ? sourceDocument.text : '';
    if (command === 'process-self-assessment' && !submission) throw new Error('Choose a committed submission to process');
    const items = command === 'classify-transcript' && explicitText.trim()
      ? [{ id: 'source-document', text: explicitText, source_type: 'transcript' }]
      : submission
      ? [{ id: submission.envelope_id, text: JSON.stringify(submission.dimension_hints), source_type: 'survey' }]
      : evidence.map(item => ({ id: item.evidence_id, text: item.excerpt, source_type: item.source_type }));
    if (!teamId || items.length === 0) throw new Error('A team and persisted evidence are required for this command');
    return { agentId: 'orgiq-assessment-scorer', payload: {
      ...base, mode: command === 'process-self-assessment' ? 'survey' : 'transcript',
      evidence: items, rubric,
      ...(submission ? { relevant_dimension_ids: submission.dimension_hints.map(h => h.dimension_id) } : {}),
    } };
  }
  if (command === 'develop-jira-story') {
    const rec = args['recommendation'];
    if (!rec || typeof rec !== 'object' || !('dimension_id' in rec) || !('kind' in rec)) {
      throw new Error('develop-jira-story requires a recommendation with dimension_id and kind');
    }
    return { agentId: 'orgiq-assessment-drafter', payload: { ...base, mode: 'story', recommendation: rec } };
  }
  if (command === 'extract-enterprise-context') {
    const document = args['document'];
    if (!document || typeof document !== 'object' || !('text' in document) || typeof document.text !== 'string' || !document.text.trim()) {
      throw new Error('extract-enterprise-context requires document.text');
    }
    return { agentId: 'orgiq-assessment-drafter', payload: { ...base, mode: 'context', document } };
  }
  if (['validate-outputs', 'draft-confluence-page', 'suggest-confluence-content', 'draw-diagram'].includes(command)) {
    const document = args['document'];
    if (!document || typeof document !== 'object' || !('text' in document) || typeof document.text !== 'string' || !document.text.trim()) {
      throw new Error(`${command} requires document.text as source material`);
    }
    return { agentId: 'orgiq-assessment-drafter', payload: { ...base, mode: command, document,
      ...(typeof args['instruction'] === 'string' ? { instruction: args['instruction'] } : {}) } };
  }
  throw new Error(`Unknown assessment command: ${command}`);
}
