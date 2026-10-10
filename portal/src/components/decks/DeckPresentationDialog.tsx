// Both reading and editing present the platform's existing slide previews.
// Selection stays in the host; opening/closing never changes the document.
import { Button, ErrorState, Inline, LoadingState, Modal, T } from '@connorhoehnslalom/ui-components/shared';
import { PresentationView, type PresentationPreviewSlide } from '@connorhoehnslalom/ui-components/doc-editor';
import { useComposerFocus } from '@connorhoehnslalom/ui-components/social/rich-composer';

export interface DeckPresentationDialogProps {
  title: string;
  slides: readonly PresentationPreviewSlide[];
  open: boolean;
  /** Zero-based, including the renderer's generated Sources slide. */
  slideIndex: number;
  onSlideChange: (index: number) => void;
  onClose: () => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  testId: string;
}
const noop = () => {};
export function DeckPresentationDialog({ title, slides, open, slideIndex, onSlideChange, onClose, loading = false, error, onRetry, testId }: DeckPresentationDialogProps) {
  const focus = useComposerFocus();
  const focusConversation = () => {
    onClose();
    // Let Modal remove its focus trap/restore the opener before moving the
    // caret into the existing shared composer. No new input or draft store.
    requestAnimationFrame(() => focus.request({ mode: 'agent' }));
  };
  return <Modal open={open} onClose={onClose} ariaLabel={`Present ${title}`} maxWidth={1280}
    cardStyle={{ height: 'min(90vh, 960px)', display: 'flex', flexDirection: 'column', padding: 16 }}>
    <Inline gap="sm" align="center" className="justify-between">
      <T size="sm" weight="semibold">Presenting</T>
      <Inline gap="xs" align="center">
        {focus.present && <Button size="sm" variant="secondary" onClick={focusConversation}>Chat & agent</Button>}
        <Button size="sm" variant="secondary" onClick={onClose}>Exit presentation</Button>
      </Inline>
    </Inline>
    {error ? <div className="flex min-h-0 flex-1 items-center justify-center" data-testid={`${testId}-error`}>
      <ErrorState title="Couldn't prepare the presentation" description={error}
        {...(onRetry ? { actionLabel: 'Retry preview', onAction: onRetry } : {})} />
    </div> : loading ? <div className="flex min-h-0 flex-1 items-center justify-center" data-testid={`${testId}-loading`}>
      <LoadingState label="Preparing your current slides…" />
    </div> : <PresentationView title={title} revisions={[{ id: 'current', label: 'Current', slides: slides.map((slide, index) => ({
      id: slide.id, index: index + 1, title: slide.title || `Slide ${index + 1}`,
      ...(slide.svg ? { preview: <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(slide.svg)}`}
        alt={slide.title || `Slide ${index + 1}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> } : {}),
    })) }]} revisionId="current" onRevisionChange={noop} slideIndex={slideIndex + 1}
      onSlideChange={index => onSlideChange(index - 1)} autoFocus className="min-h-0 flex-1" data-testid={testId} />}
  </Modal>;
}
