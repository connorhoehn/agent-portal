import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useParams } from 'react-router';
import { Button, EditableHeading, FullscreenToggle, Inline, InlineAlert, KeyValue, LoadingState, MarkdownView, MetaLine, PageSection, Stack, T, Textarea } from '@connorhoehn/ui-components/shared';
import { useFullscreen } from '@connorhoehn/ui-components/hooks';
import { DocumentSaveStatus, type DocumentSaveState } from '@connorhoehn/ui-components/doc-editor';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { useCrumbTrail } from '../../lib/crumbLabels';
import { useFetch } from '../../hooks/useFetch';
import { absoluteTime, relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { documentSourceHref, isWorkspaceDocument, readDocumentRecord, readWorkspaceDocument, updateWorkspaceDocument, type DocumentRecord, type WorkspaceDocument } from '../../lib/workDocuments';

export default function DocumentRecordPage() {
  const { documentId = '' } = useParams(); const { session } = useSession();
  const identity = JSON.stringify([session?.sub, session?.tenant, session?.role, session?.masquerading, session?.grants]);
  return <Document key={`${identity}:${documentId}`} id={documentId} />;
}
function Document({ id }: { id: string }) {
  const read = useFetch<unknown>(`/api/graph/documents/${encodeURIComponent(id)}`, 30_000);
  let doc: DocumentRecord | null = null, page: WorkspaceDocument | null = null, error = read.error;
  if (read.data && !error) {
    try { if (isWorkspaceDocument(read.data)) { page = readWorkspaceDocument(read.data); if (page.id !== id) throw new Error('Document response changed identity'); } else doc = readDocumentRecord(read.data, id); }
    catch (problem) { error = (problem as Error).message; }
  }
  if (error) return <PageSection title="Document record" data-testid="document-record-page"><UnavailableNotice error={error} what="this document record" onRetry={read.refresh} /></PageSection>;
  if (page) return page.kind === 'whiteboard' ? <WhiteboardPage page={page} onSaved={read.refresh} /> : <WorkspacePage page={page} onSaved={read.refresh} />;
  const sourceHref = documentSourceHref(doc?.sourceUri ?? null);
  return <PageSection title={doc?.title ?? 'Document record'} data-testid="document-record-page">
    {!doc ? <LoadingState /> : <Stack gap="md">
      <T>This is the ingested document record. Source content and editing remain governed by the source's permissions.</T>
      <KeyValue items={[{ label: 'Document ID', value: doc.id, mono: true }, { label: 'Source', value: doc.source ?? 'Unknown' },
        { label: 'Ingested', value: doc.ingestedAt ? absoluteTime(doc.ingestedAt) : 'Unknown' }, { label: 'Source location', value: doc.sourceUri ?? 'Unavailable', mono: true }]} />
      {sourceHref ? <Button size="sm" variant="secondary" onClick={() => window.open(sourceHref, '_blank', 'noopener,noreferrer')}>Open source</Button>
        : <T className="text-sm text-text-secondary">This source has no supported web link. Access the source location through its authorized client.</T>}
    </Stack>}
  </PageSection>;
}

// Checkpoint saves: a page or board is saved in the background a moment after
// the last edit, never by a button. The host bumps `changes` on every local
// edit; each bump re-arms the checkpoint, and the save runs once the edits
// pause (1.5 s). Leaving the page flushes a pending checkpoint. The status is
// the library's own save line (DocumentSaveStatus), with a retry on failure.
const CHECKPOINT_MS = 1500;
function useCheckpointSave(commit: () => Promise<void>, changes: number): { state: DocumentSaveState | undefined; flush: () => void } {
  const [state, setState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const latest = useRef(commit); latest.current = commit;
  const seen = useRef(changes);
  const run = useCallback(async () => {
    setState('saving');
    try { await latest.current(); setState('saved'); setDetail(undefined); }
    catch (cause) { setState('error'); setDetail(cause instanceof Error ? cause.message : 'The save failed.'); }
  }, []);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    if (pending.current) { pending.current = false; void run(); }
  }, [run]);
  useEffect(() => {
    if (changes === seen.current) return;
    seen.current = changes; pending.current = true; setState('pending');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; pending.current = false; void run(); }, CHECKPOINT_MS);
  }, [changes, run]);
  // A pending checkpoint is not lost to navigation: the page hiding, or this component leaving, saves it now.
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);
  const current: DocumentSaveState | undefined = state === 'idle' ? undefined
    : state === 'error' ? { status: 'error', detail, onRetry: () => void run() }
    : { status: state === 'saved' ? 'saved' : 'pending' };
  return { state: current, flush };
}

// A page written in an initiative (the Docs tab's New › Document, 2026-11-02):
// its markdown rendered, and for a steward a Write mode on the same page whose
// edits checkpoint through PUT /api/graph/documents/:id. The title renames in
// place from the heading. The live collaborative canvas (the Assessment
// knowledge editor's) is the next slice; until then the body is one markdown
// field.
function WorkspacePage({ page, onSaved }: { page: WorkspaceDocument; onSaved: () => void }) {
  const { can, ready } = useCapabilities();
  const mayEdit = ready && can('DispatchAgentRun');
  const title = page.title ?? 'Untitled page';
  // The page's place: under its initiative, not under Search (the resolver only sees the URL).
  useCrumbTrail(page.id, [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' },
    { label: page.projectName ?? page.projectId, path: `/iq/projects/${encodeURIComponent(page.projectId)}` }, { label: title, id: page.id }]);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(page.markdown);
  const [changes, setChanges] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const savedMarkdown = useRef(page.markdown);
  // The server's body replaces the draft only when the server's body changes (another author, a /doc save), never
  // on leaving Write mode: the draft is what was just written, and its checkpoint may still be in flight.
  useEffect(() => { savedMarkdown.current = page.markdown; setDraft(page.markdown); }, [page.markdown]);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const { state: save, flush } = useCheckpointSave(async () => {
    const markdown = latestDraft.current;
    if (markdown === savedMarkdown.current) return;
    await updateWorkspaceDocument(page.id, { markdown });
    savedMarkdown.current = markdown; onSaved();
  }, changes);
  async function rename(next: string) {
    setProblem(null);
    try { await updateWorkspaceDocument(page.id, { title: next }); onSaved(); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : 'The page could not be renamed.'); }
  }
  // No author line yet: createdBy is a user id, and an id is not a name (a directory lookup is the next slice).
  return <Stack gap="md" data-testid="workspace-document-page">
    <Inline justify="between" align="center" gap="md" wrap={false}>
      <EditableHeading as="h1" size="lg" revealOnHover value={title} onCommit={next => void rename(next)} readOnly={!mayEdit} editLabel="Rename page" className="min-w-0 flex-1" data-testid="workspace-document-title" />
      <Inline gap="sm" align="center" wrap={false}>
        <DocumentSaveStatus state={save} />
        {mayEdit && (writing
          ? <Button size="sm" variant="secondary" onClick={() => { flush(); setWriting(false); }} data-testid="workspace-document-done">Done</Button>
          : <Button size="sm" variant="secondary" onClick={() => setWriting(true)} data-testid="workspace-document-write">Write</Button>)}
      </Inline>
    </Inline>
    {problem && <InlineAlert tone="error">{problem}</InlineAlert>}
    {writing
      ? <Textarea aria-label="Page body (Markdown)" value={draft} onChange={event => { setDraft(event.target.value); setChanges(n => n + 1); }} autoResize minRows={12} placeholder="Write the page in Markdown…" data-testid="workspace-document-body" />
      : draft.trim()
        ? <MarkdownView markdown={draft} data-testid="workspace-document-view" />
        : <T size="sm" tone="secondary" data-testid="workspace-document-empty">{mayEdit ? 'Nothing written yet. Write opens the page.' : 'Nothing written yet.'}</T>}
    <MetaLine size="sm" tone="secondary" items={['Page', `edited ${relativeTime(page.updatedAt)}`]} data-testid="workspace-document-meta" />
  </Stack>;
}

// A whiteboard written in an initiative (the Docs tab's New › Whiteboard,
// 2026-11-03): the library's Excalidraw canvas (ui-components /diagram) over a
// Y.Doc this page owns, seeded from the saved scene and checkpointed back as
// one Yjs update a moment after the strokes pause. One author at a time for
// now: the live, shared Y.Doc arrives with the Work canvas service, the same
// step as the page editor's. The stage goes full screen through the library's
// toggle (Escape leaves), and the title renames in place from the heading.
const ExcalidrawCanvas = lazy(() => import('@connorhoehn/ui-components/diagram').then(m => ({ default: m.CollaborativeExcalidraw })));
const toBase64 = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function WhiteboardPage({ page, onSaved }: { page: WorkspaceDocument; onSaved: () => void }) {
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const mayEdit = ready && can('DispatchAgentRun');
  const title = page.title ?? 'Untitled whiteboard';
  useCrumbTrail(page.id, [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' },
    { label: page.projectName ?? page.projectId, path: `/iq/projects/${encodeURIComponent(page.projectId)}` }, { label: title, id: page.id }]);
  // The doc lives as long as the page; a later server read never replaces local strokes.
  const ydoc = useMemo(() => { const doc = new Y.Doc(); if (page.scene) { try { Y.applyUpdate(doc, fromBase64(page.scene)); } catch { /* an unreadable scene starts blank */ } } return doc; }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ydoc.destroy(), [ydoc]);
  const savedScene = useRef(page.scene);
  const [changes, setChanges] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const stage = useRef<HTMLElement>(null);
  const { active: fullscreen } = useFullscreen(stage);
  const user = useMemo(() => ({ userId: session?.sub, displayName: session?.name ?? 'You', color: 'var(--color-primary)' }), [session?.sub, session?.name]);
  const { state: save } = useCheckpointSave(async () => {
    const scene = toBase64(Y.encodeStateAsUpdate(ydoc));
    if (scene === savedScene.current) return;
    await updateWorkspaceDocument(page.id, { scene });
    savedScene.current = scene; onSaved();
  }, changes);
  async function rename(next: string) {
    setProblem(null);
    try { await updateWorkspaceDocument(page.id, { title: next }); onSaved(); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : 'The whiteboard could not be renamed.'); }
  }
  // One stable callback, and a bump only when the encoded scene really moved: the canvas may report a scene
  // change on binding or on a re-render, and a counter that climbs on every report re-renders forever.
  const seenScene = useRef(page.scene);
  const onSceneChange = useCallback((count: number) => {
    const scene = toBase64(Y.encodeStateAsUpdate(ydoc));
    if (scene === seenScene.current) return;
    seenScene.current = scene;
    // The binding's own first write to a blank board is not a change worth saving; a drawn element, or any
    // change to a board that was saved before, is.
    if ((count > 0 || savedScene.current !== '') && scene !== savedScene.current) setChanges(n => n + 1);
  }, [ydoc]);
  return <Stack gap="md" data-testid="workspace-whiteboard-page">
    <Inline justify="between" align="center" gap="md" wrap={false}>
      <EditableHeading as="h1" size="lg" revealOnHover value={title} onCommit={next => void rename(next)} readOnly={!mayEdit} editLabel="Rename whiteboard" className="min-w-0 flex-1" data-testid="workspace-whiteboard-title" />
      <Inline gap="sm" align="center" wrap={false}>
        <DocumentSaveStatus state={save} />
        <FullscreenToggle target={stage} label="Full screen whiteboard" exitLabel="Exit full screen" data-testid="workspace-whiteboard-fullscreen" />
      </Inline>
    </Inline>
    {problem && <InlineAlert tone="error">{problem}</InlineAlert>}
    <Stack ref={stage} gap="none" className={fullscreen ? 'h-screen w-screen bg-surface' : 'h-[70vh] min-h-[480px] overflow-hidden rounded-lg border border-border'} data-testid="workspace-whiteboard-stage" data-fullscreen={fullscreen ? 'true' : 'false'}>
      <Suspense fallback={<LoadingState label="Loading the whiteboard…" />}>
        <ExcalidrawCanvas ydoc={ydoc} awareness={null} user={user} editable={mayEdit} className="h-full min-h-0 flex-1" onSceneChange={onSceneChange} />
      </Suspense>
    </Stack>
    <MetaLine size="sm" tone="secondary" items={['Whiteboard', `edited ${relativeTime(page.updatedAt)}`, mayEdit ? 'One author at a time' : null]} data-testid="workspace-whiteboard-meta" />
  </Stack>;
}
