// Per-suggestion review of a stored agent edit (agentic-flows slice 9). The
// library's SuggestionReviewList + SuggestionCard, one card per whole block of
// the proposal (documentSuggestionsModel). Readers get the cards without any
// Accept/Reject controls (the cards hide absent handlers by design).

import { SuggestionCard, SuggestionReviewList } from '@connorhoehn/ui-components/doc-editor';
import { Chip, Stack } from '@connorhoehn/ui-components/shared';
import { proposalProducerLabel, type StoredDocumentProposal } from './documentProposalClient';
import { splitSuggestionBlocks, type SuggestionMark, type SuggestionMarks } from './documentSuggestionsModel';

export interface DocumentSuggestionReviewProps {
  proposal: StoredDocumentProposal;
  marks: SuggestionMarks;
  /** Editors only; false renders the cards read-only. */
  canResolve: boolean;
  /** A save, claim or revision is in flight: the controls would race it. */
  busy: boolean;
  onMark: (index: number, mark: SuggestionMark) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

/** Per-suggestion review only earns its space when there is more than one block to decide. */
export const hasSuggestionBlocks = (proposal: Pick<StoredDocumentProposal, 'content'>) => splitSuggestionBlocks(proposal.content.text).length > 1;

export function DocumentSuggestionReview({ proposal, marks, canResolve, busy, onMark, onAcceptAll, onRejectAll }: DocumentSuggestionReviewProps) {
  const blocks = splitSuggestionBlocks(proposal.content.text);
  const undecided = blocks.filter(block => marks[block.index] === undefined).length;
  const context = proposal.summary ?? (proposal.kind === 'replace' ? 'Replaces the selected text' : 'Insert at the cursor');
  const when = Date.parse(proposal.createdAt);
  const resolve = canResolve && !busy;
  return (
    <Stack gap="sm" data-testid="document-suggestion-review" data-proposal-id={proposal.id}>
      <SuggestionReviewList
        count={blocks.length}
        variant="pane"
        title="Suggestions"
        {...(resolve ? { onAcceptAll, onRejectAll } : {})}
        emptyBody="Nothing is suggested."
        data-testid="document-suggestions"
      >
        {blocks.map(block => {
          const mark = marks[block.index];
          const replace = proposal.kind === 'replace' && block.index === 0;
          return (
            <li key={block.index} data-testid="document-suggestion" data-block-index={block.index} data-mark={mark ?? 'undecided'}>
              <SuggestionCard
                  kind={replace ? 'replace' : 'insert'}
                  author={proposalProducerLabel(proposal)}
                  when={Number.isFinite(when) ? when : null}
                  context={context}
                  insertedBlocks={[block.text]}
                  {...(replace ? { deletedText: proposal.originalText } : {})}
                  {...(mark ? { status: <Chip tone={mark === 'accept' ? 'success' : 'neutral'} size="sm" data-testid="document-suggestion-mark">
                    {mark === 'accept' ? 'Will be applied' : 'Will be removed'}
                  </Chip> } : {})}
                  {...(resolve ? { onAccept: () => onMark(block.index, 'accept'), onReject: () => onMark(block.index, 'reject') } : {})}
                  data-testid="document-suggestion-card"
                />
            </li>
          );
        })}
      </SuggestionReviewList>
      {canResolve && undecided > 0 && undecided < blocks.length && (
        <Chip tone="info" size="sm" data-testid="document-suggestion-pending">{`${undecided} of ${blocks.length} still to decide; the edit applies once every suggestion has a verdict.`}</Chip>
      )}
    </Stack>
  );
}
