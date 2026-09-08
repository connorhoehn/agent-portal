// The registry list itself. Given rows, it renders them; it does not fetch,
// filter or know what a tenant filter is — that is the page shell's job.

import {
  Chip,
  EntityCell,
  Inline,
  InlinePlaceholder,
  LoadingState,
  MetaLine,
  Stack,
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
  tenantTone,
  truncate,
} from './kbFormat';
import type { KbRegistryEntry } from './types';

const COLUMNS = ['Name', 'Tenant', 'Purpose', 'Status', 'Documents', 'Last sync', ''] as const;

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
    <Table>
      <TableHead>
        <TableRow>
          {COLUMNS.map((c, i) => <TableTh key={c || `actions-${i}`}>{c}</TableTh>)}
        </TableRow>
      </TableHead>
      <TableBody>
        {kbs.map((kb) => (
          <TableRow key={kb.id} clickable onClick={() => onOpen(kb)}>
            <TableTd>
              <EntityCell label={kb.name} id={kb.slug} />
            </TableTd>

            <TableTd>
              <Chip tone={tenantTone(kb.tenant)} size="xs">{kb.tenant}</Chip>
            </TableTd>

            <TableTd className="text-[12px] text-text-secondary">{kb.purpose}</TableTd>

            <TableTd>
              <Stack gap="xs" align="start">
                <StatusChip status={kb.status} />
                {/* The failure reason is the whole point of a FAILED row, but a
                    250-char Bedrock message would set the column width for
                    every other row — clipped here, in full on the detail page. */}
                {kb.errorMessage && (
                  <Inline
                    as="span"
                    gap="none"
                    wrap
                    className="max-w-[200px] break-words text-[10px] text-danger"
                    title={kb.errorMessage}
                  >
                    {truncate(kb.errorMessage, 60)}
                  </Inline>
                )}
              </Stack>
            </TableTd>

            <TableTd className="text-[12px] text-text-secondary tabular-nums whitespace-nowrap">
              {docCountLabel(kb.docCount)}
            </TableTd>

            <TableTd className="whitespace-nowrap">
              <Stack gap="xs" align="start">
                <MetaLine size="xs" items={[formatDate(kb.lastSyncAt)]} />
                {kb.lastSyncStatus && (
                  <Chip tone={syncTone(kb.lastSyncStatus)} size="xs">{kb.lastSyncStatus}</Chip>
                )}
              </Stack>
            </TableTd>

            {/* Row actions must not also open the row. */}
            <TableTd onClick={(e) => e.stopPropagation()}>
              <Inline gap="xs" align="start">
                {kb.status === 'ACTIVE' ? (
                  <SyncButton kbId={kb.id} dataSourceId={kb.dataSourceId} onDone={onRefresh} />
                ) : canProvision(kb) ? (
                  // Provisioning streams its progress over SSE on the detail
                  // page, so starting it here means going there.
                  <ProvisionButton kbId={kb.id} retry={kb.status === 'FAILED'} onDone={() => onOpen(kb)} />
                ) : (
                  <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">
                    {kb.status === 'CREATING' ? 'Provisioning…' : '—'}
                  </Inline>
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
