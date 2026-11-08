// Isolated UI/document-state fixture. API methods are in-memory; no signed
// actor, real deck, gateway, native call or server document is used.
import '../../src/app.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import type { DeckSpec } from '@connorhoehn/ui-components/doc-editor';
import { DeckEditorPage, type DeckEditorDocument, type DeckEditorExtras } from '../../src/components/decks/DeckEditorPage';
import type { DeckDocumentApi, DeckDocumentShape } from '../../src/components/decks/useDeckDocument';
import { ConversationComposer } from '../../src/lib/conversationComposer';

const initial: DeckSpec = { title: 'Editable presentation fixture', slides: [
  { id: 'summary', layout: 'title', title: 'Summary', notes: 'Start with the outcome.', sources: [{ documentId: 'fixture-source', title: 'Fixture facts' }] },
  { id: 'details', layout: 'bullets', title: 'Validation next', bullets: ['Confirm the map', 'Replay the outage'], notes: 'Explain the affected services.', sources: [{ documentId: 'fixture-source', title: 'Fixture facts' }] },
] };
interface Document extends DeckDocumentShape { id: string; title: string }
const saved: Document = { id: 'fixture-deck', title: initial.title, activeRevisionId: 'fixture-v1', revisions: [
  { id: 'fixture-v1', label: 'v1', createdAt: '2026-10-09T12:00:00Z', producedBy: 'fixture' },
] };
const proof = { gets: 0, specs: 0, previews: 0, saves: 0, agentSubmissions: 0,
  dirty: false, selectedSlide: '', delayNextPreview: false, failNextPreview: false,
  releasePreview: null as (() => void) | null,
  currentSpec: null as DeckSpec | null, previewSpec: null as DeckSpec | null, savedSpec: structuredClone(initial) };
(window as typeof window & { __deckPresentFixture: typeof proof }).__deckPresentFixture = proof;
const api: DeckDocumentApi<Document> = {
  getDeck: async id => { if (id !== saved.id) throw new Error('Unknown fixture'); proof.gets++; return structuredClone(saved); },
  getSpec: async (id, revision) => { if (id !== saved.id || revision !== 'fixture-v1') throw new Error('Unknown fixture version'); proof.specs++; return structuredClone(initial); },
  saveRevision: async () => { proof.saves++; throw new Error('This rendering fixture forbids saving.'); },
  isConflict: () => false,
};
const xmlEscapes: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
const xml = (value: string) => value.replace(/[<>&"]/g, character => xmlEscapes[character]);
const image = (title: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="white"/><text x="60" y="110" font-family="Arial" font-size="38" fill="#172033">${xml(title)}</text></svg>`;
async function previewDeck(_id: string, spec: DeckSpec) {
  proof.previews++; proof.previewSpec = structuredClone(spec);
  if (proof.delayNextPreview) {
    proof.delayNextPreview = false;
    await new Promise<void>(resolve => { proof.releasePreview = () => { proof.releasePreview = null; resolve(); }; });
  }
  if (proof.failNextPreview) { proof.failNextPreview = false; throw new Error('Fixture render unavailable.'); }
  return { slides: [...spec.slides.map(slide => ({ id: slide.id, svg: image(slide.title), title: slide.title })),
    { id: 'sources', title: 'Sources', generated: true, svg: image('Sources') }], warnings: [] };
}
function useExtras(doc: DeckEditorDocument<Document>): DeckEditorExtras {
  proof.dirty = doc.dirtyRef.current; proof.currentSpec = doc.spec ? structuredClone(doc.spec) : null;
  return { sourceOptions: true, footer: context => {
    proof.selectedSlide = context.selectedSlide?.id ?? context.selectedGeneratedSlide?.id ?? '';
    return <div data-testid="fixture-editor-footer" data-selected-slide={proof.selectedSlide}>
      <ConversationComposer channel={null} context={{ kind: 'document', id: saved.id, title: saved.title }}
        capabilities={{ maySend: false, agent: { allowed: true } }} claim={{ label: 'the test presentation' }} answersFocus
        expanded defaultMode="agent" onAgent={() => { proof.agentSubmissions++; return false; }}
        composerTestId="fixture-editor-question-input" data-testid="fixture-editor-composer" />
    </div>;
  } };
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><div className="flex h-screen min-h-0 flex-col">
  <DeckEditorPage deckId={saved.id} api={api} previewDeck={previewDeck} fileUrl={() => '/__fixture-file-never-requested'}
    tenant="orgiq" testIdPrefix="fixture-deck" readOnly={false} canShare={() => false} useExtras={useExtras} />
</div></BrowserRouter>);
