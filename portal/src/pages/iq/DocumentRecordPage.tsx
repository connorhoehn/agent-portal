import { useParams } from 'react-router';
import { Button, KeyValue, LoadingState, PageSection, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { documentSourceHref, readDocumentRecord, type DocumentRecord } from '../../lib/workDocuments';

export default function DocumentRecordPage() {
  const { documentId = '' } = useParams(); const { session } = useSession();
  const identity = JSON.stringify([session?.sub, session?.tenant, session?.role, session?.masquerading, session?.grants]);
  return <Document key={`${identity}:${documentId}`} id={documentId} />;
}
function Document({ id }: { id: string }) {
  const read = useFetch<unknown>(`/api/graph/documents/${encodeURIComponent(id)}`, 30_000);
  let doc: DocumentRecord | null = null, error = read.error;
  if (read.data && !error) {
    try { doc = readDocumentRecord(read.data, id); } catch (problem) { error = (problem as Error).message; }
  }
  const sourceHref = documentSourceHref(doc?.sourceUri ?? null);
  return <PageSection title={doc?.title ?? 'Document record'} data-testid="document-record-page">
    {error ? <UnavailableNotice error={error} what="this document record" onRetry={read.refresh} /> : !doc ? <LoadingState /> : <Stack gap="md">
      <T>This is the ingested document record. Source content and editing remain governed by the source's permissions.</T>
      <KeyValue items={[{ label: 'Document ID', value: doc.id, mono: true }, { label: 'Source', value: doc.source ?? 'Unknown' },
        { label: 'Ingested', value: doc.ingestedAt ?? 'Unknown' }, { label: 'Source location', value: doc.sourceUri ?? 'Unavailable', mono: true }]} />
      {sourceHref ? <Button size="sm" variant="secondary" onClick={() => window.open(sourceHref, '_blank', 'noopener,noreferrer')}>Open source</Button>
        : <T className="text-sm text-text-secondary">This source has no supported web link. Access the source location through its authorized client.</T>}
    </Stack>}
  </PageSection>;
}
