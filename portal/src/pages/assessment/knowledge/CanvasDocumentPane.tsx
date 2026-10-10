import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CanvasDocumentView, DocumentHeader, DocumentLifecyclePill, DocumentOutline, useDocumentOutline, DocumentImageProvider, createAuthenticatedDocumentImage, WorkspaceDocumentHeaderNotices, FollowModeBar } from '@connorhoehnslalom/ui-components/doc-editor';
import { Button, Chip, ErrorState, Inline, InlineAlert, LoadingState, Stack, Modal, FileUploadDrop, ConfirmDialog } from '@connorhoehnslalom/ui-components/shared';
import { useLocation } from 'react-router';
import { WrappedCursorOverlay } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { GatewaySocketProvider, useCanvasDocument, useCursor, useGateway, useYjsDoc, useFileUpload } from '@connorhoehnslalom/realtime-modules/client';
import { createCanvasExtensions, MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign } from '@connorhoehnslalom/realtime-modules/adapters/tiptap';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import type { Editor, EditorEvents } from '@tiptap/react';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { useDocumentImageUpload, MAX_IMAGE_BYTES } from '@connorhoehnslalom/ui-components/doc-editor';
import { useFetch } from '../../../hooks/useFetch';
import { useSession } from '../../../lib/auth';
import { useCapabilities } from '../../../lib/capabilities';
import { sendJson } from '../../../lib/writeJson';
import { usePendingDocumentChanges } from './DocumentNavigation';
import { DocumentContextPanel, useDocumentContext } from './ExplorerFrame';
import { DOCUMENT_TABS, DocumentShell, type DocumentTab } from './DocumentShell';
import { DocumentActivityFeed } from './ActivityBar';
import { DocumentComments } from './DocumentComments';
import { DocumentReader } from './DocumentReader';
import { CLASSIFICATION_LABEL, defuseJsonFences, stripFrontmatter, stripTitleHeading } from './knowledgeFormat';
import { documentCanvasSaveState, canEditDocumentCanvas } from './documentCanvasState';
import { useDocumentComments, type DocumentCommentsState } from './useDocumentComments';
import { useCanvasComments, useCommentHighlightExtension } from './useCanvasComments';
import { useCanvasParticipants } from './useCanvasParticipants';
import { useDocumentCall } from './useDocumentCall';
import { useCanvasRecovery } from './useCanvasRecovery';
import { useDocumentWorkflow } from './useDocumentWorkflow';
import { SourcePublishControl } from './SourcePublishControl';
import { DocumentHistory } from './DocumentHistory';
import { DocumentReviews } from './DocumentReviews';
import { DocumentChatPanel, DocumentComposerDock, useDocumentConversation } from './DocumentConversation';
import { documentAssetRoute } from './documentAssetRoute';
import { publishDocumentEditor, publishDocumentPersistence, publishDocumentProposalCanvas, useDocumentAgentEdit } from './useDocumentAgentEdit';
import { confirmDocumentProposalReceipt, proposalReceiptMatches, waitForDocumentProposalSave } from './documentProposalClient';
import type { DocPaneProps } from './DocPane';
import type { KnowledgeDoc } from './types';

export interface DocumentCanvasGrant {
  documentId: string; sourceId: string; title: string; classification: string;
  sourceParentId?: string | null;
  canEdit: boolean; gatewayUrl: string; token: string; expiresAt: number; sourceRevision: string;
}

// Supplied instances preserve the consumer's single ProseMirror graph. Both the
// BFF seed schema and reference editor use this canonical runtime factory.
const PARTS = { MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign, TextStyleKit, Image: createAuthenticatedDocumentImage(Image), TableKit };
const EXTENSIONS = createCanvasExtensions(PARTS);

export function CanvasDocumentPane(props: DocPaneProps) {
  const { node, sseEvents } = props;
  const { session } = useSession();
  const context = useDocumentContext();
  const doc = useFetch<KnowledgeDoc>(`/api/assessment/knowledge/doc?id=${encodeURIComponent(node.id)}`);
  // platform-api threads through the BFF (the legacy thread was imported once).
  const comments = useDocumentComments(node.id, sseEvents);
  const location = useLocation();
  const [grant, setGrant] = useState<DocumentCanvasGrant | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const refreshInFlight = useRef(false);
  const refreshGrant = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      const next = await sendJson<DocumentCanvasGrant>('/api/assessment/knowledge/canvas', 'POST', { id: node.id });
      if (!mounted.current) return;
      if (next.sourceId !== node.id || !next.documentId || !next.token || next.expiresAt <= Date.now()) throw new Error('The server returned an invalid document session.');
      setGrant(next);
      setGrantError(null);
    } catch (cause) {
      if (mounted.current) setGrantError(cause instanceof Error ? cause.message : 'The document workspace could not connect.');
    } finally {
      refreshInFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, [node.id, node.title]);
  useEffect(() => {
    mounted.current = true;
    void refreshGrant();
    return () => { mounted.current = false; };
  }, [refreshGrant]);
  useEffect(() => {
    if (!grant) return;
    const timer = window.setTimeout(() => void refreshGrant(), Math.max(1000, grant.expiresAt - Date.now() - 30_000));
    const expiry = window.setTimeout(() => setGrantError('Your document session expired. Reconnect to continue editing.'), Math.max(1000, grant.expiresAt - Date.now()));
    return () => { window.clearTimeout(timer); window.clearTimeout(expiry); };
  }, [grant, refreshGrant]);

  // `?tab=comments` (the header bell's reply/mention links) opens on that tab;
  // a later navigation to the same document with a tab switches to it.
  const requestedTab = new URLSearchParams(location.search).get('tab');
  const requestedProposal = new URLSearchParams(location.search).get('proposal');
  const [tab, setTab] = useState<DocumentTab>(() => (DOCUMENT_TABS as readonly string[]).includes(requestedTab ?? '') ? requestedTab as DocumentTab : 'editor');
  useEffect(() => {
    if (requestedProposal) setTab('editor');
    else if (requestedTab && (DOCUMENT_TABS as readonly string[]).includes(requestedTab)) setTab(requestedTab as DocumentTab);
  }, [requestedTab, requestedProposal, location.key]);
  const title = doc.data?.title ?? node.title;
  // Document-level reactions sit with the discussion, not in the head row.
  const commentsTab = <DocumentComments key={node.id} sourceId={node.id} title={title} userId={session?.sub ?? ''}
    comments={comments} onBackToPage={() => setTab('editor')} />;
  const history = <DocumentActivityFeed node={node} sectionKey={props.sectionKey} sseEvents={sseEvents} />;
  const outlineMenu = context ? [{ id: 'show-outline', label: 'Show outline', onSelect: () => context.open('outline') }] : [];
  // The page's conversation lives on the BFF gateway, so it is joined here —
  // outside the canvas's document-grant socket below.
  const conversation = useDocumentConversation(node.id);
  // Pointers ride the same BFF gateway channel as the conversation (and under
  // its authority), so the hook lives out here, not inside the grant socket.
  const cursor = useCursor(conversation.channel, { mode: 'canvas' });
  // Agent edits from the dock (decision 8): the drafter's reply lands in the
  // frame's proposal slot as a proposed edit with Apply / Discard.
  const agentEdit = useDocumentAgentEdit(node.id, title, sseEvents, props.sseGapped, {
    proposalId: requestedProposal, navigationKey: location.key, focus: tab === 'editor',
    documentText: doc.data?.markdown,
  });
  const composer = <DocumentComposerDock docId={node.id} title={title} conversation={conversation} agentEdit={agentEdit} agentEditable={!!grant?.canEdit} />;
  const chatPanel = <DocumentChatPanel title={title} conversation={conversation} />;
  const frame = { title, path: props.path, tab, onTab: setTab, commentCount: comments.openCount, comments: commentsTab, history, composer, proposal: agentEdit.strip };
  const href = `${location.pathname}?doc=${encodeURIComponent(node.id)}`;

  if (grant) return <>{chatPanel}<GatewaySocketProvider url={grant.gatewayUrl} token={grant.token} authProtocol="document-grant-v1" rest={null}>
    <ConnectedCanvas key={grant.documentId} grant={grant} mode={props.mode} sourceConfigured={props.sourceConfigured} accessValid={!grantError}
      userId={session?.sub ?? ''} tenant={session?.tenant ?? ''} userName={session?.name ?? 'Reader'} frame={frame} menuItems={outlineMenu}
      comments={comments} href={href} cursor={cursor}
      accessNotice={grantError && <InlineAlert tone="warning"><Inline gap="sm" align="center" wrap>{grantError}
        <Button size="sm" variant="secondary" disabled={refreshing} onClick={() => void refreshGrant()}>Retry connection</Button>
      </Inline></InlineAlert>}
      onWorkflowChanged={() => void refreshGrant()} onPublished={() => { props.onTreeChanged(); void refreshGrant(); }} />
  </GatewaySocketProvider></>;

  // Connecting, or the reader fallback: the same frame, read-only, with the
  // tabs that need the collaborative workspace shown disabled.
  return <>{chatPanel}<DocumentShell {...frame}
    headActions={<DocumentHeader variant="actions" actionsLayout="menu" extraMenuItems={outlineMenu}
      meta={{ id: node.id, title, status: 'draft', sourceType: 'custom', sourceId: node.id, createdBy: '', createdAt: '', aiModel: '' }}
      mode="reader" participants={[]} titleEditable={false}
      modeReason={grantError ? 'The source remains readable while the collaborative workspace reconnects.' : 'Opening the collaborative workspace.'} />}
    editor={grantError ? <Stack gap="md" className="p-6">
      <InlineAlert tone="warning"><Inline gap="sm" align="center" wrap>{grantError}
        <Button size="sm" variant="secondary" disabled={refreshing} onClick={() => void refreshGrant()}>Retry connection</Button>
      </Inline></InlineAlert>
      {doc.data ? <DocumentReader markdown={defuseJsonFences(stripTitleHeading(stripFrontmatter(doc.data.markdown), doc.data.title))} /> : doc.error ? <ErrorState title="Could not load source document" body={doc.error} /> : <LoadingState label="Loading source document…" />}
    </Stack> : <LoadingState label="Opening document workspace…" />} /></>;
}

type ShellFrame = Pick<Parameters<typeof DocumentShell>[0], 'title' | 'path' | 'tab' | 'onTab' | 'commentCount' | 'comments' | 'history' | 'composer'>;

function ConnectedCanvas({ grant, mode, sourceConfigured, accessValid, userId, tenant, userName, frame, menuItems, comments, href, cursor, accessNotice, onWorkflowChanged, onPublished }: {
  grant: DocumentCanvasGrant; mode: DocPaneProps['mode']; sourceConfigured: boolean; accessValid: boolean; userId: string; tenant: string; userName: string;
  comments: DocumentCommentsState; href: string; cursor: ReturnType<typeof useCursor>;
  frame: ShellFrame; menuItems: Array<{ id: string; label: string; onSelect: () => void }>; accessNotice: ReactNode;
  onWorkflowChanged: () => void; onPublished: () => void;
}) {
  const gateway = useGateway();
  const capabilities = useCapabilities();
  const context = useDocumentContext();
  const [outlineEditor, setOutlineEditor] = useState<Parameters<typeof useDocumentOutline>[0]>(null);
  const outline = useDocumentOutline(outlineEditor);
  const editorRef = useRef<Editor | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [imagePending, setImagePending] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const uploads = useDocumentImageUpload(grant.documentId, userName, useFileUpload);
  const isProtectedImage = useCallback((src: string) => !!documentAssetRoute(src, grant.gatewayUrl, window.location.origin), [grant.gatewayUrl]);
  const loadImage = useCallback(async (src: string, signal: AbortSignal) => {
    const asset = documentAssetRoute(src, grant.gatewayUrl, window.location.origin);
    if (!asset) throw new Error('Unrecognized document asset URL');
    if (asset.auth === 'session' && asset.url.searchParams.get('id') !== grant.sourceId) throw new Error('Unrecognized source asset');
    const response = await fetch(asset.url, { signal, ...(asset.auth === 'session'
      ? { credentials: 'include' as const } : { headers: { Authorization: `Bearer ${grant.token}` } }) });
    if (!response.ok) throw new Error(`Image unavailable (HTTP ${response.status})`);
    return response.blob();
  }, [grant.gatewayUrl, grant.token, grant.sourceId]);
  const recovery = useCanvasRecovery(tenant, userId, grant.documentId);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const doc = useYjsDoc({ documentId: grant.documentId, ws: gateway, onMessage: gateway.onMessage, onUnpersistedChanges: recovery.retain });
  useEffect(() => {
    const provider = doc.provider;
    if (!provider) return;
    publishDocumentPersistence(grant.sourceId, retry => waitForDocumentProposalSave(provider, retry));
    return () => publishDocumentPersistence(grant.sourceId, null);
  }, [grant.sourceId, doc.provider]);
  useEffect(() => {
    const ydoc = doc.ydoc, provider = doc.provider;
    if (!ydoc || !provider || !doc.synced) return;
    publishDocumentProposalCanvas(grant.sourceId, {
      // The outer transaction decides the origin of the nested editor sync, so
      // it must carry the sync plugin's own: the editor's undo history tracks
      // only that origin, and an untagged wrapper made Apply un-undoable.
      apply: (proposal, insert) => ydoc.transact(() => {
        insert();
        ydoc.getMap('agentProposalReceipts').set(proposal.id, {
          id: proposal.id, sourceId: proposal.sourceId, version: proposal.version, by: proposal.decidedBy,
        });
      }, ySyncPluginKey),
      hasReceipt: proposal => proposalReceiptMatches(ydoc.getMap('agentProposalReceipts').get(proposal.id), proposal),
      confirmReceipt: (proposal, retry) => confirmDocumentProposalReceipt(provider, ydoc.getMap('agentProposalReceipts'), proposal, retry),
    });
    return () => publishDocumentProposalCanvas(grant.sourceId, null);
  }, [grant.sourceId, doc.ydoc, doc.provider, doc.synced, doc.persistenceState, doc.pendingUpdateCount]);
  const [changeSequence, setChangeSequence] = useState(0);
  useEffect(() => {
    setChangeSequence(value => value + 1);
    const changed = () => setChangeSequence(value => value + 1);
    doc.ydoc?.on('update', changed);
    return () => { doc.ydoc?.off('update', changed); };
  }, [doc.ydoc]);
  useEffect(() => recovery.track(doc.ydoc, doc.provider), [doc.ydoc, doc.provider, recovery.track]);
  useEffect(() => {
    if (doc.persistenceState === 'saved' && doc.pendingUpdateCount === 0) recovery.acknowledged();
  }, [doc.persistenceState, doc.pendingUpdateCount, recovery.acknowledged]);
  const canvas = useCanvasDocument({ ydoc: doc.ydoc });
  // This document's canvas: the shared schema plus its comment marks. Built
  // once per document — ProseMirror reads its plugin list at construction.
  const focusThread = useRef<(id: string) => void>(() => undefined);
  const highlight = useCommentHighlightExtension(id => focusThread.current(id));
  const extensions = useMemo(() => createCanvasExtensions({ ...PARTS, additional: [highlight] }), [highlight]);
  const liveEditor = outlineEditor as unknown as Editor | null;
  const margin = useCanvasComments({ editor: liveEditor, ydoc: doc.ydoc, comments, canComment: accessValid && !!userId });
  focusThread.current = margin.focus;
  const people = useCanvasParticipants(liveEditor, (doc.provider?.awareness ?? null) as Parameters<typeof useCanvasParticipants>[1], userId);
  const [gutterVisible, setGutterVisible] = useState(() => {
    try { return localStorage.getItem('assessment.document.gutter') !== 'hidden'; } catch { return true; }
  });
  const toggleGutter = () => setGutterVisible(value => {
    try { localStorage.setItem('assessment.document.gutter', value ? 'hidden' : 'shown'); } catch { /* session-only preference */ }
    return !value;
  });
  const call = useDocumentCall({ docId: grant.sourceId, href, title: grant.title, people: people.people, onOpenPeople: () => frame.onTab('editor') });
  usePendingDocumentChanges(grant.documentId, doc.pendingUpdateCount);
  // The live editor, for the dock's agent edits (useDocumentAgentEdit); withdrawn on unmount.
  useEffect(() => () => publishDocumentEditor(grant.sourceId, null), [grant.sourceId]);
  const [wireError, setWireError] = useState<string | null>(null);
  const workflow = useDocumentWorkflow(grant.sourceId, grant.documentId, onWorkflowChanged);
  const lifecycle = workflow.data?.lifecycle;
  const workflowLocked = lifecycle?.status === 'approved' || lifecycle?.status === 'finalized';
  const canEdit = canEditDocumentCanvas(grant, accessValid) && !!lifecycle && !workflow.unavailable && !workflowLocked;
  const online = gateway.connectionState === 'connected';
  // Editing by default (goal decision 7): a role that may edit types straight
  // into the page — there is no Edit draft step. Publishing stays explicit.
  const editable = canEdit && doc.synced && online;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const insertImage = async (file: File) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !editableRef.current || imagePending) return;
    setImagePending(true); setImageError(null);
    try {
      const src = await uploads.uploadImage(file);
      if (editorRef.current !== editor || editor.isDestroyed || !editableRef.current) throw new Error('The document is no longer editable. The image was not inserted.');
      editor.chain().focus().setImage({ src, alt: file.name }).run();
      setImageOpen(false);
    } catch (cause) { setImageError(cause instanceof Error ? cause.message : 'The image could not be uploaded.'); }
    finally { setImagePending(false); }
  };
  const sourceDraft = grant.sourceId.startsWith('page:') || !!grant.sourceParentId;
  const promptDraft = mode === 'prompts' || grant.sourceId.startsWith('prompt:');
  // A synced page or a prompt is edited as a draft, and its first change
  // starts that draft: the chip turns to "Local draft" on the first local edit
  // (a remote change arrives as the ySync binding's own transaction).
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    if (!liveEditor || !editable || drafting || !(sourceDraft || promptDraft)) return;
    const changed = ({ transaction }: EditorEvents['update']) => {
      const sync = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
      if (!sync?.isChangeOrigin) setDrafting(true);
    };
    liveEditor.on('update', changed);
    return () => { liveEditor.off('update', changed); };
  }, [liveEditor, editable, drafting, sourceDraft, promptDraft]);
  const user = useMemo(() => ({ name: userName, color: 'teal' }), [userName]);
  useEffect(() => gateway.onMessage(message => {
    if (message.channel !== `doc:${grant.documentId}`) return;
    if (message.type === 'crdt:error') setWireError(typeof message.error === 'string' ? message.error : 'The document operation was refused.');
    if (message.type === 'crdt:snapshot') setWireError(null);
  }), [gateway.onMessage, grant.documentId]);
  useEffect(() => {
    doc.provider?.awareness.setLocalStateField('user', { ...user, id: userId });
  }, [doc.provider, user, userId]);
  useEffect(() => {
    if (doc.pendingUpdateCount === 0) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [doc.pendingUpdateCount]);
  const saveState = documentCanvasSaveState(doc.persistenceState, doc.pendingUpdateCount, online, doc.retryPersistence);
  function exportMarkdown() {
    const url = URL.createObjectURL(new Blob([canvas.exportMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `${grant.title.replace(/[^a-z0-9 ._-]/gi, '_') || 'document'}.md`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const headActions = <DocumentHeader variant="actions" actionsLayout="menu" extraMenuItems={menuItems}
    meta={{ id: grant.documentId, title: grant.title, status: 'draft', sourceType: 'custom', sourceId: grant.sourceId, createdBy: '', createdAt: '', aiModel: '' }}
    mode={editable ? 'editor' : 'reader'} participants={[]} titleEditable={false}
    {...call.headerProps}
    lifecycleStatus={lifecycle?.status} lifecycleTerminal={lifecycle?.status === 'finalized'}
    lifecycleActions={accessValid && doc.pendingUpdateCount === 0 ? workflow.data?.availableActions : []}
    lifecycleLoading={workflow.loading} lifecycleBusy={workflow.busy}
    onLifecycleAction={workflow.transition}
    owner={lifecycle ? lifecycle.ownerId ? { userId: lifecycle.ownerId, displayName: lifecycle.ownerId === userId ? userName : lifecycle.ownerId } : null : undefined}
    modeReason={!canEdit ? 'Your current role can read this document.'
      : promptDraft ? 'Edits are a draft of this prompt. The published prompt changes only through its promotion path.'
      : sourceDraft ? 'Edits are a local draft. Publishing to the source is a separate action.' : 'This document can be edited by your current role.'}
    onExport={exportMarkdown} exportFormats={['markdown']} onPrint={() => window.print()}
    onToggleHistory={() => frame.onTab('versions')}
    workflowActions={<Inline gap="sm" align="center" wrap>
      <Chip size="xs" tone="neutral" data-testid="document-draft-chip">{(sourceDraft || promptDraft) && drafting ? 'Local draft' : CLASSIFICATION_LABEL[grant.classification] ?? grant.classification}</Chip>
      {margin.commentButton}
      {workflow.data?.canClaimOwnership && <Button size="sm" variant="secondary" disabled={workflow.busy || !accessValid} onClick={workflow.claim}>Take ownership</Button>}
      {sourceConfigured && sourceDraft && capabilities.ready && capabilities.can('ManageKnowledge') && <SourcePublishControl sourceId={grant.sourceId}
        disabled={!canEdit || !doc.synced || !online || doc.pendingUpdateCount > 0} changeSequence={changeSequence} onPublished={onPublished} />}
    </Inline>} />;
  const notices = <>
    {accessNotice}
    <WorkspaceDocumentHeaderNotices lifecycleError={workflow.error} onDismissLifecycleError={workflow.clearError} canClaimOwnership={!!workflow.data?.canClaimOwnership} />
    {workflow.unavailable && grant.canEdit && <InlineAlert tone="warning"><Inline gap="sm" wrap>
      Document workflow is unavailable. Editing is paused until its current state can be checked.
      <Button size="sm" variant="secondary" onClick={workflow.refresh}>Retry workflow</Button>
    </Inline></InlineAlert>}
    {recovery.recovered && <InlineAlert tone="warning"><Stack gap="xs">
      Changes from an earlier editing session are available for recovery. They have not been applied to this document.
      <Inline gap="sm" wrap>
        <Button size="sm" variant="secondary" onClick={recovery.download}>Download recovery</Button>
        {canEdit && <Button size="sm" variant="secondary" disabled={!doc.synced || !online || doc.pendingUpdateCount > 0} onClick={() => setConfirmRecovery(true)}>Recover changes…</Button>}
        <Button size="sm" variant="ghost" onClick={recovery.clear}>Discard recovery</Button>
      </Inline>
    </Stack></InlineAlert>}
    {recovery.storageError && <InlineAlert tone="warning"><Inline gap="sm" wrap>
      This browser could not keep a recovery copy. Keep this page open until saving finishes.
      <Button size="sm" variant="secondary" onClick={recovery.download}>Download recovery</Button>
    </Inline></InlineAlert>}
    {wireError && <InlineAlert tone="error">{wireError}</InlineAlert>}
    {call.notice && <InlineAlert tone="info" onDismiss={call.clearNotice} data-testid="document-call-notice">{call.notice}</InlineAlert>}
  </>;
  const shell = (editor: ReactNode) => <DocumentShell {...frame} headActions={headActions} saveState={saveState}
    participants={people.participants} onParticipantClick={people.onParticipantClick}
    onFollowParticipant={people.onFollowParticipant} followingParticipantId={people.following}
    {...(lifecycle ? { statusPill: <DocumentLifecyclePill status={lifecycle.status} variant="tag" /> } : {})}
    editor={<>{notices}<Stack gap="none" className="min-h-0 flex-1" data-testid="document-canvas-slot"><WrappedCursorOverlay cursor={cursor} className="flex min-h-0 flex-1 flex-col">{editor}</WrappedCursorOverlay></Stack></>}
    versions={<DocumentHistory documentId={grant.documentId} onClose={() => frame.onTab('editor')}
      extensions={EXTENSIONS} pending={doc.pendingUpdateCount > 0 || !online}
      {...(canEdit && workflow.data?.canManageWorkflow ? {
        onSave: async (name: string) => { await sendJson(`/api/assessment/knowledge/doc/workflows/versions?id=${encodeURIComponent(grant.sourceId)}`, 'POST', { name }); },
        onRestore: async (timestamp: number) => { await sendJson(`/api/assessment/knowledge/doc/workflows/versions/restore?id=${encodeURIComponent(grant.sourceId)}`, 'POST', { timestamp }); },
      } : {})} />}
    reviews={<DocumentReviews sourceId={grant.sourceId} documentId={grant.documentId} currentUserId={userId}
      canManage={canEdit && !!workflow.data?.canManageWorkflow} available={accessValid && !!lifecycle && !workflow.unavailable}
      onChanged={workflow.refresh} />} />;
  if (!doc.synced || !doc.ydoc || !canvas.body) return shell(<LoadingState label="Loading collaborative document…" />);
  if (!canvas.isCanvas) return shell(<ErrorState title="Document migration is incomplete" body="The server has not supplied a rich document snapshot. No changes have been made." />);
  // Same surface settings as realtime-examples' page editor: the toolbar as a
  // card on the workspace grey, ruler on, zoom in the toolbar's overflow, and
  // the sheet sized to the shell's scroller (fitHeight="parent").
  return shell(<DocumentImageProvider loadImage={loadImage} requiresAuthentication={isProtectedImage}><CanvasDocumentView key={doc.docVersion} isCanvas body={canvas.body} ydoc={doc.ydoc} provider={doc.provider}
    user={user} editable={editable} extensions={extensions} showRuler showStatusBar={false} toolbarStyle="card" pageMargin="narrow" fitHeight="parent" paginate showOutline={!context}
    onInsertImage={editable ? () => { setImageError(null); setImageOpen(true); } : undefined}
    gutterItems={margin.gutterItems} gutterLead={call.dock} gutterVisible={gutterVisible} onToggleGutter={toggleGutter}
    onFocusGutterItem={margin.onFocusGutterItem} onHoverGutterItem={margin.onHoverGutterItem}
    {...(people.following ? { belowRuler: <FollowModeBar followingUserId={people.following} participants={people.followBarParticipants}
      onStopFollow={people.stopFollowing} appearance="bar" data-testid="document-follow-bar" /> } : {})}
    onEditorReady={editor => { editorRef.current = editor as Editor | null; setOutlineEditor(editor as Parameters<typeof useDocumentOutline>[0]); publishDocumentEditor(grant.sourceId, editor); }} />
    <DocumentContextPanel id="outline"><DocumentOutline entries={outline.entries} activeId={outline.activeId} onSelect={outline.goTo} /></DocumentContextPanel>
    {margin.composer}
    <ConfirmDialog open={confirmRecovery} onCancel={() => setConfirmRecovery(false)} title="Recover earlier changes?" tone="caution"
      body="This explicitly merges the recovered document with the current version. It can bring back content removed by a version restore. Download the recovery first if you want to keep a separate copy."
      confirmLabel="Recover changes" onConfirm={() => {
        if (doc.ydoc && canEdit && online && doc.pendingUpdateCount === 0) recovery.restore(doc.ydoc);
        setConfirmRecovery(false);
      }} />
    <Modal open={imageOpen} onClose={() => { if (!imagePending) setImageOpen(false); }} title="Insert image">
      <Stack gap="sm">
        {imageError && <InlineAlert tone="error">{imageError}</InlineAlert>}
        <FileUploadDrop accept="image/*" maxSize={MAX_IMAGE_BYTES} disabled={imagePending || !editable}
          label={imagePending ? 'Uploading image…' : 'Choose an image or drop it here'} onFiles={files => { if (files[0]) void insertImage(files[0]); }} />
      </Stack>
    </Modal>
  </DocumentImageProvider>);
}
