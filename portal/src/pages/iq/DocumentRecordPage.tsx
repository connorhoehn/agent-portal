import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useParams } from 'react-router';
import { Button, Inline, InlineAlert, Input, KeyValue, LoadingState, MarkdownView, MetaLine, PageSection, Stack, T, Textarea } from '@connorhoehnslalom/ui-components/shared';
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

// A page written in an initiative (the Docs tab's New › Document, 2026-11-02):
// its markdown rendered, and for a steward a Write mode on the same page that
// saves through PUT /api/graph/documents/:id. The live collaborative canvas
// (the Assessment knowledge editor's) is the next slice; until then the body
// is one markdown field, saved explicitly, never on every keystroke.
function WorkspacePage({ page, onSaved }: { page: WorkspaceDocument; onSaved: () => void }) {
  const { can, ready } = useCapabilities();
  const mayEdit = ready && can('DispatchAgentRun');
  const title = page.title ?? 'Untitled page';
  // The page's place: under its initiative, not under Search (the resolver only sees the URL).
  useCrumbTrail(page.id, [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' },
    { label: page.projectName ?? page.projectId, path: `/iq/projects/${encodeURIComponent(page.projectId)}` }, { label: title, id: page.id }]);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(page.markdown);
  const [name, setName] = useState(title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { if (!writing) { setDraft(page.markdown); setName(title); } }, [page.markdown, title, writing]);
  const changed = draft !== page.markdown || (name.trim() && name.trim() !== title);
  async function save() {
    if (saving || !changed) return;
    setSaving(true); setProblem(null);
    try {
      await updateWorkspaceDocument(page.id, { ...(draft !== page.markdown ? { markdown: draft } : {}), ...(name.trim() && name.trim() !== title ? { title: name.trim() } : {}) });
      setWriting(false); onSaved();
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'The page could not be saved.'); }
    finally { setSaving(false); }
  }
  // No author line yet: createdBy is a user id, and an id is not a name (a directory lookup is the next slice).
  const meta = <MetaLine size="sm" tone="secondary" items={['Page', `edited ${relativeTime(page.updatedAt)}`]} data-testid="workspace-document-meta" />;
  return <PageSection title={title} data-testid="workspace-document-page"
    actions={mayEdit ? (writing
      ? <Inline gap="sm"><Button size="sm" variant="ghost" disabled={saving} onClick={() => { setDraft(page.markdown); setWriting(false); }}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={saving || !changed} onClick={() => void save()} data-testid="workspace-document-save">{saving ? 'Saving…' : 'Save'}</Button></Inline>
      : <Button size="sm" variant="secondary" onClick={() => setWriting(true)} data-testid="workspace-document-write">Write</Button>) : undefined}>
    <Stack gap="md">
      {meta}
      {problem && <InlineAlert tone="error">{problem}</InlineAlert>}
      {writing
        ? <Stack gap="sm">
            <Input aria-label="Page title" value={name} onChange={event => setName(event.target.value)} placeholder="Page title" data-testid="workspace-document-title" />
            <Textarea aria-label="Page body (Markdown)" value={draft} onChange={event => setDraft(event.target.value)} autoResize minRows={12} placeholder="Write the page in Markdown…" data-testid="workspace-document-body" />
          </Stack>
        : page.markdown.trim()
          ? <MarkdownView markdown={page.markdown} data-testid="workspace-document-view" />
          : <T size="sm" tone="secondary" data-testid="workspace-document-empty">{mayEdit ? 'Nothing written yet. Write opens the page.' : 'Nothing written yet.'}</T>}
    </Stack>
  </PageSection>;
}

// A whiteboard written in an initiative (the Docs tab's New › Whiteboard,
// 2026-11-03): the library's Excalidraw canvas (ui-components /diagram) over a
// Y.Doc this page owns, seeded from the saved scene and saved back explicitly
// as one Yjs update. One author at a time for now: the live, shared Y.Doc
// arrives with the Work canvas service, the same step as the page editor's.
// The hosted form of the library's collaborative canvas: this page owns the Y.Doc; no gateway, no awareness peers yet.
const ExcalidrawCanvas = lazy(() => import('@connorhoehnslalom/ui-components/diagram').then(m => ({ default: m.CollaborativeExcalidraw })));
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
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const user = useMemo(() => ({ userId: session?.sub, displayName: session?.name ?? 'You', color: 'var(--color-primary)' }), [session?.sub, session?.name]);
  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setProblem(null);
    try {
      const scene = toBase64(Y.encodeStateAsUpdate(ydoc));
      await updateWorkspaceDocument(page.id, { scene });
      savedScene.current = scene; setDirty(false); onSaved();
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'The whiteboard could not be saved.'); }
    finally { setSaving(false); }
  }
  return <PageSection title={title} data-testid="workspace-whiteboard-page"
    actions={mayEdit ? <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()} data-testid="workspace-whiteboard-save">{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</Button> : undefined}>
    <Stack gap="md">
      <MetaLine size="sm" tone="secondary" items={['Whiteboard', `edited ${relativeTime(page.updatedAt)}`, mayEdit ? 'One author at a time; Save keeps your strokes' : null]} data-testid="workspace-whiteboard-meta" />
      {problem && <InlineAlert tone="error">{problem}</InlineAlert>}
      <Suspense fallback={<LoadingState label="Loading the whiteboard…" />}>
        <ExcalidrawCanvas ydoc={ydoc} awareness={null} user={user} editable={mayEdit} className="h-[70vh] min-h-[480px] rounded-lg border border-border"
          // The binding's own first write to a blank board is not a change worth saving; a drawn element, or any
          // change to a board that was saved before, is.
          onSceneChange={(count) => { if ((count > 0 || savedScene.current !== '') && toBase64(Y.encodeStateAsUpdate(ydoc)) !== savedScene.current) setDirty(true); }} />
      </Suspense>
    </Stack>
  </PageSection>;
}
