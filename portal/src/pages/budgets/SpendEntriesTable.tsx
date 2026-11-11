// One group's ledger entries for the period (GET /api/spend/entries): what
// the group's entry count adds up to. Newest first, a few at a time. A job or a
// bot run whose run report can exist opens it; every other source is plain text.
//
// An unknown cost reads "unknown", never $0; a withheld figure is the lock.

import { useRef, useState } from 'react';
import {
  Button,
  Chip,
  DataTable,
  type DataTableColumn,
  Inline,
  LoadingState,
  Stack,
  T,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { showingLabel } from '../../lib/format';
import { relativeTime } from '../../lib/relativeTime';
import { RecordLink } from '../decisions/RecordLink';
import { runHref } from '../iq/runRows';
import { LockedFigure } from '../projects/BudgetAccess';
import { modelLabelFor } from './budgetsFormat';
import { botHref, entryCost, spendEntriesUrl } from './spendReportModel';
import type { BudgetAccessLock, SpendEntriesPage, SpendEntryRow, SpendGroupBy, SpendPeriod } from './types';

const PAGE_SIZE = 25;

export function SpendEntriesTable({ groupBy, groupKey, period, initiativeId, lock }: {
  groupBy: SpendGroupBy;
  /** Null = the group with no key. */
  groupKey: string | null;
  period: SpendPeriod;
  initiativeId?: string | null;
  lock: BudgetAccessLock | undefined;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data, error, refresh } = useFetch<SpendEntriesPage>(spendEntriesUrl(groupBy, groupKey, period, limit, initiativeId), 30_000);
  // Showing more refetches a longer page; keep the rows already on screen meanwhile.
  const last = useRef<SpendEntriesPage | null>(null);
  if (data) last.current = data;
  const page = data ?? last.current;
  const pageLock = page?.budgetAccess ?? lock;

  if (error && !page) {
    return <UnavailableNotice error={error} what="this group's entries" source="Spend is read from the spend ledger" onRetry={refresh} />;
  }
  if (!page) return <LoadingState label="Loading entries…" />;

  const columns: DataTableColumn<SpendEntryRow>[] = [
    {
      key: 'when',
      header: 'When',
      render: (e) => <T size="sm" title={new Date(e.at).toLocaleString()}>{relativeTime(e.at)}</T>,
    },
    { key: 'source', header: 'Source', render: (e) => <T size="sm">{e.sourceLabel}</T> },
    {
      key: 'what',
      header: 'What it was',
      render: (e) => {
        const bot = groupBy !== 'bot' && e.botId ? botHref(e.botId) : null;
        return (
          <Inline align="center" gap="sm" wrap={false} className="min-w-0">
            {e.runRef
              ? <RecordLink to={runHref(e.runRef)} data-testid="spend-entry-run" title="Open this run's report"><T size="sm" className="block max-w-[16rem] truncate">{e.what}</T></RecordLink>
              : <T size="sm" className="block max-w-[16rem] truncate">{e.what}</T>}
            {bot && <RecordLink to={bot} title="Open this bot">bot</RecordLink>}
          </Inline>
        );
      },
    },
    {
      key: 'model',
      header: 'Model',
      priority: 3,
      render: (e) => <T size="sm" tone={e.model ? undefined : 'tertiary'}>{e.model ? modelLabelFor(e.model) : 'not recorded'}</T>,
    },
    {
      key: 'cost',
      header: 'Cost',
      numeric: true,
      render: (e) => {
        const cost = entryCost(e.costUsd, e.costBasis);
        if (!cost) return pageLock ? <LockedFigure lock={pageLock} /> : <T tone="tertiary">—</T>;
        return (
          <Inline align="center" justify="end" gap="sm" wrap={false}>
            {cost.note && <Chip tone="neutral" size="xs" title="Priced from the model's rates; the run did not report a figure.">{cost.note}</Chip>}
            <T tabular tone={cost.text === 'unknown' ? 'secondary' : undefined}>{cost.text}</T>
          </Inline>
        );
      },
    },
    {
      key: 'actor',
      header: 'Person',
      priority: 2,
      render: (e) => <T size="sm" tone={e.actorName ? undefined : 'tertiary'}>{e.actorName ?? '—'}</T>,
    },
  ];

  return (
    <Stack gap="sm" data-testid="spend-entries">
      <DataTable
        data-testid="spend-entries-table"
        narrow
        responsiveColumns
        aria-label="Ledger entries"
        data={page.entries}
        columns={columns}
        keyField={(e) => `${e.source}:${e.sourceId}`}
        emptyMessage="No entries in this window."
      />
      <Inline justify="between" align="center">
        <T size="xs" tone="tertiary">{showingLabel(page.entries.length, page.total, 'entries')}</T>
        {page.entries.length < page.total && (
          <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, page.total - page.entries.length)} more
          </Button>
        )}
      </Inline>
    </Stack>
  );
}
