// The run table's columns, shared by a paired machine's History tab. Moved out of the old
// Local compute page unchanged.

import { Link as RouterLink } from 'react-router';
import { Chip, EntityCell, Inline, MetaLine, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { usd } from '../../lib/format';
import { LiveJobCell } from './LiveJobCell';
import { truncate, when } from './localComputeFormat';
import { runOrigin, type RunRow } from './localComputeTypes';

export function runColumns(now: number): DataTableColumn<RunRow>[] {
  return [
    {
      key: 'title',
      header: 'Run',
      sortable: true,
      // The run's own page (/iq/work/:jobId) is where the readable activity,
      // the produced proposals and the Accept/Reject live. This row used to be
      // a dead label: a machine would finish a job, park it in review, and the
      // only place that said so offered no way to go and look at it.
      render: (r) => {
        const origin = runOrigin(r);
        return (
          <Inline gap="sm" wrap={false} className="min-w-0" title={r.result?.summary ? truncate(r.result.summary, 200) : undefined}>
            <EntityCell label={r.title} href={`/iq/work/${encodeURIComponent(r.id)}`} className="min-w-0" />
            {origin && (
              <RouterLink
                to={origin.href}
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-primary no-underline hover:underline"
              >
                {origin.label} →
              </RouterLink>
            )}
          </Inline>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <LiveJobCell job={r} now={now} />,
    },
    {
      key: 'machine',
      header: 'Machine',
      render: (r) => <MetaLine size="xs" items={[r.nodeLabel ?? '—']} />,
    },
    {
      key: 'started',
      header: 'Started',
      sortable: true,
      render: (r) => when(r.startedAt ?? r.createdAt),
    },
    {
      key: 'cost',
      header: 'Cost',
      render: (r) => {
        if (r.result?.provider === 'local') return <Chip tone="success" size="xs">$0</Chip>;
        if (r.result?.costUsd != null) return <MetaLine size="xs" items={[usd(r.result.costUsd)]} />;
        return <MetaLine size="xs" tone="tertiary" items={['—']} />;
      },
    },
    {
      key: 'act',
      header: '',
      // `awaiting_review` is a request addressed to a person, and until now it
      // was delivered as a grey chip with nowhere to go. A state that is
      // waiting on you should carry the thing you do about it.
      render: (r) => (
        r.status === 'awaiting_review' ? (
          <RouterLink
            to={`/iq/work/${encodeURIComponent(r.id)}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-medium text-primary no-underline hover:underline"
          >
            Review →
          </RouterLink>
        ) : null
      ),
    },
  ];
}
