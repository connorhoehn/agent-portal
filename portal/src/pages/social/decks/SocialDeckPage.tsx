// /social/decks/:deckId — one Social conversation deck in the library's
// PresentationEditor, composed like pipelines/decks/PipelineDeckPage.tsx (whose
// shared deck layer it uses rather than copies).
//
//   preview   POST /api/chat/decks/:id/preview, debounced (useDeckPreview)
//   save      POST /api/chat/decks/:id/revisions with baseRevisionId; 409 -> banner
//   instruct  POST /api/chat/decks/:id/revise (a writer), answered in the request -> open the new revision
//   download  GET  /api/chat/decks/:id/revisions/:rid/file (attachment)
// A current member of the source conversation holding PostMessage edits it
// (`canEdit` = the one deck write rule); readers of it read and download. The BFF re-checks that on every call,
// so a person who left the conversation gets "not found" at once. Presence,
// slide viewers and Follow ride `social:deck:<id>` (presence only; the gateway
// admits the owner and current members of the source conversation).

import { useParams } from 'react-router';
import { DeckEditorPage, type DeckEditorDocument, type DeckEditorExtras } from '../../../components/decks/DeckEditorPage';
import { slugFromChannel } from '../socialChat';
import { deckSubject } from '../../../components/decks/deckCrumb';
import { type DeckDocumentApi } from '../../../components/decks/useDeckDocument';
import { DeckRevisionConflictError } from '../../../components/decks/deckApi';
import { useDeckAgentRun } from '../../../components/decks/useDeckAgentRun';
import {
  getSocialDeck, getSocialDeckSpec, previewSocialDeck, reviseSocialDeck, saveSocialDeckRevision, socialDeckPaths, type SocialDeckDetail,
} from './socialDecksApi';

const DECK_API: DeckDocumentApi<SocialDeckDetail> = {
  getDeck: (id) => getSocialDeck(id),
  getSpec: getSocialDeckSpec,
  saveRevision: (id, spec, base, opts) => saveSocialDeckRevision(id, spec, base, opts),
  isConflict: (err) => err instanceof DeckRevisionConflictError,
};

const INSTRUCT_HINTS = ['Tighten the bullets', 'Make the title shorter', 'Add speaker notes'] as const;

/** The shared inline agent revise on this tenant's route; only a writer (`canEdit`) is offered it. */
function useSocialRevise(doc: DeckEditorDocument<SocialDeckDetail>): DeckEditorExtras {
  return useDeckAgentRun(doc, {
    canInstruct: doc.deck?.canEdit === true,
    hints: INSTRUCT_HINTS,
    reviseNow: reviseSocialDeck,
    progressTitle: () => 'The agent is revising this deck',
  });
}

function SocialDeckPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  return (
    <DeckEditorPage
      deckId={deckId} api={DECK_API} previewDeck={previewSocialDeck} fileUrl={socialDeckPaths.file}
      tenant="social" testIdPrefix="social-deck" useExtras={useSocialRevise} readOnly={(deck) => !deck.canEdit}
      breadcrumbs={(deck, navigate) => [
        { label: 'Channels', onClick: () => navigate('/social/channels'), href: '/social/channels' },
        { label: slugFromChannel(deck.source) ? `#${slugFromChannel(deck.source)}` : deckSubject(deck.title, 'Conversation') },
      ]}
    />
  );
}

export default SocialDeckPage;
