// What actually made it into the index.

import {
  Card,
  CardHeader,
  EntityCell,
  InlinePlaceholder,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch.js';
import { UnavailableNotice } from '../../../components/UnavailableNotice';
import { docCountLabel, formatDate } from './kbFormat';
import type { KbDocsResponse, KbRegistryEntry } from './types';

export function DocumentsTab({ kb }: { kb: KbRegistryEntry }) {
  // "No documents ingested yet." is the sentence that sends someone off to
  // re-run an ingestion they do not need. The listing is a live Bedrock call
  // and fails for ordinary reasons; say which one.
  const { data, error, degraded, refresh } = useFetch<KbDocsResponse>(
    kb.bedrockKbId ? `/api/admin/kb-registry/${kb.id}/docs?limit=50` : null,
  );
  const docs = data?.documents ?? [];
  const failure = error ?? degraded;

  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader
          title="Documents"
          subtitle={kb.docCount === undefined
            ? undefined
            : `${docCountLabel(kb.docCount)} documents ingested`}
        />
        {failure ? (
          <UnavailableNotice
            error={failure}
            what="the document listing"
            source="Documents are listed live from the Bedrock knowledge base"
            onRetry={refresh}
          />
        ) : docs.length === 0 ? (
          <InlinePlaceholder size="sm">
            {kb.bedrockKbId ? 'No documents ingested yet.' : 'KB not yet provisioned.'}
          </InlinePlaceholder>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Document</TableTh>
                <TableTh>Ingested</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {docs.map((doc) => (
                <TableRow key={doc.id}>
                  <TableTd>
                    <EntityCell label={doc.title ?? doc.source ?? doc.id} id={doc.source ?? undefined} />
                  </TableTd>
                  <TableTd className="whitespace-nowrap text-[11px] text-text-tertiary">
                    {formatDate(doc.ingestedAt)}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}
