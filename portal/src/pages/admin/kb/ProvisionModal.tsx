// Confirm, then watch the 7-step Bedrock build over SSE.
//
// Was a hand-rolled fixed-position overlay: its own backdrop, its own card
// shadow, its own ✕, and a hardcoded white background that stayed white in
// every theme. Modal already is all of that. The one behaviour worth keeping
// is that once provisioning has STARTED the dialog stops being dismissable —
// closing it would drop the only progress stream the user has.

import { useState } from 'react';
import {
  Button,
  Inline,
  InlineAlert,
  MetaLine,
  Modal,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { ProvisioningProgress } from '../../../components/kb/ProvisioningProgress.js';
import { writeJson } from '../../../lib/writeJson';
import type { KbRegistryEntry } from './types';

export function ProvisionModal({
  kb,
  open,
  onClose,
  onComplete,
}: {
  kb: KbRegistryEntry;
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [provError, setProvError] = useState<string | null>(null);

  const close = () => {
    setStarted(false);
    setStartError(null);
    setProvError(null);
    onClose();
  };

  async function start() {
    setStartError(null);
    const res = await writeJson(`/api/admin/kb-registry/${kb.id}/provision`, 'POST');
    if (!res.ok) {
      setStartError(res.error);
      return;
    }
    setStarted(true);
  }

  return (
    <Modal
      open={open}
      // Backdrop and ✕ are inert once the stream is live; the Close button
      // below the error is the only exit, and only after a failure.
      onClose={started ? () => {} : close}
      title={started ? 'Provisioning in progress' : 'Provision knowledge base'}
      maxWidth={460}
    >
      <Stack gap="md">
        <MetaLine size="sm" items={[kb.name, <code key="slug">{kb.slug}</code>]} />

        {!started ? (
          <>
            <Inline as="p" gap="none" className="m-0 text-[13px] text-text-secondary">
              This will provision the Bedrock Knowledge Base for <strong>{kb.name}</strong>.
              The 7-step process takes about 2–3 minutes.
            </Inline>
            {kb.status === 'FAILED' && kb.errorMessage && (
              <InlineAlert tone="error">
                <strong>Previous failure:</strong> {kb.errorMessage}
              </InlineAlert>
            )}
            {startError && <InlineAlert tone="error">{startError}</InlineAlert>}
            <Inline gap="sm" justify="end">
              <Button variant="secondary" size="md" onClick={close}>Cancel</Button>
              <Button variant="primary" size="md" onClick={() => void start()}>
                {kb.status === 'FAILED' ? 'Re-provision' : 'Provision'}
              </Button>
            </Inline>
          </>
        ) : (
          <>
            <ProvisioningProgress
              registryId={kb.id}
              onComplete={() => { onComplete(); close(); }}
              onError={(msg) => setProvError(msg)}
            />
            {provError && (
              <>
                <InlineAlert tone="error">{provError}</InlineAlert>
                <Inline gap="sm" justify="end">
                  <Button variant="secondary" size="md" onClick={close}>Close</Button>
                </Inline>
              </>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
