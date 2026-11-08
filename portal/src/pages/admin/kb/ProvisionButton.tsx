// "Provision" / "Re-provision" — starts the 7-step Bedrock build.
//
// Deliberately does NOT clear its loading state on success: the caller
// navigates to the detail page, where the SSE progress stream lives, so
// flashing the idle label on a page that is unmounting is noise.

import { Button, InlineAlert, Stack } from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { useKbAction } from './useKbAction';

export function ProvisionButton({
  kbId,
  onDone,
  size = 'sm',
  retry = false,
}: {
  kbId: string;
  onDone: () => void;
  size?: 'sm' | 'md';
  /** A KB that already FAILED once: the verb is destructive-ish, so it reads red. */
  retry?: boolean;
}) {
  const { can, ready } = useCapabilities();
  const { loading, error, run } = useKbAction(
    `/api/admin/kb-registry/${kbId}/provision`,
    'POST',
    onDone,
    { settleOnSuccess: false },
  );

  if (!ready || !can('ManageKB')) return null;

  return (
    <Stack gap="xs">
      <Button
        variant={retry ? 'danger-solid' : 'secondary'}
        size={size}
        disabled={loading}
        onClick={run}
      >
        {loading ? 'Starting…' : retry ? 'Re-provision' : 'Provision'}
      </Button>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
    </Stack>
  );
}
