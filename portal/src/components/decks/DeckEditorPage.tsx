// The deck editor page initiative, pipeline-run and Social decks share: load,
// preview, save with a 409 banner, presence/Follow, share-to-Social and
// download, composed from the library's PresentationEditor. A tenant supplies
// its API, its test-id prefix, who may edit and its breadcrumbs; only
// capability, extra notices and the share rule vary between them.

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Banner, Button, DetailSection, InlineAlert, DownloadIcon, DropdownMenu, EmptyState, ErrorState, HistoryIcon, Inline, LoadingState, Stack, T, VisuallyHidden, useShellFocusMode, type BreadcrumbItem } from '@connorhoehn/ui-components/shared';
import { addSlide, canSaveDeck, DeckReader, validateDeckSpec, EditorShell, LayoutGallery, PresentationEditor, nextRevisionLabel, type PresentationEditorFrame, type PresentationFooterContext, type SlideLayout } from '@connorhoehn/ui-components/doc-editor';
import { usePublishPageContext, usePublishPageTabs } from '../../lib/voice/pageContext';
import { DeckReportChartPanel, SAVE_FIRST_LINE } from './DeckReportChartPanel';
import { DECK_REVISED_EVENT, DECK_TENANT_THEME_NAMES, layoutPreviewMap, listChartReports, listDeckLayouts, type DeckChartReport } from './deckApi';
import { deckVoiceContext, DECK_LAYOUTS_TAB, DECK_TABS } from './deckVoiceContext';
import { DeckConflictBanner } from './DeckConflictBanner';
import { deckSaveState } from './deckDocumentModel';
import { useDeckCollaboration } from './useDeckCollaboration';
import { useDeckDocument, type DeckDocumentApi, type DeckDocumentShape } from './useDeckDocument';
import { DECK_EXPORTS, deckFileName, deckRenderKey, deckSourceOptions, revisionSeq } from './decksModel';
import { ShareToSocialAction, ShareToSocialPanel } from './ShareToSocialAction';
import { DeckPresenceSource } from './useDeckPresence';
import { useDeckPreview } from './useDeckPreview';
import { DeckFindingsLine } from './DeckFindingsLine';
import { withPlaceholderSources } from './deckFindings';
import { draftRefusal, newSlideIds, withPlaceholderTitles } from './deckRefusal';
import { useDeckDownload, useDeckSlideTitle } from './useDeckEditorHelpers';
import type { DeckPreviewResult, DeckSpec } from './deckApi';
import { useCallBlock, useCallHost } from '../../lib/conversationCall';
import { HuddleComposerDock } from '../shell/HuddleComposerDock';
import { useComposerFocus } from '@connorhoehn/ui-components/social/rich-composer';
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
const validation = (spec: DeckSpec): readonly string[] => { const out = validateDeckSpec(spec); return out.ok ? [] : out.errors; };

export function DeckEditorPage<D extends DeckDocumentShape & { title: string }>(props: DeckEditorPageProps<D>) {
  // A previous document's pending loads/saves cannot populate a new editor.
  return <DeckEditorDocumentPage key={props.deckId} {...props} />;
}

function DeckEditorDocumentPage<D extends DeckDocumentShape & { title: string }>(props: DeckEditorPageProps<D>) {
  const { deckId, api, previewDeck, fileUrl, tenant, testIdPrefix, noun = 'deck', readOnly, extraNotices, canShare, canAutoOpen, useExtras } = props;
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reportPanel, setReportPanel] = useState(false);
  const [sharePanel, setSharePanel] = useState(false);
  const [titleToSelect, setTitleToSelect] = useState<string | null>(null);
  const savingNow = useRef(false);
  const focus = useShellFocusMode();
  // Presenting in place holds focus mode: the page's own chrome (findings, assistant pane, head actions) steps aside with the rails.
  const presenting = focus.active;
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  // `?tab=layouts` (the voice's `open { scope: 'this-page', tab: 'layouts' }`, or a link) shows the example layouts in place of the stage.
  const showLayouts = params.get('tab') === DECK_LAYOUTS_TAB;
  const closeLayouts = () => setParams(prev => { const next = new URLSearchParams(prev); next.delete('tab'); return next; }, { replace: true });
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
  const [layoutPreviews, setLayoutPreviews] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<DeckChartReport[]>([]);
  useEffect(() => {
    const ctl = new AbortController();
    // Previews only make the gallery nicer: without them it draws the library's schematics.
    listDeckLayouts(tenant, ctl.signal).then(out => setLayoutPreviews(layoutPreviewMap(out.layouts ?? []))).catch(() => undefined);
    listChartReports(tenant, deckId, ctl.signal).then(out => setReports(out.reports ?? [])).catch(() => undefined);
    return () => ctl.abort();
  }, [tenant, deckId]);
  // A revision written outside the editor (the voice's deck operations): reload and open it, unless edits are unsaved.
  useEffect(() => {
    const onRevised = (event: Event) => {
      const detail = (event as CustomEvent<{ deckId?: string; revisionId?: string }>).detail;
      if (detail?.deckId !== deckId || !detail.revisionId || dirtyRef.current) return;
      void reload().then(next => { if (next) setRevisionId(detail.revisionId!); });
    };
    window.addEventListener(DECK_REVISED_EVENT, onRevised);
    return () => window.removeEventListener(DECK_REVISED_EVENT, onRevised);
  }, [deckId, dirtyRef, reload, setRevisionId]);
  // The library's slide form has no focus API (docs/ui-components-queue.md): once the new slide's form shows, select its title.
  useEffect(() => {
    if (!titleToSelect || collab.selectedSlideId !== titleToSelect) return;
    const timer = window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${testIdPrefix}-editor-slide-title"]`);
      if (input) { input.focus({ preventScroll: true }); input.select(); }
      setTitleToSelect(null);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [titleToSelect, collab.selectedSlideId, testIdPrefix]);
  const cannotEditNow = deck ? (typeof readOnly === 'function' ? readOnly(deck) : readOnly) : true;
  usePublishPageContext(deck && spec ? deckVoiceContext({
    path: location.pathname, tenant, deckId, title: deck.title, spec, headRevisionId: deck.activeRevisionId,
    viewedRevisionId: revisionId, selectedSlideId: collab.selectedSlideId ?? null, dirty, readOnly: cannotEditNow,
  }) : null);
  usePublishPageTabs(deck && spec ? { path: location.pathname, tabs: DECK_TABS, tab: showLayouts ? DECK_LAYOUTS_TAB : 'slides' } : null);
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
  // The format's own check, said plainly ("Slide 2 needs a title."): Save stays off while the server would refuse the draft.
  const refusal = spec && dirty && !cannotEdit ? draftRefusal(validation(spec)) : null;
  const saveDisabled = cannotEdit || saving || !dirty || !hasSources || !!refusal;
  const saveHint = cannotEdit ? 'This presentation is read-only.' : !dirty ? 'All changes saved.'
    : !hasSources ? 'Add a source to each slide before saving.' : refusal ? `Not saved yet: ${refusal}` : `Save as ${nextRevisionLabel(deck.revisions)}`;
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
      {saveError && !conflict && <Banner variant="error" title="Presentation could not be saved" data-testid={`${testIdPrefix}-save-error`}>{saveError}</Banner>}
      {refusal && !presenting && <InlineAlert tone="warning" data-testid={`${testIdPrefix}-save-blocked`}>{`Before saving: ${refusal}`}</InlineAlert>}
      {downloadError && <Banner variant="error" title="Presentation could not be downloaded" data-testid={`${testIdPrefix}-download-error`}>{downloadError}</Banner>}
      {collab.presence.editingElsewhere && (
        <Banner variant="warning" title={`You have unsaved edits to this ${noun} in another tab`} data-testid={`${testIdPrefix}-editing-elsewhere`} />
      )}
      {conflict && <DeckConflictBanner noun={noun} onReload={loadLatest} testId={`${testIdPrefix}-conflict`} />}
      {extraNotices?.(deck)}
      {warnings.length > 0 && <DeckFindingsLine warnings={warnings} slideCount={spec?.slides.length ?? 0} testId={`${testIdPrefix}-preview-warnings`} />}
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
  const selectedIndex = Math.max(0, spec.slides.findIndex(slide => slide.id === collab.selectedSlideId));
  const selectedSlide = spec.slides[selectedIndex] ?? null;
  const onHead = !!revisionId && revisionId === deck.activeRevisionId;
  // The operations route works on the saved head: no unsaved edits, and the head in view (useDeckAgentRun's rule).
  const reportBlocked = dirty ? SAVE_FIRST_LINE : !onHead ? 'Open the newest version first: a report fills the saved head.' : null;
  const themes = [{ id: tenant, name: DECK_TENANT_THEME_NAMES[tenant] }];
  // A slide added in the editor cites the server's placeholder (`example:unsourced`), as `add_slide` does:
  // Save stays on, the preview draws it, and the findings line asks for the real source.
  // A new slide also starts with its layout's placeholder title ("Timeline", "Key figures"), selected for typing over.
  const withNewSlideDefaults = (next: DeckSpec) => withPlaceholderTitles(spec, withPlaceholderSources(spec, next));
  const editSpec = (next: DeckSpec) => {
    const added = newSlideIds(spec, next);
    setSpec(withNewSlideDefaults(next));
    if (added.length === 1) setTitleToSelect(added[0]!);
  };
  const addLayout = (layout: SlideLayout) => {
    const next = withNewSlideDefaults(addSlide(spec, selectedIndex, layout));
    setSpec(next);
    const added = next.slides[selectedIndex + 1];
    closeLayouts();
    if (added) { collab.selectSlide(added.id); setTitleToSelect(added.id); }
  };
  const layoutsPanel = (
    <DetailSection title="Example layouts" hint={`Choosing one adds it after slide ${selectedIndex + 1}`}
      actions={<Button size="sm" variant="ghost" onClick={closeLayouts} data-testid={`${testIdPrefix}-layouts-back`}>Back to the slides</Button>}
      data-testid={`${testIdPrefix}-layouts`}>
      <LayoutGallery onSelect={addLayout} previews={layoutPreviews} label="Slide layouts" testIdPrefix={`${testIdPrefix}-layout`} />
    </DetailSection>
  );
  const fileActions = (
    <Inline gap="xs" align="center" wrap={false} className="deck-document-actions" role={compactReview && cannotEdit ? undefined : 'toolbar'} aria-label="Presentation file actions">
      {!cannotEdit && reports.length > 0 && <Button size="sm" variant="ghost" aria-pressed={reportPanel} onClick={() => { setReportPanel(open => !open); setSharePanel(false); }}
        title={selectedSlide?.layout === 'chart' ? 'Fill this chart from a report' : 'Turn this slide into a chart from a report'} data-testid={`${testIdPrefix}-report-open`}>Fill from a report</Button>}
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
      {revisionId && <DropdownMenu trigger={<Inline gap="xs" align="center" wrap={false}><DownloadIcon size={14} /><T as="span" size="xs" weight="medium">{downloading ? 'Downloading…' : 'Download'}</T></Inline>}
        triggerLabel={downloading ? 'Downloading the presentation' : 'Download the presentation'} triggerVariant="default" align="end"
        triggerTitle={dirty ? 'Save your changes before downloading.' : 'Download the saved version'}
        disabled={dirty || saving || downloading} triggerTestId={`${testIdPrefix}-download-menu`}
        // The PowerPoint row keeps the old button's test id (portal/e2e reaches it by `<prefix>-download`).
        sections={[{ label: 'Download as', items: DECK_EXPORTS.map(item => ({
          id: item.format, label: item.label, onSelect: () => download(item.format),
          'data-testid': item.format === 'pptx' ? `${testIdPrefix}-download` : `${testIdPrefix}-download-${item.format}`,
        })) }]} />}
      {revisionId && shareable && (
        <ShareToSocialAction disabled={dirty || saving} open={sharePanel} onOpenChange={open => { setSharePanel(open); if (open) setReportPanel(false); }} />
      )}
    </Inline>
  );
  const reportPanelOpen = !cannotEdit && reportPanel && !presenting;
  const reportPanelNode = reportPanelOpen ? (
    <DeckReportChartPanel tenant={tenant} deckId={deckId} headRevisionId={deck.activeRevisionId} reports={reports} blockedReason={reportBlocked}
      slide={selectedSlide ? { id: selectedSlide.id, index: selectedIndex, title: selectedSlide.title, isChart: selectedSlide.layout === 'chart' } : null}
      onApplied={out => { setReportPanel(false); void reload().then(next => { if (next) setRevisionId(out.revision.id); }); }}
      onClose={() => setReportPanel(false)} testIdPrefix={testIdPrefix} />
  ) : null;
  // Share a copy opens in the same place as Fill from a report: under the toolbar, in the page's flow.
  const sharePanelNode = sharePanel && !presenting && revisionId && shareable && !dirty ? (
    <ShareToSocialPanel deckId={deckId} revisionId={revisionId} fileName={deckFileName(deck.title, revisionSeq(deck.revisions, revisionId))}
      fileUrl={fileUrl(deckId, revisionId)} onClose={() => setSharePanel(false)} />
  ) : null;
  const toolbarPanel = reportPanelNode ?? sharePanelNode;
  const frame = (parts: PresentationEditorFrame) => (
    <EditorShell
      title={deck.title}
      titleSize="md"
      // No `kind` mark: its 40px glyph + 8px gap would push the h1 48px past
      // EditorShell's 20px head inset, off the shell trail (docs/ui-components-queue.md).
      {...collab.shellProps}
      {...(cannotEdit ? { statusPill: <T as="span" size="xs" tone="secondary">View only</T> }
        : saveState ? { saveState: { ...saveState, detail: saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved' } } : {})}
      headActions={presenting || (compactReview && cannotEdit) ? null : fileActions}
      // Fill from a report (or Share) opens under the toolbar, above the stage: the toolbar row does not scroll, so selecting a
      // slide (which scrolls the surface to its stage) never carries the panel out of view.
      // The notices (findings line, banners) sit with the toolbar, above the scroller: in the scroller they made it taller than
      // its frame, so the whole editor scrolled a little as well as the editor's own region whenever the form took focus.
      surface="workspace" toolbar={toolbarPanel || !presenting ? <Stack gap="sm">{parts.toolbar}{toolbarPanel}{!presenting && notices}</Stack> : parts.toolbar}
      {...(parts.footer ? { footer: parts.footer } : {})}
      className={`min-h-0 flex-1 deck-review-workspace${compactReview ? ' deck-review-compact' : ''}`} data-testid={`${testIdPrefix}-shell`}
    >
      {!presenting && collab.followBar}
      {showLayouts && !cannotEdit ? layoutsPanel : parts.surface}
    </EditorShell>
  );

  return (
    <>
      <DeckPresenceSource deckId={deckId} tenant={tenant} selectedSlideId={collab.selectedSlideId} slideTitle={slideTitle} editing={dirty} onChange={collab.setPresence} />
      {!presenting && extras.assistant}
      {cannotEdit ? <DeckReader onFocusModeChange={focus.request} onFocusConversation={focusConversation} compactReview={compactReview} fileActions={compactReview ? fileActions : null} spec={spec} preview={preview} previewCurrent={previewCurrent} onRequestPreview={request}
        slideViewers={collab.presence.slideViewers} selectSlideRequest={collab.selectSlideRequest}
        onSelectedSlideChange={collab.setSelectedSlideId} onNavigateSlide={collab.selectSlide} renderFrame={frame}
        footer={ctx => extras.footer ? extras.footer(ctx) : <HuddleComposerDock dock={call.block} page={huddlePage} />}
        data-testid={`${testIdPrefix}-reader`} /> : <PresentationEditor
        spec={spec} onChange={editSpec} preview={preview} onRequestPreview={request}
        onSaveRevision={save} revisions={editorRevisions} activeRevisionId={revisionId ?? ''}
        onSelectRevision={selectRevision}
        sources={sourceOptions}
        {...(revisionId ? { onDownload: download } : {})}
        // Presents in place (ui-components 2.548.0): the editor's regions give way to the slide, and focus mode folds both left rails.
        previewCurrent={previewCurrent}
        showNotes
        onFocusModeChange={focus.request}
        // The tenant theme after the three built-ins; choosing it writes `theme: { ref: <tenant> }` through onChange.
        themes={themes}
        layoutPreviews={layoutPreviews}
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
    </>
  );
}
