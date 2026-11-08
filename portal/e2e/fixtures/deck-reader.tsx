// Rendering/control regression only: no API writes, call or original deck.
import '../../src/app.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorShell, deckViewerToParticipant, type DeckSpec, type PresentationEditorFrame, type PresentationPreview } from '@connorhoehn/ui-components/doc-editor';
import { DeckReader } from '@connorhoehn/ui-components/doc-editor';
import { ConversationComposer } from '../../src/lib/conversationComposer';
import { useDeckCollaboration } from '../../src/components/decks/useDeckCollaboration';

const spec: DeckSpec = { title: 'Read-only presentation', slides: [
  { id: 'summary', layout: 'title', title: 'Summary', notes: 'Start with the outcome.', sources: [{ documentId: 'fixture', title: 'Source' }] },
  { id: 'details', layout: 'bullets', title: 'Validation next', bullets: ['Confirm the dependency map', 'Replay the outage'], notes: 'Keep the affected services visible.', sources: [{ documentId: 'fixture', title: 'Source' }] },
] };
const image = (title: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="white"/><text x="60" y="110" font-family="Arial" font-size="38" fill="#172033">${title}</text></svg>`;
const draw = (value: DeckSpec) => ({ slides: [...value.slides.map(slide => ({ id: slide.id, svg: image(slide.title) })), { id: 'sources', title: 'Sources', generated: true, svg: image('Sources') }] });
(window as typeof window & { __deckFixtureSpec: string }).__deckFixtureSpec = JSON.stringify(spec);
function Fixture() {
  const collab = useDeckCollaboration();
  const [visibleSpec, setVisibleSpec] = useState(spec);
  const [preview, setPreview] = useState<PresentationPreview>(draw(spec));
  const [previewCurrent, setPreviewCurrent] = useState(true);
  const [teammateSlide, setTeammateSlide] = useState('summary');
  useEffect(() => {
    const viewer = { id: 'fixture-peer', clientId: 'fixture-peer-tab', name: 'Fixture teammate', detail: 'viewing this deck', slideId: teammateSlide };
    const viewers = [viewer, { id: 'fixture-other', clientId: 'fixture-other-tab', name: 'Other teammate', detail: 'viewing this deck', slideId: 'sources' }];
    collab.setPresence({ viewers, participants: viewers.map(value => deckViewerToParticipant(value)),
      slideViewers: Object.fromEntries(['summary', 'details', 'sources'].map(id => [id, viewers.filter(value => value.slideId === id)])), editingElsewhere: false });
  }, [teammateSlide, collab.setPresence]);
  const frame = (parts: PresentationEditorFrame) => <EditorShell title={visibleSpec.title} kind="presentation" toolbar={parts.toolbar}
    footer={parts.footer} {...collab.shellProps} className="min-h-0 flex-1" data-testid="fixture-shell">{collab.followBar}{parts.surface}</EditorShell>;
  return <div className="flex h-screen min-h-0 flex-col" data-testid="fixture-root"
    data-selected-slide={collab.selectedSlideId} data-following={!!collab.shellProps.followingParticipantId}>
    <div>
      <button type="button" disabled={!collab.shellProps.onFollowParticipant} aria-pressed={!!collab.shellProps.followingParticipantId}
        onClick={() => collab.shellProps.onFollowParticipant?.('fixture-peer')}>Follow teammate</button>
      <button type="button" onClick={() => setTeammateSlide('summary')}>Teammate: Summary</button>
      <button type="button" onClick={() => setTeammateSlide('details')}>Teammate: Details</button>
      <button type="button" onClick={() => setTeammateSlide('sources')}>Teammate: Sources</button>
      <button type="button" disabled={!collab.shellProps.onFollowParticipant} onClick={() => {
        setTeammateSlide('sources');
        if (!collab.shellProps.followingParticipantId) collab.shellProps.onFollowParticipant?.('fixture-peer');
      }}>Follow last slide</button>
      <button type="button" onClick={() => {
        setVisibleSpec({ ...spec, title: 'Read-only presentation v2', slides: spec.slides.map((slide, index) => index === 0 ? { ...slide, title: 'Updated summary' } : slide) });
        setPreviewCurrent(false);
      }}>Load next saved version</button>
      <button type="button" onClick={() => { setPreview(draw(visibleSpec)); setPreviewCurrent(true); }}>Finish current preview</button>
      <button type="button" onClick={() => { setPreview({ error: 'Current render failed' }); setPreviewCurrent(false); }}>Fail current preview</button>
    </div>
    <DeckReader spec={visibleSpec} preview={preview} previewCurrent={previewCurrent} onRequestPreview={() => {}} renderFrame={frame}
      selectSlideRequest={collab.selectSlideRequest} onSelectedSlideChange={collab.setSelectedSlideId} onNavigateSlide={collab.selectSlide}
      footer={context => <div data-testid="fixture-footer" data-slide={context.selectedSlide?.id ?? context.selectedGeneratedSlide?.id}>
        <ConversationComposer channel={null} context={{ kind: 'document', id: 'reader-fixture', title: spec.title }}
          capabilities={{ maySend: false, agent: { allowed: true } }} claim={{ label: 'the test presentation' }} answersFocus
          expanded defaultMode="agent" onAgent={() => true} composerTestId="fixture-question-input" data-testid="fixture-composer" />
      </div>} data-testid="fixture-reader" />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
