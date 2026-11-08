import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { LinkedItemsSection, type LinkableDocument } from '@connorhoehn/ui-components';
import { Banner, Button, Inline, Stack } from '@connorhoehn/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { changeWorkDocument, documentRecordHref, readWorkDocuments, type DocumentRecord } from '../../lib/workDocuments';

export function WorkDocumentLinks({ workItemId, canEdit }: { workItemId: string; canEdit: boolean }) {
  const { session } = useSession();
  const identity = JSON.stringify([session?.sub, session?.tenant, session?.role, session?.masquerading, session?.grants]);
  return <Links key={`${identity}:${workItemId}`} workItemId={workItemId} canEdit={canEdit} />;
}
function Links({ workItemId, canEdit }: { workItemId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const base = `/api/graph/work-items/${encodeURIComponent(workItemId)}/documents`;
  const read = useFetch<unknown>(base, 30_000);
  const alive = useRef(true), lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ documentId: string; method: 'PUT' | 'DELETE'; error: string } | null>(null);
  let documents: DocumentRecord[] = [], error = read.error;
  if (read.data && !error) {
    try { documents = readWorkDocuments(read.data, workItemId); } catch (problem) { error = String((problem as Error).message); }
  }
  async function mutate(documentId: string, method: 'PUT' | 'DELETE') {
    if (!canEdit || lock.current || !alive.current) return;
    lock.current = true; setBusy(true); setFailure(null);
    try { await changeWorkDocument(workItemId, documentId, method); if (alive.current) read.refresh(); }
    catch (problem) { if (alive.current) setFailure({ documentId, method, error: (problem as Error).message }); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function search(query: string): Promise<LinkableDocument[]> {
    const response = await fetch(`${base}/candidates?q=${encodeURIComponent(query)}`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('Document search is unavailable. Try again.');
    const docs = readWorkDocuments(await response.json(), workItemId);
    if (!alive.current) return [];
    return docs.filter(doc => !documents.some(link => link.id === doc.id)).map(doc => ({ id: doc.id, title: doc.title ?? doc.id, kind: 'page' }));
  }
  return <Stack gap="sm" data-testid="work-document-links">
    {error ? <UnavailableNotice error={error} what="linked documents" onRetry={read.refresh} /> : <LinkedItemsSection
      title="Documents" items={documents.map(doc => ({ id: doc.id, title: doc.title ?? doc.id, kind: 'page', relation: 'References',
        onOpen: () => navigate(documentRecordHref(doc.id)),
        ...(canEdit && !busy ? { onRemove: () => { void mutate(doc.id, 'DELETE'); } } : {}) }))}
      emptyLabel={read.isLoading ? 'Loading linked documents…' : 'No documents linked yet'}
      onSearchDocuments={canEdit && !busy ? search : undefined}
      onAdd={canEdit && !busy ? doc => { void mutate(doc.id, 'PUT'); } : undefined}
      relations={[{ value: 'references', label: 'References' }]}
    />}
    {busy && <Inline as="span" className="text-sm text-text-secondary" role="status">Saving document association…</Inline>}
    {failure && <Banner variant="error"><Inline gap="sm"><Inline as="span">{failure.error}</Inline>
      <Button size="sm" variant="secondary" onClick={() => { void mutate(failure.documentId, failure.method); }}>Retry</Button></Inline></Banner>}
  </Stack>;
}
