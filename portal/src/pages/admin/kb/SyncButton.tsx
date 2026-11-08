// "Sync Now" — kicks a Bedrock ingestion job for the KB's data source.

import { Button, InlineAlert, Stack, T } from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { useKbAction } from './useKbAction';

export function SyncButton({
  kbId,
  dataSourceId,
  onDone,
  size = 'sm',
}: {
  kbId: string;
  dataSourceId: string | null;
  onDone: () => void;
  size?: 'sm' | 'md';
}) {
  const { can, ready } = useCapabilities();
  const { loading, error, conflict, run } = useKbAction(
    `/api/admin/kb-registry/${kbId}/sync`, 'POST', onDone,
  );

  if (!ready || !can('ManageKB')) return null;
  // No data source means nothing to ingest FROM — the verb would 400.
  if (!dataSourceId) return <T as="span" size="xs" tone="tertiary">—</T>;

  return (
    <Stack gap="xs">
      <Button variant="primary" size={size} disabled={loading} onClick={run}>
        {loading ? 'Starting…' : 'Sync Now'}
      </Button>
      {/* "A sync is already running" is the pipeline working, so it reads as
          information. Red here trains an operator to distrust the page. */}
      {error && <InlineAlert tone={conflict ? 'info' : 'error'}>{error}</InlineAlert>}
    </Stack>
  );
}
