import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CanvasDocumentView, DocumentHeader, DocumentOutline, useDocumentOutline, DocumentImageProvider, createAuthenticatedDocumentImage } from '@connorhoehnslalom/ui-components/doc-editor';
import { Button, Chip, Drawer, ErrorState, Inline, InlineAlert, LoadingState, Stack, Modal, FileUploadDrop, ConfirmDialog } from '@connorhoehnslalom/ui-components/shared';
import { ReactionsBar } from '@connorhoehnslalom/ui-components/social';
import { GatewaySocketProvider, useCanvasDocument, useGateway, useYjsDoc, useFileUpload } from '@connorhoehnslalom/realtime-modules/client';
import { createCanvasExtensions, MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign } from '@connorhoehnslalom/realtime-modules/adapters/tiptap';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import type { Editor } from '@tiptap/react';
import { useDocumentImageUpload, MAX_IMAGE_BYTES } from '@connorhoehnslalom/ui-components/doc-editor';
import { useFetch } from '../../../hooks/useFetch';
import { useSession } from '../../../lib/auth';
import { useCapabilities } from '../../../lib/capabilities';
import { sendJson } from '../../../lib/writeJson';
import { usePendingDocumentChanges } from './DocumentNavigation';
import { DocumentContextPanel, useDocumentContext } from './ExplorerFrame';
import { DocumentCommentThread } from './DocumentCommentThread';
import { DocumentReader } from './DocumentReader';
import { CLASSIFICATION_LABEL, summarizeStoredReactions, defuseJsonFences, stripFrontmatter, stripTitleHeading } from './knowledgeFormat';
import { documentCanvasSaveState, canEditDocumentCanvas } from './documentCanvasState';
import { useKnowledgeDocumentThread } from './useKnowledgeDocumentThread';
import { useCanvasRecovery } from './useCanvasRecovery';
import { useDocumentWorkflow } from './useDocumentWorkflow';
import { SourcePublishControl } from './SourcePublishControl';
import { DocumentHistory } from './DocumentHistory';
import { DocumentReviews } from './DocumentReviews';
import { documentAssetRoute } from './documentAssetRoute';
import type { DocPaneProps } from './DocPane';
import type { KnowledgeDoc } from './types';

export interface DocumentCanvasGrant {
  documentId: string; sourceId: string; title: string; classification: string;
  sourceParentId?: string | null;
  canEdit: boolean; gatewayUrl: string; token: string; expiresAt: number; sourceRevision: string;
}

// Supplied instances preserve the consumer's single ProseMirror graph. Both the
// BFF seed schema and reference editor use this canonical runtime factory.
const EXTENSIONS = createCanvasExtensions({ MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign, TextStyleKit, Image: createAuthenticatedDocumentImage(Image), TableKit });

export function CanvasDocumentPane(props: DocPaneProps) {
  const { node, sseEvents, sseConnected, sseGapped } = props;
  const { session } = useSession();
  const context = useDocumentContext();
  const doc = useFetch<KnowledgeDoc>(`/api/assessment/knowledge/doc?id=${encodeURIComponent(node.id)}`);
  const thread = useKnowledgeDocumentThread(node.id, sseEvents, sseConnected, sseGapped);
  const [grant, setGrant] = useState<DocumentCanvasGrant | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
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

  const comments = <DocumentCommentThread key={node.id} title={doc.data?.title ?? node.title}
    comments={thread.comments} reactions={thread.reactions} userId={session?.sub} userName={session?.name}
    onSend={thread.send} onEdit={thread.edit} onDelete={thread.remove} onReact={(id, emoji) => void thread.react(id, emoji)} />;
  const reactions = <ReactionsBar reactions={summarizeStoredReactions(thread.reactions, node.id, session?.sub ?? null)} onReact={emoji => void thread.react(node.id, emoji)} />;
  const openComments = () => context ? context.open('comments') : setCommentsOpen(true);

  return <Stack gap="none" className="min-h-0 flex-1" data-testid="document-surface">
    {grantError && <InlineAlert tone="warning"><Inline gap="sm" align="center" wrap>{grantError}
      <Button size="sm" variant="secondary" disabled={refreshing} onClick={() => void refreshGrant()}>Retry connection</Button>
    </Inline></InlineAlert>}
    {thread.error && <InlineAlert tone="error" onDismiss={thread.clearError}>{thread.error}</InlineAlert>}
    {grant ? <GatewaySocketProvider url={grant.gatewayUrl} token={grant.token} authProtocol="document-grant-v1" rest={null}>
      <ConnectedCanvas key={grant.documentId} grant={grant} mode={props.mode} sourceConfigured={props.sourceConfigured} accessValid={!grantError}
        userId={session?.sub ?? ''} tenant={session?.tenant ?? ''} userName={session?.name ?? 'Reader'}
        onBack={props.onBack} commentCount={thread.comments.length} onComments={openComments} reactions={reactions} onWorkflowChanged={() => void refreshGrant()}
        onPublished={() => { props.onTreeChanged(); void refreshGrant(); }} />
    </GatewaySocketProvider> : grantError ? <Stack gap="md" className="p-6">
      <DocumentHeader meta={{ id: node.id, title: doc.data?.title ?? node.title, status: 'draft', sourceType: 'custom', sourceId: node.id, createdBy: '', createdAt: '', aiModel: '' }}
        onBack={props.onBack} mode="reader" modeReason="The source remains readable while the collaborative workspace reconnects." participants={[]}
        workflowActions={<Button size="sm" variant="secondary" onClick={openComments}>Comments</Button>} />
      {doc.data ? <DocumentReader markdown={defuseJsonFences(stripTitleHeading(stripFrontmatter(doc.data.markdown), doc.data.title))} reactions={reactions} /> : doc.error ? <ErrorState title="Could not load source document" body={doc.error} /> : <LoadingState label="Loading source document…" />}
    </Stack> : <LoadingState label="Opening document workspace…" />}
    <DocumentContextPanel id="comments">{comments}</DocumentContextPanel>
    <Drawer open={commentsOpen} onClose={() => setCommentsOpen(false)} title="Comments" width={420}>{comments}</Drawer>
  </Stack>;
}

function ConnectedCanvas({ grant, mode, sourceConfigured, accessValid, userId, tenant, userName, onBack, commentCount, onComments, reactions, onWorkflowChanged, onPublished }: {
  grant: DocumentCanvasGrant; mode: DocPaneProps['mode']; sourceConfigured: boolean; accessValid: boolean; userId: string; tenant: string; userName: string;
  onBack: () => void; commentCount: number; onComments: () => void; reactions: ReactNode; onWorkflowChanged: () => void; onPublished: () => void;
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
  usePendingDocumentChanges(grant.documentId, doc.pendingUpdateCount);
  const [editing, setEditing] = useState(false);
  const [wireError, setWireError] = useState<string | null>(null);
  const workflow = useDocumentWorkflow(grant.sourceId, grant.documentId, onWorkflowChanged);
  const lifecycle = workflow.data?.lifecycle;
  const workflowLocked = lifecycle?.status === 'approved' || lifecycle?.status === 'finalized';
  const canEdit = canEditDocumentCanvas(grant, mode, accessValid) && !!lifecycle && !workflow.unavailable && !workflowLocked;
  const online = gateway.connectionState === 'connected';
  const editable = canEdit && editing && doc.synced && online;
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
  const header = <Stack gap="xs">
    <DocumentHeader meta={{ id: grant.documentId, title: grant.title, status: 'draft', sourceType: 'custom', sourceId: grant.sourceId, createdBy: '', createdAt: '', aiModel: '' }}
      onBack={onBack} mode={editable ? 'editor' : 'reader'} participants={[]} titleEditable={false} saveState={saveState}
      lifecycleStatus={lifecycle?.status} lifecycleTerminal={lifecycle?.status === 'finalized'}
      lifecycleActions={accessValid && doc.pendingUpdateCount === 0 ? workflow.data?.availableActions : []}
      lifecycleLoading={workflow.loading} lifecycleBusy={workflow.busy}
      lifecycleError={workflow.error} onDismissLifecycleError={workflow.clearError}
      onLifecycleAction={workflow.transition}
      owner={lifecycle ? lifecycle.ownerId ? { userId: lifecycle.ownerId, displayName: lifecycle.ownerId === userId ? userName : lifecycle.ownerId } : null : undefined}
      modeReason={sourceDraft ? 'Edits are a local draft. Publishing to the source is a separate action.' : canEdit ? 'This document can be edited by your current role.' : 'Your current role can read this document.'}
      onExport={exportMarkdown} exportFormats={['markdown']} onPrint={() => window.print()}
      onToggleHistory={context ? () => context.open('history') : undefined}
      workflowActions={<Inline gap="sm" align="center" wrap>
        <Chip size="xs" tone="neutral">{sourceDraft && editing ? 'Local draft' : CLASSIFICATION_LABEL[grant.classification] ?? grant.classification}</Chip>
        {reactions}
        {context && <Button size="sm" variant="ghost" onClick={() => context.open('outline')}>Outline</Button>}
        <Button size="sm" variant="secondary" onClick={onComments}>Comments{commentCount ? ` (${commentCount})` : ''}</Button>
        {workflow.data?.canClaimOwnership && <Button size="sm" variant="secondary" disabled={workflow.busy || !accessValid} onClick={workflow.claim}>Take ownership</Button>}
        {sourceConfigured && sourceDraft && capabilities.ready && capabilities.can('ManageKnowledge') && <SourcePublishControl sourceId={grant.sourceId}
          disabled={!canEdit || !doc.synced || !online || doc.pendingUpdateCount > 0} changeSequence={changeSequence} onPublished={onPublished} />}
        {canEdit && <Button size="sm" variant={editing ? 'secondary' : 'primary'} disabled={!doc.synced || !online} onClick={() => setEditing(value => !value)}>
          {editing ? 'Done editing' : sourceDraft ? 'Edit draft' : 'Edit document'}
        </Button>}
      </Inline>} />
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
  </Stack>;
  if (!doc.synced || !doc.ydoc || !canvas.body) return <Stack gap="md">{header}<LoadingState label="Loading collaborative document…" /></Stack>;
  if (!canvas.isCanvas) return <Stack gap="md">{header}<ErrorState title="Document migration is incomplete" body="The server has not supplied a rich document snapshot. No changes have been made." /></Stack>;
  return <DocumentImageProvider loadImage={loadImage} requiresAuthentication={isProtectedImage}><CanvasDocumentView key={doc.docVersion} isCanvas body={canvas.body} ydoc={doc.ydoc} provider={doc.provider}
    user={user} editable={editable} extensions={EXTENSIONS} header={header} showRuler showStatusBar paginate showOutline={!context}
    onInsertImage={editable ? () => { setImageError(null); setImageOpen(true); } : undefined}
    onEditorReady={editor => { editorRef.current = editor as Editor | null; setOutlineEditor(editor as Parameters<typeof useDocumentOutline>[0]); }} />
    <DocumentContextPanel id="outline"><DocumentOutline entries={outline.entries} activeId={outline.activeId} onSelect={outline.goTo} /></DocumentContextPanel>
    <DocumentReviews sourceId={grant.sourceId} documentId={grant.documentId} currentUserId={userId}
      canManage={canEdit && !!workflow.data?.canManageWorkflow} available={accessValid && !!lifecycle && !workflow.unavailable}
      open={context?.active === 'reviews'} onChanged={workflow.refresh} />
    <DocumentHistory documentId={grant.documentId} open={context?.active === 'history'} onClose={() => context?.open('outline')}
      extensions={EXTENSIONS} pending={doc.pendingUpdateCount > 0 || !online}
      {...(canEdit && workflow.data?.canManageWorkflow ? {
        onSave: async (name: string) => { await sendJson(`/api/assessment/knowledge/doc/workflows/versions?id=${encodeURIComponent(grant.sourceId)}`, 'POST', { name }); },
        onRestore: async (timestamp: number) => { await sendJson(`/api/assessment/knowledge/doc/workflows/versions/restore?id=${encodeURIComponent(grant.sourceId)}`, 'POST', { timestamp }); },
      } : {})} />
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
  </DocumentImageProvider>;
}
