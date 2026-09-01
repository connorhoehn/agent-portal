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
import { docCountLabel, formatDate } from './kbFormat';
import type { KbDocsResponse, KbRegistryEntry } from './types';

export function DocumentsTab({ kb }: { kb: KbRegistryEntry }) {
  const { data } = useFetch<KbDocsResponse>(
    kb.bedrockKbId ? `/api/admin/kb-registry/${kb.id}/docs?limit=50` : null,
  );
  const docs = data?.documents ?? [];

  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader
          title="Documents"
          subtitle={kb.docCount === undefined
            ? undefined
            : `${docCountLabel(kb.docCount)} documents ingested`}
        />
        {docs.length === 0 ? (
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
