// The registry list itself. Given rows, it renders them; it does not fetch,
// filter or know what a tenant filter is — that is the page shell's job.

import {
  Chip,
  Inline,
  InlinePlaceholder,
  LoadingState,
  MetaLine,
  T,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { DeleteButton } from './DeleteButton';
import { ProvisionButton } from './ProvisionButton';
import { StatusChip } from './StatusChip';
import { SyncButton } from './SyncButton';
import {
  canProvision,
  docCountLabel,
  formatDate,
  syncTone,
  truncate,
} from './kbFormat';
import type { KbRegistryEntry } from './types';

const COLUMNS = ['Name', 'Purpose', 'Status', 'Documents', 'Last sync', ''] as const;

export function KbRegistryTable({
  kbs,
  isLoading,
  emptyMessage,
  onOpen,
  onRefresh,
}: {
  kbs: KbRegistryEntry[];
  isLoading: boolean;
  /** What to say when there is nothing to show — the page knows whether that
   *  means "no matches", "load failed" or "none exist". */
  emptyMessage: string;
  onOpen: (kb: KbRegistryEntry) => void;
  onRefresh: () => void;
}) {
  return (
    <Table size="sm">
      <TableHead>
        <TableRow>
          {COLUMNS.map((c, i) => <TableTh key={c || `actions-${i}`} numeric={c === 'Documents'}>{c}</TableTh>)}
        </TableRow>
      </TableHead>
      <TableBody>
        {kbs.map((kb) => (
          <TableRow key={kb.id} clickable onClick={() => onOpen(kb)}>
            <TableTd>
              <Inline gap="sm" align="center" wrap={false}>
                <T as="span" size="sm" weight="semibold" className="truncate">{kb.name}</T>
                <T as="span" size="xs" tone="tertiary" className="font-mono truncate">{kb.slug}</T>
              </Inline>
            </TableTd>

            <TableTd><T as="span" size="xs" tone="secondary">{kb.purpose}</T></TableTd>

            <TableTd>
              <Inline gap="sm" align="center" wrap={false}>
                <StatusChip status={kb.status} />
                {/* The failure reason is the whole point of a FAILED row, but a
                    250-char Bedrock message would set the column width for
                    every other row — clipped here, in full on the detail page. */}
                {kb.errorMessage && (
                  <T as="span" size="xs" className="max-w-[200px] truncate text-danger" title={kb.errorMessage}>
                    {truncate(kb.errorMessage, 60)}
                  </T>
                )}
              </Inline>
            </TableTd>

            <TableTd numeric className="whitespace-nowrap">
              <T as="span" size="xs" tone="secondary" tabular>{docCountLabel(kb.docCount)}</T>
            </TableTd>

            <TableTd className="whitespace-nowrap">
              <Inline gap="sm" align="center" wrap={false}>
                <MetaLine size="xs" items={[formatDate(kb.lastSyncAt)]} />
                {kb.lastSyncStatus && (
                  <Chip tone={syncTone(kb.lastSyncStatus)} size="xs">{kb.lastSyncStatus}</Chip>
                )}
              </Inline>
            </TableTd>

            {/* Row actions must not also open the row. */}
            <TableTd onClick={(e) => e.stopPropagation()}>
              <Inline gap="xs" align="center" wrap={false}>
                {kb.status === 'ACTIVE' ? (
                  <SyncButton kbId={kb.id} dataSourceId={kb.dataSourceId} onDone={onRefresh} />
                ) : canProvision(kb) ? (
                  // Provisioning streams its progress over SSE on the detail
                  // page, so starting it here means going there.
                  <ProvisionButton kbId={kb.id} retry={kb.status === 'FAILED'} onDone={() => onOpen(kb)} />
                ) : (
                  <T as="span" size="xs" tone="tertiary">
                    {kb.status === 'CREATING' ? 'Provisioning…' : '—'}
                  </T>
                )}
                {/* Delete is the escape hatch for rows that never came up. */}
                {canProvision(kb) && (
                  <DeleteButton kbId={kb.id} kbName={kb.name} onDone={onRefresh} />
                )}
              </Inline>
            </TableTd>
          </TableRow>
        ))}

        {kbs.length === 0 && (
          <TableRow>
            <TableTd colSpan={COLUMNS.length}>
              {isLoading
                ? <LoadingState label="Loading knowledge bases…" />
                : <InlinePlaceholder align="center" size="sm">{emptyMessage}</InlinePlaceholder>}
            </TableTd>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
