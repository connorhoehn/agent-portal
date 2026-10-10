// /pipelines/decks/:deckId — one run report deck in the library's
// PresentationEditor, composed like assessment/decks/DeckPage.tsx (whose
// decksModel, useDeckPreview and ShareToSocialAction it imports rather than
// copies). A run report's numbers are the run's: an agent revise rewrites prose
// only (the server re-applies the facts), as a requester-private flow run.
//
//   preview   POST /decks/:id/preview, debounced (useDeckPreview)
//   save      POST /decks/:id/revisions with baseRevisionId; 409 -> banner
//   instruct  POST /decks/:id/revise -> follow the run (useFlowRun: the private
//             pipelines:flowrun channel, polling when it is down) -> open the new revision
//   download  GET  /decks/:id/revisions/:rid/file (attachment)
// Edits and the agent box need RunPipeline; ViewPipelines holders read, preview and download.
// Presence, slide viewers and Follow ride `pipelines:deck:<id>` like the
// assessment deck. Load/save/conflict state is the shared useDeckDocument.

import { useParams } from 'react-router';
import { useCapabilities } from '../../../lib/capabilities';
import { DeckEditorPage, type DeckEditorDocument, type DeckEditorExtras } from '../../../components/decks/DeckEditorPage';
import { deckSubject } from '../../../components/decks/deckCrumb';
import { type DeckDocumentApi } from '../../../components/decks/useDeckDocument';
import { DeckRevisionConflictError } from '../../../components/decks/deckApi';
import { useDeckAgentRun } from '../../../components/decks/useDeckAgentRun';
import {
  getReviseRun, getRunDeck, getRunDeckSpec, previewRunDeck, reviseRunDeck, runDeckPaths, saveRunDeckRevision, type RunDeckDetail,
} from './pipelineDecksApi';

const INSTRUCT_HINTS = ['Add speaker notes', 'Make the title shorter'] as const;

const DECK_API: DeckDocumentApi<RunDeckDetail> = {
  getDeck: (id) => getRunDeck(id),
  getSpec: getRunDeckSpec,
  saveRevision: (id, spec, base, opts) => saveRunDeckRevision(id, spec, base, opts),
  isConflict: (err) => err instanceof DeckRevisionConflictError,
};

/**
 * The pipelines run UI the shared page hosts: the shared agent-revise hook on this
 * tenant's flow runs. The run read is per deck (`/decks/:id/runs/:runId`), and a
 * revise run is its requester's alone, so only a run this page started is followed.
 */
function usePipelineRuns(doc: DeckEditorDocument<RunDeckDetail>): DeckEditorExtras {
  const { can, ready } = useCapabilities();
  const { deckId } = doc;
  return useDeckAgentRun(doc, {
    canInstruct: ready && can('RunPipeline'),
    hints: INSTRUCT_HINTS,
    revise: reviseRunDeck,
    getRun: (runId, signal) => getReviseRun(deckId, runId, signal),
    progressTitle: () => 'The agent is revising this report',
  });
}

function PipelineDeckPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const { can, ready } = useCapabilities();
  return (
    <DeckEditorPage
      deckId={deckId} api={DECK_API} previewDeck={previewRunDeck} fileUrl={runDeckPaths.file}
      tenant="pipelines" testIdPrefix="run-deck" noun="report" readOnly={ready ? !can('RunPipeline') : true}
      useExtras={usePipelineRuns}
      breadcrumbs={(deck, navigate) => {
        const runHref = `/pipelines/runs/${encodeURIComponent(deck.runId)}`;
        return [
          { label: 'Runs', onClick: () => navigate('/pipelines/runs'), href: '/pipelines/runs' },
          { label: deckSubject(deck.title, deck.runId), onClick: () => navigate(runHref), href: runHref },
        ];
      }}
    />
  );
}

export default PipelineDeckPage;
