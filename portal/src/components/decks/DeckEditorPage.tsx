// The deck editor page initiative, pipeline-run and Social decks share: load,
// preview, save with a 409 banner, presence/Follow, share-to-Social and
// download, composed from the library's PresentationEditor. A tenant supplies
// its API, its test-id prefix, who may edit and its breadcrumbs; only
// capability, extra notices and the share rule vary between them.

import { useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Banner, Button, DownloadIcon, DropdownMenu, EmptyState, ErrorState, HistoryIcon, Inline, LoadingState, T, VisuallyHidden, type BreadcrumbItem } from '@connorhoehnslalom/ui-components/shared';
import { canSaveDeck, DeckPresentationDialog, DeckReader, EditorShell, PresentationEditor, nextRevisionLabel, type PresentationEditorFrame, type PresentationFooterContext } from '@connorhoehnslalom/ui-components/doc-editor';
import { DeckConflictBanner } from './DeckConflictBanner';
import { deckSaveState } from './deckDocumentModel';
import { useDeckCollaboration } from './useDeckCollaboration';
import { useDeckDocument, type DeckDocumentApi, type DeckDocumentShape } from './useDeckDocument';
import { deckFileName, deckRenderKey, deckSourceOptions, revisionSeq } from './decksModel';
import { ShareToSocialAction } from './ShareToSocialAction';
import { DeckPresenceSource } from './useDeckPresence';
import { useDeckPreview } from './useDeckPreview';
import { useDeckDownload, useDeckSlideTitle } from './useDeckEditorHelpers';
import type { DeckPreviewResult, DeckSpec } from './deckApi';
import { useCallBlock, useCallHost } from '../../lib/conversationCall';
import { HuddleComposerDock } from '../shell/HuddleComposerDock';
import { useComposerFocus } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { useCrumbLabel } from '../../lib/crumbLabels';
import './deckReviewLayout.css';

/** What an extras hook may read and drive: the shared document state. */
export interface DeckEditorDocument<D> {
  deckId: string;
  deck: D | null;
  revisionId: string | null;
  /** Revision whose spec is actually on screen while a selection loads. */
  specRevisionId?: string | null;
  setRevisionId: (id: string | null) => void;
  spec: DeckSpec | null;
  dirtyRef: MutableRefObject<boolean>;
  reload: () => Promise<D | null>;
  setConflict: (conflict: boolean) => void;
}

/** Extra chrome a tenant layers on the shared page (assessment: agent runs). */
export interface DeckEditorExtras {
  /** Shown first in the notice stack, before the conflict banner. */
  notices?: ReactNode;
  /** A run is in flight: the empty/loading states stay quiet while it builds the first version. */
  busy?: boolean;
  /** Footer under the editor (the instruct composer); omitted when absent. */
  footer?: (ctx: PresentationFooterContext) => ReactNode;
  /** Tenant-owned assistant/dialogue registered with the existing shell pane. */
  assistant?: ReactNode;
  generatingSlideIds?: string[];
  /** Offer the deck's own source options on slides. */
  sourceOptions?: boolean;
}

export interface DeckEditorPageProps<D extends DeckDocumentShape & { title: string }> {
  deckId: string;
  api: DeckDocumentApi<D>;
  previewDeck: (deckId: string, spec: DeckSpec, signal?: AbortSignal) => Promise<DeckPreviewResult>;
  fileUrl: (deckId: string, revisionId: string) => string;
  /** Presence/Follow channel tenant (`<tenant>:deck:<id>`). */
  tenant: 'assessment' | 'pipelines' | 'orgiq' | 'social';
  /** `<prefix>-shell`, `-editor` and `-conflict` test ids. */
  testIdPrefix: string;
  /** What the thing is called in the conflict banner and copy: 'deck' or 'report'. */
  noun?: 'deck' | 'report';
  /** Who may not edit: fixed by capability, or decided from the loaded deck. */
  readOnly: boolean | ((deck: D) => boolean);
  /** @deprecated Unused: the shell's trail carries the path; the editor draws none. */
  breadcrumbs?: (deck: D, navigate: ReturnType<typeof useNavigate>) => BreadcrumbItem[];
  /** Notices shown under the conflict banner. */
  extraNotices?: (deck: D) => ReactNode;
  /** Whether the Post-to-Social action is offered (default: always). */
  canShare?: (deck: D) => boolean;
  /** Hold the first-open revision selection back (assessment: while a run is pending). */
  canAutoOpen?: (deck: D) => boolean;
  /** A hook called every render (pass a module-level function): the tenant's run UI. */
  useExtras?: (doc: DeckEditorDocument<D>) => DeckEditorExtras;
  /** An initiative status deck joins its parent initiative's existing huddle. */
  huddle?: (deck: D) => { channel: string; title: string };
  /** Follow a teammate's saved revision while this editor has no unsaved changes. */
  followLatest?: boolean;
}

const NO_EXTRAS: DeckEditorExtras = {};

export function DeckEditorPage<D extends DeckDocumentShape & { title: string }>(props: DeckEditorPageProps<D>) {
  // A previous document's pending loads/saves cannot populate a new editor.
  return <DeckEditorDocumentPage key={props.deckId} {...props} />;
}

function DeckEditorDocumentPage<D extends DeckDocumentShape & { title: string }>(props: DeckEditorPageProps<D>) {
  const { deckId, api, previewDeck, fileUrl, tenant, testIdPrefix, noun = 'deck', readOnly, extraNotices, canShare, canAutoOpen, useExtras } = props;
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [presentSlideId, setPresentSlideId] = useState<string | null>(null);
  const savingNow = useRef(false);
  const composerFocus = useComposerFocus();
  // The library reader/presentation take the page's conversation as a callback; absent, their Chat & agent control is disabled.
  const focusConversation = composerFocus.present ? () => composerFocus.request({ mode: 'agent' }) : undefined;
  const collab = useDeckCollaboration();
  const {
    deck, loadError, reload, revisionId, specRevisionId, setRevisionId, spec, setSpec, specError, conflict, setConflict,
    dirty, dirtyRef, active, editorRevisions, save, loadLatest, selectRevision,
  } = useDeckDocument(deckId, api, { ...(canAutoOpen ? { canAutoOpen } : {}), followLatest: props.followLatest });
  useCrumbLabel(deckId, deck?.title);
  const huddle = deck ? props.huddle?.(deck) : null;
  const call = useCallBlock(huddle?.channel ?? null, {
    compact: true,
    bind: huddle ? { title: huddle.title } : null,
    documents: deck ? [{ id: deckId, title: deck.title }] : [],
  });
  const callHost = useCallHost();
  const compactReview = call.holds && !!callHost && !['ended', 'failed'].includes(callHost.call.phase);
  const extras = useExtras?.({ deckId, deck, revisionId, specRevisionId, setRevisionId, spec, dirtyRef, reload, setConflict }) ?? NO_EXTRAS;
  const huddlePage = huddle?.channel.startsWith('orgiq:initiative:') ? { kind: 'initiative' as const, id: huddle.channel.slice('orgiq:initiative:'.length) } : undefined;
  const { preview, renderedKey, request } = useDeckPreview(deckId, setWarnings, previewDeck);
  const sourceOptions = useMemo(() => (extras.sourceOptions ? deckSourceOptions(spec) : []), [spec, extras.sourceOptions]);
  const slideTitle = useDeckSlideTitle(spec);
  const { download, downloading, error: downloadError } = useDeckDownload(fileUrl, deckId, revisionId,
    deckFileName(deck?.title ?? 'Presentation', revisionId && deck ? revisionSeq(deck.revisions, revisionId) : 1));

  // The shell's trail (breadcrumbResolve.ts) is the only trail; the page's h1
  // follows it (docs/layout-cascade.md rule 3). Until a deck loads that h1 is
  // this hidden one; once it loads, the editor shell's title is the h1.
  const pageTitle = <VisuallyHidden as="h1">{deck?.title || (noun === 'report' ? 'Run report' : 'Deck')}</VisuallyHidden>;
  if (loadError && !deck) return <>{pageTitle}<ErrorState title={`Couldn't open the ${noun}`} description={loadError} actionLabel="Retry" onAction={() => void reload()} /></>;
  if (!deck) return <>{pageTitle}<LoadingState label={`Opening the ${noun}…`} /></>;

  const saveState = deckSaveState(!!spec, dirty, nextRevisionLabel(deck.revisions), active);
  const shareable = canShare ? canShare(deck) : true;
  const cannotEdit = typeof readOnly === 'function' ? readOnly(deck) : readOnly;
  const currentVersion = revisionId ? `v${revisionSeq(deck.revisions, revisionId)}` : 'Versions';
  const hasSources = !!spec && canSaveDeck(spec);
  const saveDisabled = cannotEdit || saving || !dirty || !hasSources;
  const saveHint = cannotEdit ? 'This presentation is read-only.' : !dirty ? 'All changes saved.'
    : !hasSources ? 'Add a source to each slide before saving.' : `Save as ${nextRevisionLabel(deck.revisions)}`;
  const saveChanges = async () => {
    if (!spec || saveDisabled || savingNow.current) return;
    savingNow.current = true;
    setSaving(true); setSaveError(null);
    try { await save(spec); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'The presentation could not be saved.'); }
    finally { savingNow.current = false; setSaving(false); }
  };
  const notices = (
    <>
      {extras.notices}
      {saveError && !conflict && <Banner variant="error" title="Presentation could not be saved">{saveError}</Banner>}
      {downloadError && <Banner variant="error" title="Presentation could not be downloaded" data-testid={`${testIdPrefix}-download-error`}>{downloadError}</Banner>}
      {collab.presence.editingElsewhere && (
        <Banner variant="warning" title={`You have unsaved edits to this ${noun} in another tab`} data-testid={`${testIdPrefix}-editing-elsewhere`} />
      )}
      {conflict && <DeckConflictBanner noun={noun} onReload={loadLatest} testId={`${testIdPrefix}-conflict`} />}
      {extraNotices?.(deck)}
    </>
  );

  if (!spec) {
    return (
      <EditorShell title={deck.title} surface="plain" className="min-h-0 flex-1" data-testid={`${testIdPrefix}-shell`}>
        {notices}
        {specError ? <ErrorState title="This version cannot be opened" description={specError} />
          : extras.busy ? null
            : deck.revisions.length === 0 ? <EmptyState title="No versions yet" body={`The ${noun} has no saved version.`} />
              : <LoadingState label="Reading the slides…" />}
      </EditorShell>
    );
  }

  const previewCurrent = renderedKey === deckRenderKey(spec);
  const presentationError = !hasSources ? 'Add a source to each slide before presenting.'
    : typeof preview === 'object' && 'error' in preview ? preview.error : undefined;
  const presentationSlides = previewCurrent && typeof preview === 'object' && 'slides' in preview ? preview.slides.map(slide => ({
    ...slide, title: spec.slides.find(own => own.id === slide.id)?.title ?? slide.title,
  })) : [];
  const presentSlideIndex = Math.max(0, presentationSlides.findIndex(slide => slide.id === presentSlideId));
  const fileActions = (
    <Inline gap="xs" align="center" wrap={false} className="deck-document-actions" role={compactReview && cannotEdit ? undefined : 'toolbar'} aria-label="Presentation file actions">
      {!cannotEdit && extras.footer && <Button size="sm" variant="ghost" disabled={!composerFocus.present}
        onClick={() => composerFocus.request({ mode: 'agent' })} title="Focus the presentation conversation">Chat & agent</Button>}
      <DropdownMenu trigger={<Inline gap="xs" align="center" wrap={false}><HistoryIcon size={14} /><T size="xs" weight="medium">{currentVersion}</T></Inline>}
        triggerLabel="Presentation versions" triggerVariant="default" align="end"
        sections={[{ label: 'Saved versions', items: editorRevisions.map(revision => ({
          id: revision.id, label: `v${revisionSeq(deck.revisions, revision.id)}`, description: revision.label,
          active: revision.id === revisionId, disabled: revision.specAvailable === false || dirty || saving,
          disabledReason: revision.specAvailable === false ? 'Slide content unavailable · Metadata only' : dirty ? 'Save your changes before switching versions.' : saving ? 'Saving this version…' : undefined,
          onSelect: () => { setSaveError(null); selectRevision(revision.id); },
        })) }]} />
      {!cannotEdit && <Button size="sm" variant="primary" disabled={saveDisabled} title={saveHint}
        aria-label={saving ? 'Saving presentation' : `Save as ${nextRevisionLabel(deck.revisions)}`}
        onClick={() => { void saveChanges(); }} data-testid={`${testIdPrefix}-save`}>{saving ? 'Saving…' : 'Save'}</Button>}
      {revisionId && <Button size="sm" variant="secondary" disabled={dirty || saving || downloading} onClick={download} aria-label={downloading ? 'Downloading .pptx' : 'Download .pptx'}
        title={dirty ? 'Save your changes before downloading.' : 'Download the saved PowerPoint version'} data-testid={`${testIdPrefix}-download`}>
        <DownloadIcon size={14} /><T as="span" size="xs">{downloading ? 'Downloading…' : 'PPTX'}</T>
      </Button>}
      {revisionId && shareable && (
        <ShareToSocialAction deckId={deckId} revisionId={revisionId} fileName={deckFileName(deck.title, revisionSeq(deck.revisions, revisionId))}
          fileUrl={fileUrl(deckId, revisionId)} disabled={dirty || saving} />
      )}
    </Inline>
  );
  const frame = (parts: PresentationEditorFrame) => (
    <EditorShell
      title={deck.title}
      titleSize="md"
      // No `kind` mark: its 40px glyph + 8px gap would push the h1 48px past
      // EditorShell's 20px head inset, off the shell trail (docs/ui-components-queue.md).
      {...collab.shellProps}
      {...(cannotEdit ? { statusPill: <T as="span" size="xs" tone="secondary">View only</T> }
        : saveState ? { saveState: { ...saveState, detail: saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved' } } : {})}
      headActions={compactReview && cannotEdit ? null : fileActions}
      surface="workspace" toolbar={parts.toolbar}
      {...(parts.footer ? { footer: parts.footer } : {})}
      className={`min-h-0 flex-1 deck-review-workspace${compactReview ? ' deck-review-compact' : ''}`} data-testid={`${testIdPrefix}-shell`}
    >
      {notices}
      {collab.followBar}
      {parts.surface}
    </EditorShell>
  );

  return (
    <>
      <DeckPresenceSource deckId={deckId} tenant={tenant} selectedSlideId={collab.selectedSlideId} slideTitle={slideTitle} editing={dirty} onChange={collab.setPresence} />
      {extras.assistant}
      {cannotEdit ? <DeckReader onFocusConversation={focusConversation} compactReview={compactReview} fileActions={compactReview ? fileActions : null} spec={spec} preview={preview} previewCurrent={previewCurrent} onRequestPreview={request}
        slideViewers={collab.presence.slideViewers} selectSlideRequest={collab.selectSlideRequest}
        onSelectedSlideChange={collab.setSelectedSlideId} onNavigateSlide={collab.selectSlide} renderFrame={frame}
        footer={ctx => extras.footer ? extras.footer(ctx) : <HuddleComposerDock dock={call.block} page={huddlePage} />}
        data-testid={`${testIdPrefix}-reader`} /> : <PresentationEditor
        spec={spec} onChange={setSpec} preview={preview} onRequestPreview={request}
        onSaveRevision={save} revisions={editorRevisions} activeRevisionId={revisionId ?? ''}
        onSelectRevision={selectRevision}
        sources={sourceOptions}
        {...(revisionId ? { onDownload: download } : {})}
        onOpenPresentationView={at => {
          setPresentSlideId(at?.slideId ?? collab.selectedSlideId ?? presentationSlides[0]?.id ?? null);
          setPresenting(true);
        }}
        readOnly={cannotEdit}
        slideViewers={collab.presence.slideViewers}
        selectSlideRequest={collab.selectSlideRequest}
        onSelectedSlideChange={collab.setSelectedSlideId}
        footer={ctx => extras.footer ? extras.footer(ctx) : <HuddleComposerDock dock={call.block} page={huddlePage} />}
        {...(extras.generatingSlideIds ? { generatingSlideIds: extras.generatingSlideIds } : {})}
        renderFrame={frame}
        className="min-h-0 flex-1" data-testid={`${testIdPrefix}-editor`}
        {...(warnings.length > 0 ? { 'data-warnings': String(warnings.length) } : {})}
      />}
      {!cannotEdit && <DeckPresentationDialog onFocusConversation={focusConversation} title={spec.title} slides={presentationSlides}
        open={presenting} onClose={() => setPresenting(false)} slideIndex={presentSlideIndex}
        loading={!previewCurrent && !presentationError} error={presentationError}
        {...(hasSources && presentationError ? { onRetry: () => request(spec) } : {})}
        onSlideChange={index => {
          const slide = presentationSlides[index];
          if (slide) { setPresentSlideId(slide.id); collab.selectSlide(slide.id); }
        }} testId={`${testIdPrefix}-present`} />}
    </>
  );
}
