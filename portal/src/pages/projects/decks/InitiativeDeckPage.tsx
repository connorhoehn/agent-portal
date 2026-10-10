// /iq/decks/:deckId — one initiative status deck in the library's
// PresentationEditor, composed like pipelines/decks/PipelineDeckPage.tsx (whose
// DeckConflictBanner, useDeckDocument/useDeckCollaboration, useDeckPreview and
// ShareToSocialAction it reuses rather than copies). The numbers are the
// initiative's; a person edits the prose, and the Nova narrative is chosen when
// the deck is built.
//
//   preview   POST /api/initiative-decks/:id/preview, debounced (useDeckPreview)
//   save      POST /api/initiative-decks/:id/revisions with baseRevisionId; 409 -> banner
//   instruct  POST /api/initiative-decks/:id/revise (DispatchAgentRun), answered in the request -> open the new revision
//   download  GET  /api/initiative-decks/:id/revisions/:rid/file (attachment)
// Edits need DispatchAgentRun; any orgiq reader previews and downloads, except a
// deck with budget figures, which the server shows only to budget readers (404
// otherwise). Such a deck is not offered for Social sharing: the figures would
// leave the tier. Presence, slide viewers and Follow ride `orgiq:deck:<id>`.

import { useParams } from 'react-router';
import { InlineAlert } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { DeckEditorPage, type DeckEditorDocument, type DeckEditorExtras } from '../../../components/decks/DeckEditorPage';
import { deckSubject } from '../../../components/decks/deckCrumb';
import { type DeckDocumentApi } from '../../../components/decks/useDeckDocument';
import { DeckRevisionConflictError } from '../../../components/decks/deckApi';
import { useDeckAgentRun } from '../../../components/decks/useDeckAgentRun';
import {
  getInitiativeDeck, getInitiativeDeckSpec, initiativeDeckPaths, previewInitiativeDeck, reviseInitiativeDeck, saveInitiativeDeckRevision,
  shareWithheldReason, type InitiativeDeckDetail,
} from './initiativeDecksApi';

const DECK_API: DeckDocumentApi<InitiativeDeckDetail> = {
  getDeck: (id) => getInitiativeDeck(id),
  getSpec: getInitiativeDeckSpec,
  saveRevision: (id, spec, base, opts) => saveInitiativeDeckRevision(id, spec, base, opts),
  isConflict: (err) => err instanceof DeckRevisionConflictError,
};

const INSTRUCT_HINTS = ['Tighten the bullets', 'Make the title shorter', 'Add speaker notes'] as const;

/** The shared inline agent revise on this tenant's route. The agent rewrites prose only; the server re-applies every figure. */
function useInitiativeRevise(doc: DeckEditorDocument<InitiativeDeckDetail>): DeckEditorExtras {
  const { can, ready } = useCapabilities();
  return useDeckAgentRun(doc, {
    questionAgent: 'orgiq-supervisor',
    canInstruct: ready && can('DispatchAgentRun'),
    hints: INSTRUCT_HINTS,
    reviseNow: reviseInitiativeDeck,
    progressTitle: () => 'The agent is revising this deck',
  });
}

function InitiativeDeckPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const { can, ready } = useCapabilities();
  return (
    <DeckEditorPage
      deckId={deckId} api={DECK_API} previewDeck={previewInitiativeDeck} fileUrl={initiativeDeckPaths.file}
      tenant="orgiq" testIdPrefix="initiative-deck" useExtras={useInitiativeRevise} readOnly={ready ? !can('DispatchAgentRun') : true}
      huddle={(deck) => ({ channel: `orgiq:initiative:${deck.projectId}`, title: `${deck.title} huddle` })}
      followLatest
      breadcrumbs={(deck, navigate) => {
        const projectHref = `/iq/projects/${encodeURIComponent(deck.projectId)}`;
        return [
          { label: 'Initiatives', onClick: () => navigate('/iq/projects'), href: '/iq/projects' },
          { label: deckSubject(deck.title, deck.projectId), onClick: () => navigate(projectHref), href: projectHref },
        ];
      }}
      extraNotices={(deck) => {
        const withheld = shareWithheldReason(deck);
        return withheld ? <InlineAlert tone="info" data-testid="initiative-deck-budget-notice">{withheld}</InlineAlert> : null;
      }}
      canShare={(deck) => !shareWithheldReason(deck)}
    />
  );
}

export default InitiativeDeckPage;
