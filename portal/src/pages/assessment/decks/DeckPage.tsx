// /assessment/decks/:deckId — one review deck, on the shared DeckEditorPage
// (the same page initiative, pipeline-run and Social decks use). What is
// assessment's own lives here: its run routes and instruct hints; the agent
// revise flow (revise -> follow the run -> open the new revision, the progress
// and failure banners, the composer) is the shared useDeckAgentRun.
//
//   preview   POST /decks/:id/preview, debounced (useDeckPreview)
//   save      POST /decks/:id/revisions with baseRevisionId; 409 -> banner
//   instruct  POST /decks/:id/revise -> follow the run -> open the new revision
//   download  GET  /decks/:id/revisions/:rid/file (attachment)
// One write rule (deckWriteAuthority): edits and the agent box both need RunAssessmentAgent.

import { useParams } from 'react-router';
import { useCapabilities } from '../../../lib/capabilities';
import { DeckEditorPage, type DeckEditorDocument, type DeckEditorExtras } from '../../../components/decks/DeckEditorPage';
import { deckSubject } from '../../../components/decks/deckCrumb';
import type { DeckDocumentApi } from '../../../components/decks/useDeckDocument';
import { deckPaths, getDeck, getRevisionSpec, getRun, previewDeck, reviseDeck, saveRevision, type DeckDetail } from './decksApi';
import { DeckRevisionConflictError } from '../../../components/decks/deckApi';
import { deckReadOnly, hasPendingRun } from '../../../components/decks/decksModel';
import { useDeckAgentRun } from '../../../components/decks/useDeckAgentRun';

const INSTRUCT_HINTS = ['Tighten the bullets', 'Make the title shorter', 'Add speaker notes'] as const;

const DECK_API: DeckDocumentApi<DeckDetail> = {
  getDeck: (id) => getDeck(id),
  getSpec: getRevisionSpec,
  saveRevision: (id, spec, base, opts) => saveRevision(id, spec, base, opts),
  isConflict: (err) => err instanceof DeckRevisionConflictError,
};

/** The assessment-only run UI the shared page hosts: the shared agent-revise hook on assessment's runs. */
function useAssessmentRuns(doc: DeckEditorDocument<DeckDetail>): DeckEditorExtras {
  const { can, ready } = useCapabilities();
  return useDeckAgentRun(doc, {
    canInstruct: ready && can('RunAssessmentAgent'),
    hints: INSTRUCT_HINTS,
    revise: reviseDeck,
    getRun,
    progressTitle: (deck) => (deck.revisions.length === 0 ? 'Building the review deck' : 'The agent is revising this deck'),
    sourceOptions: true,
  });
}

function DeckPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const { can, ready } = useCapabilities();
  return (
    <DeckEditorPage
      deckId={deckId} api={DECK_API} previewDeck={previewDeck} fileUrl={deckPaths.file}
      tenant="assessment" testIdPrefix="deck" readOnly={ready ? deckReadOnly(can) : true}
      canAutoOpen={(d) => !hasPendingRun(d)}
      useExtras={useAssessmentRuns}
      breadcrumbs={(deck, navigate) => [
        { label: 'Workspace', onClick: () => navigate('/assessment/workspace?view=library'), href: '/assessment/workspace?view=library' },
        { label: deckSubject(deck.title, deck.teamId), href: `/assessment/teams/${encodeURIComponent(deck.teamId)}?tab=documents`, onClick: () => navigate(`/assessment/teams/${encodeURIComponent(deck.teamId)}?tab=documents`) },
      ]}
    />
  );
}

export default DeckPage;
