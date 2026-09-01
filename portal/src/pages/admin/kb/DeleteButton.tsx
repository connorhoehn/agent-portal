// Deletes the registry row, the Bedrock KB (if provisioned) and the Aurora
// vector table. Offered only where the KB is not live.

import { useState } from 'react';
import { Button, ConfirmDialog, InlineAlert, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { useKbAction } from './useKbAction';

export function DeleteButton({
  kbId,
  kbName,
  onDone,
  size = 'sm',
}: {
  kbId: string;
  kbName: string;
  onDone: () => void;
  size?: 'sm' | 'md';
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { can, ready } = useCapabilities();
  const { loading, error, run } = useKbAction(
    `/api/admin/kb-registry/${kbId}`,
    'DELETE',
    onDone,
    { settleOnSuccess: false },
  );

  if (!ready || !can('ManageKB')) return null;

  return (
    <Stack gap="xs">
      <Button
        variant="danger"
        size={size}
        disabled={loading}
        onClick={() => setConfirmOpen(true)}
        title={`Delete "${kbName}" and all associated resources`}
      >
        {loading ? 'Deleting…' : 'Delete'}
      </Button>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <ConfirmDialog
        open={confirmOpen}
        onConfirm={() => { setConfirmOpen(false); run(); }}
        onCancel={() => setConfirmOpen(false)}
        tone="destructive"
        title={`Delete "${kbName}"?`}
        body="This will remove the DB registry row, delete the Bedrock KB (if provisioned), and drop the Aurora vector table. This cannot be undone."
      />
    </Stack>
  );
}
