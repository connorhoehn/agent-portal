// Actual deck question hook, composer and agent pane; all saved content and
// API responses are inert, owned rendering fixtures. No call/media or write.
import '../../src/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { SidePaneProvider, SidePaneSplit } from '@connorhoehn/ui-components';
import { DeckEditorPage, type DeckEditorDocument } from '../../src/components/decks/DeckEditorPage';
import { useDeckAgentRun } from '../../src/components/decks/useDeckAgentRun';
import { HuddleChatProvider } from '../../src/components/shell/HuddleChat';
import type { DeckDetailCore, DeckSpec } from '../../src/components/decks/deckApi';
import { calls, runtime } from './deck-review-runtime';
runtime.active = false;
export const spec: DeckSpec = { title: 'Observability review fixture', slides: [
  { id: 'summary', layout: 'bullets', title: 'Summary', bullets: ['The summary-only figure is 42.'], sources: [{ documentId: 'fixture-summary', title: 'Summary fixture' }] },
  { id: 'sprints', layout: 'chart', title: 'Sprints', chart: { kind: 'bar', labels: ['Sprint 98', 'Sprint 99'], series: [{ name: 'Delivered', values: [18, 5] }] },
    notes: 'Validate span metrics before decommissioning.', sources: [{ documentId: 'fixture-sprints', title: 'Sprint fixture' }] },
] };
const deck: DeckDetailCore & { projectId: string } = { id: 'idk-fixture-question', projectId: 'fixture-project', title: spec.title, activeRevisionId: 'irev-fixture-v7',
  revisions: Array.from({ length: 7 }, (_, index) => ({ id: `irev-fixture-v${7 - index}`, label: `v${7 - index}`, createdAt: '2026-10-10T12:00:00Z', producedBy: 'fixture' })) };
const proof = { writes: 0, initialSpec: JSON.stringify(spec), head: deck.activeRevisionId };
(window as any).__deckQuestionStream = { proof, deck, spec };
const forbidWrite = async (): Promise<never> => { proof.writes++; throw new Error('Inert fixture forbids writes.'); };
const api = { getDeck: async () => structuredClone(deck), getSpec: async () => structuredClone(spec), saveRevision: forbidWrite, isConflict: () => false };
function useExtras(doc: DeckEditorDocument<typeof deck>) {
  return useDeckAgentRun(doc, { questionAgent: 'orgiq-supervisor', canInstruct: false, hints: [], progressTitle: () => 'Inert fixture', reviseNow: forbidWrite });
}
const preview = async () => ({ slides: spec.slides.map(slide => ({ id: slide.id, title: slide.title,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="white"/><text x="60" y="110" font-family="Arial" font-size="36">${slide.title}</text></svg>` })), warnings: [] });
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter>
  <calls.CallHostProvider self={{ userId: runtime.session.sub, displayName: runtime.session.name }} tenant="orgiq" scopeKey="fixture-question"
    platformApiUrl="inert:platform" getIdToken={() => ''} videoUrl="inert:video" gateway={null} gatewayConfigured connectionState="connected">
    <HuddleChatProvider><SidePaneProvider storageKey="fixture.deck-question-pane" defaultOpen><SidePaneSplit className="h-screen min-h-0" data-testid="shell-split">
      <DeckEditorPage deckId={deck.id} api={api} previewDeck={preview} fileUrl={() => '/__never-download'} tenant="orgiq" testIdPrefix="question-stream"
        readOnly canShare={() => false} useExtras={useExtras} />
    </SidePaneSplit></SidePaneProvider></HuddleChatProvider>
  </calls.CallHostProvider>
</BrowserRouter></StrictMode>);
