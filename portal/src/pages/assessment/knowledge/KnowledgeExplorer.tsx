// Shared document explorer for Workspace, Enterprise, Rules and Prompts.
// The library owns pane layout and rich editing. The gateway owns canvas
// content; the BFF retains source-bound comments, reactions and sync actions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ActivityFeed,
  Breadcrumbs,
  Button,
  ChevronIcon,
  DropdownMenu,
  EmptyState,
  ErrorState,
  Inline,
  InlinePlaceholder,
  LoadingState,
  MoreIcon,
  PlusIcon,
  RailSection,
  Stack,
  Toolbar,
  VisuallyHidden,
  IconButton,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { sendJson } from '../../../lib/writeJson';
import { DocPane, FolderPane } from './DocPane';
import { ActivityBar } from './ActivityBar';
import { DocumentLibrary } from './DocumentLibrary';
import { DocumentNavigationProvider, useDocumentNavigation } from './DocumentNavigation';
import { DocumentRail, useSectionPulls, type QuickView } from './DocumentRail';
import { ExplorerFrame } from './ExplorerFrame';
import { RenameNodeDialog } from './RenameNodeDialog';
import { NewDraftDialog, type DraftDestination } from './NewDraftDialog';
import { useAssessmentEvents } from './useAssessmentEvents';
import {
  MODE_LABEL,
  RELATED_LINKS,
  activityForSection,
  findNode,
  firstViewableLeaf,
  flatNodes,
  isFolderNode,
  moveParentForRail,
  nodePath,
  parseActivityRuns,
  pulledEventsForSection,
  sectionDocumentCount,
  sectionForNode,
  sectionsForMode,
  toActivityFeedItems,
  uploadTitle,
} from './knowledgeFormat';
import type {
  KnowledgeMode,
  KnowledgeSection,
  KnowledgeTreeResponse,
} from './types';

/** An uploaded file larger than this is refused before it is read — under the
 *  BFF's draft-body ceiling (DRAFT_MARKDOWN_MAX, 64K characters) with room to escape. */
const UPLOAD_MAX_BYTES = 48 * 1024;

// ─── Which single thing the main pane shows ─────────────────────────────────
// Mirrors the source's MainView: exactly one of a selected doc or the
// section's Activity list is ever on screen at once, and the rail (tree +
// Views block) is what drives which one. The "All comments" row from the
// source is gone — comments now live per-document, on DocPane's own chat
// drawer, which has a real backing (the channel's chat store) instead of an
// always-empty list.

type MainView = { kind: 'node' } | { kind: 'activity'; sectionKey: string };

// ─── The explorer ─────────────────────────────────────────────────────────

export interface KnowledgeExplorerProps {
  mode: KnowledgeMode;
}

export function KnowledgeExplorer(props: KnowledgeExplorerProps) {
  return <DocumentNavigationProvider><KnowledgeExplorerContent {...props} /></DocumentNavigationProvider>;
}
function KnowledgeExplorerContent({ mode }: KnowledgeExplorerProps) {
  const navigation = useDocumentNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<MainView>({ kind: 'node' });
  const [quickView, setQuickView] = useState<QuickView | null>(null);
  const sse = useAssessmentEvents();

  const treeFetch = useFetch<KnowledgeTreeResponse>('/api/assessment/knowledge/tree');
  const { can: canDo } = useCapabilities();
  const pulls = useSectionPulls(sse.events, treeFetch.refresh);

  // Preserve the accelerator's sibling/child placement. The shared tree
  // resolves drop positions; local and configured source trees use their
  // own authoritative move endpoint. Synthetic rows — a source's folder, its
  // Activity — are never moved, and a drop on a source's folder is a move to
  // that section's root (moveParentForRail).
  const [moveStatus, setMoveStatus] = useState<Record<string, 'pending' | 'moved'>>({});
  const [moveError, setMoveError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [creating, setCreating] = useState<DraftDestination | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Rename goes through the row's ⋯ (or a double-click) because `TreeViewProps`
  // has no `onRename` — see RenameNodeDialog.tsx. The dialog surfaces the
  // refusal itself, so this only has to refetch on success.
  async function handleRename(id: string, title: string) {
    await sendJson('/api/assessment/knowledge/doc/rename', 'POST', { id, title });
    await treeFetch.refresh();
  }

  async function handleReorder(id: string, railParentId: string | null, position: number) {
    const targetParentId = moveParentForRail(railParentId);
    setMoveError(null);
    setMoveStatus((m) => ({ ...m, [id]: 'pending' }));
    try {
      const sourceMove = id.startsWith('page:');
      if (sourceMove && !targetParentId) throw new Error('Source pages must remain beneath a source parent page.');
      const result = await sendJson<{ tree_refresh_failed?: boolean }>(sourceMove ? '/api/assessment/knowledge/source/move' : '/api/assessment/knowledge/doc/move', 'POST', { id, parentId: targetParentId, position });
      await treeFetch.refresh();
      if (result.tree_refresh_failed) setMoveError('The source move succeeded, but the refreshed tree is unavailable. Refresh the library before making another move.');
      setMoveStatus((m) => ({ ...m, [id]: 'moved' }));
      // Long enough to read as a landing, short enough not to linger as state.
      window.setTimeout(() => {
        setMoveStatus((m) => { const next = { ...m }; delete next[id]; return next; });
      }, 1200);
    } catch (err) {
      // The refusals are the interesting half and each names a reason —
      // "mirrors confluence", "publish it instead", "is not a folder". Show
      // the server's sentence rather than "move failed", and drop the pending
      // paint so the row stops looking like it is still going somewhere.
      setMoveStatus((m) => { const next = { ...m }; delete next[id]; return next; });
      setMoveError(err instanceof Error ? err.message : 'the move could not be saved');
    }
  }
  // Activity does: GET /runs is a real, contracted endpoint. Only fetched in
  // Workspace mode, the only mode with a synced section to show it for.
  const runsFetch = useFetch<unknown>(mode === 'workspace' ? '/api/assessment/runs?limit=20' : null);
  const activityRuns = useMemo(() => parseActivityRuns(runsFetch.data), [runsFetch.data]);

  const sections = useMemo(() => sectionsForMode(treeFetch.data?.sections ?? [], mode), [treeFetch.data, mode]);
  const nodes = useMemo(() => flatNodes(sections), [sections]);
  const activityCount = useCallback((section: KnowledgeSection) => activityForSection(section, activityRuns).length
    + pulledEventsForSection(sse.events, section.key).length, [activityRuns, sse.events]);
  const libraryOpen = searchParams.get('view') === 'library';
  const selectedId = searchParams.get('doc');
  const selectedNode = findNode(nodes, selectedId);
  const draftSection = mode === 'workspace' ? sections.find(section => section.key === 'workspace_drafts') ?? { key: 'workspace_drafts', title: 'Workspace drafts' } : sections.find(section => section.kind === 'local');
  const draftSectionKey = draftSection?.key;
  const mayCreate = mode !== 'prompts' && canDo('ManageKnowledge') && !!draftSectionKey;
  const createDraft = (destination: DraftDestination) => navigation?.navigate(() => setCreating(destination));
  const sourceConfigured = treeFetch.data?.sourceConfigured === true;

  // Default to the first viewable leaf once the tree loads, if the URL
  // didn't already name a document — landing on a folder or a hidden binary
  // would open a pane with nothing to show.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!treeFetch.data) return;
    appliedDefaultRef.current = true;
    if (searchParams.get('doc') || searchParams.get('view')) return;
    const leaf = firstViewableLeaf(nodes);
    if (!leaf) return;
    const next = new URLSearchParams(searchParams);
    next.set('doc', leaf.id);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeFetch.data]);

  const handleSelectNode = (id: string) => navigation?.navigate(() => {
    setView({ kind: 'node' });
    const next = new URLSearchParams(searchParams);
    next.set('doc', id);
    next.delete('view');
    setSearchParams(next);
  });

  const openLibrary = () => navigation?.navigate(() => {
    const next = new URLSearchParams(searchParams); next.set('view', 'library');
    setSearchParams(next); setView({ kind: 'node' });
  });

  const openActivity = (sectionKey: string) => navigation?.navigate(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('view');
    setSearchParams(next);
    setView({ kind: 'activity', sectionKey });
  });

  // Upload: each Markdown / text file becomes a draft in the draft section,
  // its first heading the title. The draft is created WITH its body, so the
  // canvas seeds from it on first open (a create-then-save would change the
  // source under the pending import and be refused).
  async function uploadFiles(files: File[]) {
    if (!draftSectionKey) return;
    setUploadError(null);
    setUploading(true);
    let last: string | null = null;
    const refused: string[] = [];
    try {
      for (const file of files) {
        if (file.size > UPLOAD_MAX_BYTES) { refused.push(`${file.name} is larger than ${UPLOAD_MAX_BYTES / 1024} KB`); continue; }
        const markdown = await file.text();
        try {
          const result = await sendJson<{ ok: boolean; id: string }>('/api/assessment/knowledge/doc/create', 'POST', { title: uploadTitle(file.name, markdown), sectionKey: draftSectionKey, markdown });
          if (result.id) last = result.id;
        } catch (err) { refused.push(`${file.name}: ${err instanceof Error ? err.message : 'the draft could not be created'}`); }
      }
    } finally {
      setUploading(false);
      if (refused.length) setUploadError(refused.join('; '));
      await treeFetch.refresh();
      if (last && refused.length === 0) handleSelectNode(last);
    }
  }

  const modeLabel = MODE_LABEL[mode];
  const ancestors = view.kind === 'node' ? nodePath(nodes, selectedId) : [];
  const crumbs: { label: string; onClick?: () => void }[] = [
    ...(view.kind === 'activity' ? [{ label: 'Activity' }] : ancestors.map((n, index) => ({ label: n.title, ...(index < ancestors.length - 1 ? { onClick: () => handleSelectNode(n.id) } : {}) }))),
  ];
  const documentTotal = sections.reduce((sum, section) => sum + sectionDocumentCount(section), 0);
  const mayMove = canDo('ManageKnowledge') && mode !== 'prompts';

  // The caption's 28px actions: New page, the list's ⋯, and the fold.
  const captionActions = (foldRail: () => void) => <Inline gap="none" wrap={false}>
    {mayCreate && <IconButton aria-label="New page" title="New page" variant="ghost" size="sm" className="h-7 w-7 text-text-secondary" icon={<PlusIcon size={14} />} onClick={() => createDraft({ sectionKey: draftSectionKey! })} data-testid="new-page-btn" />}
    <DropdownMenu trigger={<MoreIcon size={14} />} triggerLabel="More for the documents list" triggerTitle="More" triggerTestId="document-rail-menu"
      triggerClassName="h-7 w-7 border-transparent px-0 py-0 text-text-secondary" align="end"
      sections={[{ items: [
        { label: 'All documents', trailing: String(documentTotal), onSelect: openLibrary },
        { label: 'Refresh library', onSelect: () => void treeFetch.refresh() },
      ] }]} />
    <IconButton aria-label="Hide document library" title="Hide document library" variant="ghost" size="sm" className="h-7 w-7 text-text-secondary"
      icon={<ChevronIcon dir="left" size={14} />} onClick={foldRail} data-testid="knowledge-explorer-rail-fold" />
  </Inline>;

  const rail = ({ foldRail }: { foldRail: () => void }) => (
    <>
      <RenameNodeDialog
        node={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={handleRename}
      />
      <DocumentRail
        title={mode === 'workspace' ? 'Documents' : modeLabel}
        count={documentTotal}
        actions={captionActions(foldRail)}
        status={treeFetch.isLoading ? <LoadingState label="Loading…" />
          : treeFetch.error ? <ErrorState title="Couldn't load the document library" body={treeFetch.error} />
          : undefined}
        sections={sections}
        selectedId={view.kind === 'node' ? selectedId : null}
        activitySectionKey={view.kind === 'activity' ? view.sectionKey : null}
        libraryOpen={libraryOpen}
        quickView={quickView}
        onQuickView={setQuickView}
        onOpenLibrary={openLibrary}
        onOpenDocument={handleSelectNode}
        onOpenActivity={openActivity}
        activityCount={activityCount}
        moveStatus={moveStatus}
        sourceConfigured={sourceConfigured}
        pulls={pulls}
        {...(mayCreate ? { onCreate: createDraft } : {})}
        {...(mode !== 'prompts' && canDo('ManageKnowledge') ? { onRename: setRenaming } : {})}
        {...(mayMove ? { onReorder: handleReorder } : {})}
      />
      {/* Why a move was refused, in the server's own words. Each refusal names
          something the reader can act on — which remote owns that subtree, or
          that publish is the way a doc leaves local — so a generic "move
          failed" would throw away the whole value of the check. */}
      {moveError && (
        <ErrorState
          title="That move was not allowed"
          body={moveError}
          action={<Button size="sm" variant="ghost" onClick={() => setMoveError(null)}>Dismiss</Button>}
        />
      )}
      {mode === 'enterprise' && !treeFetch.isLoading && !treeFetch.error && (
        <RailSection title="Related">
          <Stack gap="xs">
            {RELATED_LINKS.map((link) => (
              <Link key={link.href} to={link.href} className="text-sm text-text-secondary no-underline hover:text-primary hover:underline">
                {link.label}
              </Link>
            ))}
          </Stack>
        </RailSection>
      )}
    </>
  );

  const activitySection = view.kind === 'activity' ? sections.find((s) => s.key === view.sectionKey) : undefined;
  const isPage = !!selectedNode && !isFolderNode(selectedNode) && selectedNode.viewable !== false;
  const selectedSectionKey = selectedNode ? sectionForNode(sections, selectedNode.id)?.key ?? null : null;

  const activityPane = view.kind === 'activity' && (() => {
    const runItems = activitySection ? toActivityFeedItems(activityForSection(activitySection, activityRuns)) : [];
    const pulledItems = activitySection
      ? pulledEventsForSection(sse.events, activitySection.key).map((e) => ({
        id: `pull-${e.ts}`, actor: 'Confluence sync', action: 'pulled',
        subject: `${e.files_pulled} of ${e.pages} pages`, timeLabel: e.ts, kind: 'status',
      }))
      : [];
    const items = [...pulledItems, ...runItems];
    return items.length > 0
      ? <ActivityFeed items={items} rotateMs={0} />
      : <InlinePlaceholder size="sm">No recent activity for this section.</InlinePlaceholder>;
  })();

  return (
    <ExplorerFrame
      rail={rail}
      aside={!libraryOpen && view.kind === 'node' && isPage && selectedNode
        ? <ActivityBar node={selectedNode} sectionKey={selectedSectionKey} sseEvents={sse.events} />
        : undefined}
    >
      {/* Document pages use their own visible heading; other views still name the workspace. */}
      {(view.kind !== 'node' || !isPage) && !libraryOpen && <VisuallyHidden as="h1">{modeLabel}</VisuallyHidden>}
      <NewDraftDialog destination={creating} onClose={() => setCreating(null)} onCreated={id => { treeFetch.refresh(); handleSelectNode(id); }} />
      {/* A page carries its trail on the editor's own title row (DocumentShell); the list its PageHeader. */}
      {!isPage && !libraryOpen && <Toolbar aria-label="Document navigation" wrap className="px-6 py-3">
        <Button variant="ghost" size="sm" className="border-0" onClick={openLibrary}>Documents</Button>
        <Breadcrumbs items={crumbs} />
      </Toolbar>}

      {libraryOpen && (treeFetch.isLoading ? <LoadingState label="Loading document library…" />
        : treeFetch.error ? <ErrorState title="Couldn't load the document library" body={treeFetch.error} />
        : <DocumentLibrary sections={sections} onSelect={handleSelectNode}
            {...(mayCreate ? { onNewPage: () => createDraft({ sectionKey: draftSectionKey! }), onUpload: uploadFiles, draftSectionTitle: draftSection?.title } : {})}
            uploading={uploading} uploadError={uploadError} onDismissUploadError={() => setUploadError(null)} />)}

      {!libraryOpen && view.kind === 'activity' && activityPane}

      {!libraryOpen && view.kind === 'node' && (
        !selectedNode ? (
          <EmptyState title="Select a document from the library to view it." />
        ) : isFolderNode(selectedNode) ? (
          <FolderPane
            node={selectedNode}
            children={nodes.filter((n) => n.parent_id === selectedNode.id)}
            onSelectChild={handleSelectNode}
          />
        ) : selectedNode.viewable === false ? (
          <EmptyState title={selectedNode.title} body="This file isn't viewable here." description={selectedNode.id} />
        ) : (
          <DocPane node={selectedNode} mode={mode} onBack={openLibrary} sourceConfigured={sourceConfigured} sseEvents={sse.events} sseConnected={sse.connected} sseGapped={sse.gapped} onTreeChanged={treeFetch.refresh}
            path={[{ label: 'Documents', onClick: openLibrary }, ...crumbs.slice(0, -1)]} sectionKey={selectedSectionKey} />
        )
      )}
    </ExplorerFrame>
  );
}

export default KnowledgeExplorer;
