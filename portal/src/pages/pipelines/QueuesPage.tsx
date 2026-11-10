import { ofTotal } from '../../lib/plural';
import { useUrlState } from '../../lib/useUrlState';
import { useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { Banner, BranchIcon, Chip, CollapsibleSection, CollectionToolbar, DataTable, IconButton, Inline, KeyValue, ListIcon, PageSection, Stack, StatStrip, T, Tooltip, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RecordLink } from '../decisions/RecordLink';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { pipelineCollectionAdapter, filterQueues } from './pipelineCollectionCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { queueTotal, type PipelineQueue, type PipelineQueuesResponse } from '../../lib/pipelineQueues';

const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString();
const columns: DataTableColumn<PipelineQueue>[] = [
  { key: 'name', header: 'Queue', sortable: true, compare: (a, b) => a.name.localeCompare(b.name), render: row => <Stack gap="none"><RecordLink to={`/pipelines/queues?queue=${encodeURIComponent(row.name)}`}><T size="sm" weight="medium">{row.name}</T></RecordLink><T size="xs" tone="secondary">{row.purpose}</T></Stack> },
  { key: 'state', header: 'Status', render: row => <Chip size="xs" tone={row.state === 'unavailable' ? 'danger' : row.state === 'missing' || (row.deadLetter && (row.snapshot?.ready ?? 0) > 0) ? 'warning' : 'neutral'}>{row.state === 'available' ? row.deadLetter ? 'Dead-letter queue' : 'Available' : row.state === 'missing' ? 'Not created' : 'Unavailable'}</Chip> },
  { key: 'ready', header: 'Ready', numeric: true, render: row => count(row.snapshot?.ready) },
  { key: 'inFlight', header: 'In flight', numeric: true, render: row => count(row.snapshot?.inFlight) },
  { key: 'delayed', header: 'Delayed', numeric: true, render: row => count(row.snapshot?.delayed) },
];

export default function QueuesPage() {
  const navigate = useNavigate();
  const gateway = useGatewayOptional();
  const { data, error, isLoading, refresh } = useFetch<PipelineQueuesResponse>('/api/pipelines/queues', 15_000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  // The open queue is the URL (`?queue=<name>`): its read status renders under the table.
  const [selected, setSelected] = useUrlState<string | null>('queue', (raw) => raw || null, (v) => v, { replace: false });
  const rows = data?.queues ?? [];
  const filtered = filterQueues(rows, query, filter);
  const adapter = pipelineCollectionAdapter('queues', { setQuery, setFilter, refresh,
    scopeNote: 'Search and filter the queues shown. Unknown counts stay unknown. Commands never consume, retry, purge or send messages.' });
  const row = filtered.find(row => row.name === selected);
  const work = rows.filter(row => !row.deadLetter);
  const dlqs = rows.filter(row => row.deadLetter);
  const incomplete = rows.filter(row => row.state !== 'available' || !row.snapshot || Object.values(row.snapshot).some(value => value == null));
  return <CollectionCommandPage data-testid="pipelines-queues" title="Queues" description="Delivery backlog, work in flight, and failed deliveries.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar {...{ label: 'Queue filters', search: { value: query, onChange: setQuery, placeholder: 'Search queues', 'aria-label': 'Search queues' },
        filters: [{ id: 'status', label: 'Queue filter', value: filter, onChange: setFilter, options: [
          { value: '', label: 'All queues' }, { value: 'available', label: 'Available' }, { value: 'missing', label: 'Not created' },
          { value: 'unavailable', label: 'Unavailable' }, { value: 'dead-letter', label: 'Dead-letter' }, { value: 'work', label: 'Work queues' },
        ] }],
        summary: data ? `${ofTotal(filtered.length, rows.length, 'queue')} · ${data.backend === 'http' ? 'Message-queue service' : 'In-process queue'}` : 'Reading queue metadata…',
        notices: data ? [`Checked ${new Date(data.observedAt).toLocaleTimeString()}. Refreshes every 15 seconds.`] : [],
        onRefresh: refresh, refreshing: isLoading,
      }} />

    {data?.backend === 'memory' && <Banner variant="warning">These queues run inside the app process. Their messages do not survive a restart.</Banner>}
    {error && <UnavailableNotice error={error} what="queue metadata" source="Queue transport" onRetry={refresh} />}
    {data && !error && <>
      <StatStrip variant="line" items={[
        { label: 'registered queues', value: rows.length }, { label: 'ready', value: count(queueTotal(work, 'ready')) },
        { label: 'in flight', value: count(queueTotal(work, 'inFlight')) }, { label: 'delayed', value: count(queueTotal(work, 'delayed')) },
        { label: 'dead-letter ready', value: count(queueTotal(dlqs, 'ready')) },
      ]} />
      {incomplete.length > 0 && <T size="xs" tone="secondary" wrap>Some attributes are unavailable. A dash means unknown, not zero. Select a queue for its read status.</T>}
    </>}
    {!error && <DataTable narrow data-testid="pipeline-queues-table" columns={columns} data={filtered}
      keyField={row => row.name} loading={isLoading && !data} pageSize={25} onRowClick={row => setSelected(row.name)} emptyMessage={query || filter ? 'No queues match these filters.' : 'No queues registered.'} />}
    {row && !error && <PageSection title={row.name} description={row.purpose}>
      <Stack gap="sm" data-testid="pipeline-queue-details">
        {row.reason && <T size="sm" tone="secondary" wrap>{row.reason}</T>}
        <KeyValue items={[
          { label: 'Visibility timeout', value: row.snapshot?.visibilityTimeoutSeconds == null ? 'Not reported' : `${row.snapshot.visibilityTimeoutSeconds}s` },
          { label: 'Ordering', value: row.snapshot?.fifo == null ? 'Not reported by service' : row.snapshot.fifo ? 'FIFO' : 'Standard' },
          { label: 'Configured dead-letter target', value: row.redriveTo ?? 'None registered here' },
          { label: 'Configured maximum deliveries', value: row.maxReceives ?? 'Not registered here' },
        ]} />
        <T size="xs" tone="secondary" wrap>Retry targets describe this app’s registration. Native queue settings may differ. This view reads metadata without taking messages from consumers.</T>
      </Stack>
    </PageSection>}
    <CollapsibleSection title="About queue delivery" density="compact">
      <Stack gap="sm">
        <Inline gap="sm" align="center" wrap><Chip size="xs" tone={gateway?.connectionState === 'connected' ? 'success' : 'warning'}>{gateway?.connectionState === 'connected' ? 'Realtime connected' : 'Realtime disconnected'}</Chip><T size="sm">Run progress uses realtime-modules.</T></Inline>
        <T size="sm" tone="secondary" wrap>Pipeline workers consume these queues and acknowledge successful loads. Failed deliveries retry and eventually move to their dead-letter queue.</T>
        <T size="sm" tone="secondary" wrap>The run ledger reads jobs, bot runs, and assessment commands. Run pages subscribe to authorized progress channels; queue counts are separate HTTP snapshots. A connected gateway does not prove workers are processing messages.</T>
        <Inline gap="sm"><Tooltip content="View runs"><IconButton size="sm" aria-label="View runs" icon={<ListIcon />} onClick={() => navigate('/pipelines/runs')} /></Tooltip><Tooltip content="Definitions"><IconButton size="sm" aria-label="Definitions" icon={<BranchIcon />} onClick={() => navigate('/pipelines/definitions')} /></Tooltip></Inline>
      </Stack>
    </CollapsibleSection>
  </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>;
}
