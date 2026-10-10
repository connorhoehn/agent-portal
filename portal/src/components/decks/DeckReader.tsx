// The library's read-only PresentationEditor returns before its frame/footer.
// Compose its supported viewing primitives in the same host frame instead.
// This reader receives no document mutation, save or agent-revise callback.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, EmptyState, Inline, LoadingState, T, Textarea } from '@connorhoehnslalom/ui-components/shared';
import { Filmstrip, SlideStage, canSaveDeck,
  type DeckSlide, type DeckSpec, type PresentationEditorFrame, type PresentationEditorProps,
  type PresentationFooterContext, type PresentationPreview, type SlideListItem,
} from '@connorhoehnslalom/ui-components/doc-editor';
import { useComposerFocus } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { DeckPresentationDialog } from './DeckPresentationDialog';
import './DeckReader.css';

interface ReaderSlide { id: string; title: string; svg?: string; slide?: DeckSlide; generated: boolean }
export interface DeckReaderProps {
  spec: DeckSpec;
  preview: PresentationPreview;
  /** The supplied images were rendered from this exact saved specification. */
  previewCurrent?: boolean;
  onRequestPreview: (spec: DeckSpec) => void;
  slideViewers?: PresentationEditorProps['slideViewers'];
  selectSlideRequest?: PresentationEditorProps['selectSlideRequest'];
  onSelectedSlideChange?: (slideId: string) => void;
  /** Explicit viewer navigation; follow requests only report selection above. */
  onNavigateSlide?: (slideId: string) => void;
  renderFrame: (frame: PresentationEditorFrame) => ReactNode;
  footer?: (context: PresentationFooterContext) => ReactNode;
  'data-testid'?: string;
}
const noop = () => {};
const svgUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function DeckReader({ spec, preview, previewCurrent = true, onRequestPreview, slideViewers, selectSlideRequest,
  onSelectedSlideChange, onNavigateSlide, renderFrame, footer, 'data-testid': testId = 'deck-reader',
}: DeckReaderProps) {
  const [selectedId, setSelectedId] = useState(spec.slides[0]?.id ?? '');
  const [outline, setOutline] = useState(false), [notes, setNotes] = useState(true);
  const [zoom, setZoom] = useState('fit'), [presenting, setPresenting] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 800, height: 420 });
  const notesLabel = useId();
  const composerFocus = useComposerFocus();
  const request = useRef(onRequestPreview); request.current = onRequestPreview;
  const reportSelection = useRef(onSelectedSlideChange); reportSelection.current = onSelectedSlideChange;
  const renderable = canSaveDeck(spec);
  useEffect(() => { if (renderable) request.current(spec); }, [spec, renderable]);
  const previewError = typeof preview === 'object' && 'error' in preview ? preview.error : undefined;
  const previewLoading = (!previewCurrent || preview === 'loading') && !previewError;
  const images = previewCurrent && typeof preview === 'object' && 'slides' in preview ? preview.slides : [];
  const slides = useMemo<ReaderSlide[]>(() => {
    const rendered = new Map(images.map(slide => [slide.id, slide]));
    const own = new Set(spec.slides.map(slide => slide.id));
    return [
      ...spec.slides.map(slide => ({ id: slide.id, title: slide.title || 'Untitled slide', slide,
        svg: rendered.get(slide.id)?.svg, generated: false })),
      ...images.filter(slide => slide.generated && !own.has(slide.id)).map(slide => ({
        id: slide.id, title: slide.title || 'Sources', svg: slide.svg, generated: true,
      })),
    ];
  }, [spec.slides, images]);
  const index = Math.max(0, slides.findIndex(slide => slide.id === selectedId));
  const current = slides[index];
  const select = (id: string) => {
    if (!slides.some(slide => slide.id === id)) return;
    setSelectedId(id);
    onNavigateSlide?.(id);
  };
  useEffect(() => { if (current) reportSelection.current?.(current.id); }, [current?.id]);
  useEffect(() => {
    if (selectSlideRequest && slides.some(slide => slide.id === selectSlideRequest.slideId)) setSelectedId(selectSlideRequest.slideId);
  }, [selectSlideRequest?.key, slides]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setAvailable({ width, height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const step = (next: number) => { const slide = slides[Math.min(slides.length - 1, Math.max(0, next))]; if (slide) select(slide.id); };
  const navigateKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    const next = event.key === 'ArrowRight' || event.key === 'PageDown' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'PageUp' ? index - 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : null;
    if (next !== null) { event.preventDefault(); step(next); }
  };
  const stageWidth = zoom === 'fit'
    ? Math.max(120, Math.min(1024, available.width, available.height * 16 / 9))
    : 960 * Number(zoom) / 100;
  const toolbar = <Inline gap="xs" align="center" wrap className="deck-reader-toolbar" role="toolbar" aria-label="Presentation viewing tools">
    <Button size="sm" variant={outline ? 'secondary' : 'primary'} onClick={() => setOutline(false)} aria-pressed={!outline}>Slides</Button>
    <Button size="sm" variant={outline ? 'primary' : 'secondary'} onClick={() => setOutline(true)} aria-pressed={outline}>Outline</Button>
    <span className="deck-reader-toolbar-divider" aria-hidden="true" />
    <Button size="sm" variant="ghost" aria-label="Previous slide" disabled={index === 0} onClick={() => step(index - 1)}>←</Button>
    <T as="span" size="xs" className="deck-reader-position" data-testid={`${testId}-position`}>Slide {current ? index + 1 : 0} of {slides.length}</T>
    <Button size="sm" variant="ghost" aria-label="Next slide" disabled={index >= slides.length - 1} onClick={() => step(index + 1)}>→</Button>
    <label className="deck-reader-zoom"><span className="sr-only">Slide zoom</span>
      <select aria-label="Slide zoom" value={zoom} onChange={event => setZoom(event.target.value)}>
        <option value="fit">Fit</option><option value="75">75%</option><option value="100">100%</option><option value="125">125%</option>
      </select>
    </label>
    <Button size="sm" variant="secondary" aria-pressed={notes} onClick={() => setNotes(value => !value)}>Notes</Button>
    <span className="deck-reader-toolbar-spacer" />
    <Button size="sm" variant="ghost" disabled={!composerFocus.present} onClick={() => composerFocus.request({ mode: 'agent' })} title="Focus the presentation conversation">Chat & agent</Button>
    <Button size="sm" variant="primary" disabled={!current?.svg} onClick={() => setPresenting(true)}>Present</Button>
  </Inline>;
  const items: SlideListItem[] = spec.slides.map(slide => ({ slide, thumbnailSvg: slides.find(item => item.id === slide.id)?.svg, uncited: false }));
  const surface = <div className="deck-reader-surface" data-testid={testId}>
    <nav className="deck-reader-rail" aria-label={outline ? 'Presentation outline' : 'Slide thumbnails'}>
      {outline ? <ol className="deck-reader-outline">{slides.map((slide, at) => <li key={slide.id}>
        <button type="button" onClick={() => select(slide.id)} aria-current={current?.id === slide.id ? 'true' : undefined}>
          <span className="deck-reader-outline-number">{at + 1}</span><span><strong>{slide.title}</strong>
            {slide.slide?.bullets && <span className="deck-reader-outline-detail">{slide.slide.bullets.join(' · ')}</span>}
            {slide.generated && <span className="deck-reader-outline-detail">Generated from citations</span>}
          </span>
        </button>
      </li>)}</ol> : <Filmstrip items={items} selectedId={current?.id ?? ''} onSelect={select}
        onMove={noop} onDuplicate={noop} onDelete={noop} readOnly canAdd={false}
        generatedItems={slides.filter(slide => slide.generated).map(slide => ({ id: slide.id, title: slide.title, thumbnailSvg: slide.svg }))}
        slideViewers={slideViewers} testIdPrefix={`${testId}-filmstrip`} />}
    </nav>
    <main className="deck-reader-main" onKeyDown={navigateKeys}>
      <div className="deck-reader-viewport" ref={viewport} tabIndex={0} aria-label="Slide canvas. Use arrow keys to change slides." data-testid={`${testId}-viewport`}>
        {current ? <div className="deck-reader-slide-frame" style={{ width: stageWidth }}>
          <SlideStage className="deck-reader-stage" label={`Slide ${index + 1} of ${slides.length}: ${current.title}`} data-testid={`${testId}-stage`}>
            {current.svg ? <img src={svgUri(current.svg)} alt={current.title} />
              : previewLoading ? <div data-testid={`${testId}-preview-loading`}><LoadingState label="Rendering the current version…" /></div>
                : <div className="deck-reader-no-preview"><T size="sm">{typeof preview === 'object' && 'error' in preview ? preview.error : 'This slide’s preview is unavailable.'}</T>
                  {renderable && <Button size="sm" variant="secondary" onClick={() => request.current(spec)}>Retry preview</Button>}
                </div>}
          </SlideStage>
        </div> : <EmptyState title="No slides yet" body="This saved version contains no slides." />}
      </div>
      {notes && <div className="deck-reader-notes">
        {current?.slide ? <section className="deck-reader-note-panel" aria-labelledby={notesLabel}>
          <label htmlFor={`${notesLabel}-text`} id={notesLabel}><T as="span" size="xs" weight="semibold">Speaker notes</T></label>
          <Textarea id={`${notesLabel}-text`} value={current.slide.notes ?? ''} readOnly autoResize minRows={2} maxRows={4}
            placeholder="No speaker notes on this slide." aria-labelledby={notesLabel} data-testid={`${testId}-notes`} />
        </section>
          : current?.generated ? <T size="xs" tone="secondary">This generated Sources slide has no speaker notes.</T> : null}
      </div>}
    </main>
  </div>;
  const context: PresentationFooterContext = { selectedSlide: current?.slide, selectedIndex: index, slideCount: slides.length,
    ...(current?.generated ? { selectedGeneratedSlide: { id: current.id, title: current.title, svg: current.svg } } : {}),
    selectSlide: select, markChanged: noop };
  return <>{renderFrame({ toolbar, actions: null, surface, footer: footer?.(context) ?? null })}
    <DeckPresentationDialog title={spec.title} slides={slides.map(slide => ({ id: slide.id, title: slide.title, svg: slide.svg ?? '', generated: slide.generated }))}
      open={presenting} onClose={() => setPresenting(false)} slideIndex={index} onSlideChange={step}
      loading={previewLoading} error={previewError} onRetry={renderable ? () => request.current(spec) : undefined} testId={`${testId}-present`} />
  </>;
}
