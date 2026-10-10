import '../../src/app.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { SidePaneProvider, SidePaneSplit } from '@connorhoehnslalom/ui-components';
import type { DeckSpec } from '@connorhoehnslalom/ui-components/doc-editor';
import { DeckEditorPage, type DeckEditorExtras } from '../../src/components/decks/DeckEditorPage';
import { DeckComposer } from '../../src/components/decks/DeckComposer';
import { DeckAssistantPane } from '../../src/components/decks/DeckAssistantPane';
import { HuddleChatProvider } from '../../src/components/shell/HuddleChat';
import { calls, runtime } from './deck-review-runtime';
const initial: DeckSpec = { title: 'Observability review fixture', slides: [
  { id: 'summary', layout: 'title', title: 'Observability Platform', notes: 'Preserved summary notes.', sources: [{ documentId: 'fixture', title: 'Fixture source' }] },
  { id: 'sprints', layout: 'bullets', title: 'Sprints', bullets: ['Sprint 98: validate span metrics'], notes: 'Preserved sprint notes.', sources: [{ documentId: 'fixture', title: 'Fixture source' }] },
] };
const proof = { asks: [] as Array<{ text: string; context: unknown; reference: boolean }>, saves: 0 };
(window as any).__deckReviewFixture = { runtime, proof };
const saved = { id: 'fixture-deck', title: initial.title, activeRevisionId: 'fixture-v7', revisions: [{ id: 'fixture-v7', label: 'v7', createdAt: '2026-10-10T12:00:00Z', producedBy: 'fixture' }] };
const api = {
  getDeck: async () => structuredClone(saved), getSpec: async () => structuredClone(initial),
  saveRevision: async () => { proof.saves++; throw new Error('Fixture forbids saves.'); }, isConflict: () => false,
};
const image = (title: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="white"/><text x="60" y="110" font-family="Arial" font-size="36" fill="#152033">${title}</text></svg>`;
const previewDeck = async () => ({ slides: initial.slides.map(slide => ({ id: slide.id, title: slide.title, svg: image(slide.title) })), warnings: [] });
function useExtras(): DeckEditorExtras {
  return {
    assistant: <DeckAssistantPane deckTitle={saved.title} questionRequest={0} question={<p>Inert assistant output</p>} />,
    footer: ctx => <DeckComposer deckId={saved.id} deckTitle={saved.title} selectedSlideId={ctx.selectedSlide?.id} slideNumber={ctx.selectedIndex + 1}
      hints={[]} canAsk canInstruct={false} instruct={async () => { throw new Error('Fixture forbids edits.'); }} onChanged={() => {}}
      onAsk={(text, context, reference) => { proof.asks.push({ text, context, reference }); return true; }} />,
  };
}
function Fixture() {
  const [, redraw] = useState(0);
  return <calls.CallHostProvider self={{ userId: runtime.session.sub, displayName: runtime.session.name }} tenant="orgiq" scopeKey="fixture|reviewer"
    platformApiUrl="inert:platform" getIdToken={() => ''} videoUrl="inert:video" gateway={null} gatewayConfigured connectionState="connected">
    <HuddleChatProvider><div className="flex h-screen min-h-0 flex-col" data-testid="deck-review-fixture">
      <div className="flex h-14 items-center gap-4 px-3 shrink-0" data-testid="fixture-control-row">
        <span>Work · Review fixture</span><button onClick={() => { runtime.active = !runtime.active; redraw(value => value + 1); }}>Toggle fixture huddle</button>
      </div>
      <div className="flex h-6 items-center px-3 shrink-0 text-xs text-text-secondary">Initiatives › Fixture project › Observability review fixture</div>
      <SidePaneProvider storageKey="fixture.deck-review-pane" defaultOpen><SidePaneSplit className="min-h-0 flex-1" data-testid="shell-split" paneTestId="page-conversation-pane">
        <DeckEditorPage deckId={saved.id} api={api} previewDeck={previewDeck}
          fileUrl={() => '/__fixture-file-never-requested'} tenant="orgiq" testIdPrefix="fixture-review" readOnly canShare={() => false} useExtras={useExtras}
          huddle={() => ({ channel: 'orgiq:initiative:fixture-project', title: 'Fixture project huddle' })} />
      </SidePaneSplit></SidePaneProvider>
      <div className="flex h-11 items-center border-t border-border px-3 shrink-0 text-xs text-text-secondary">Fixture project huddle · inert participants · no real call controls</div>
      <calls.CallMediaOutlet />
    </div></HuddleChatProvider>
  </calls.CallHostProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><Fixture /></BrowserRouter></StrictMode>);
