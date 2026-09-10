// HaltButton — confirms before pinning the canary to 100% A and freezing the
// controller. Optimistic local update; if the API call fails we revert and
// surface the error via useToast().

import { useState } from 'react';
import {
  Button, Inline, MetaLine, Modal, SectionLabel, Stack, useToast,
} from '@connorhoehnslalom/ui-components/shared';
import {
  closeHaltConfirm,
  openHaltConfirm,
  setHalted,
  useCanaryStore,
} from './canaryStore.js';

export function HaltButton(): React.ReactElement {
  const halted = useCanaryStore((s) => s.halted);
  const controllerState = useCanaryStore((s) => s.controllerState);
  const confirming = useCanaryStore((s) => s.confirmHaltOpen);
  const isTerminal = controllerState === 'promoted' || controllerState === 'rolled_back';
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  async function onConfirm(): Promise<void> {
    setSubmitting(true);
    const previous = halted;
    setHalted(true);
    try {
      const res = await fetch('/api/observability/canary/halt', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ halt: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        const reason = body.message ?? body.error ?? `${res.status} ${res.statusText}`;
        setHalted(previous);
        toast(`Halt failed: ${reason}`, { type: 'error' });
      } else {
        toast('Canary halted — all traffic pinned to version A.', { type: 'success' });
        closeHaltConfirm();
      }
    } catch (e) {
      setHalted(previous);
      toast(`Halt failed: ${(e as Error).message}`, { type: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {/* Button's `danger` variant is exactly the halted/live distinction the
          two style objects were drawing by hand, and it owns the disabled
          treatment. */}
      <Button
        variant="danger"
        size="sm"
        onClick={openHaltConfirm}
        disabled={halted || isTerminal}
        title={
          isTerminal
            ? `Experiment complete (${controllerState === 'promoted' ? 'promoted' : 'rolled back'})`
            : halted
            ? 'Already halted'
            : 'Halt canary — pin all traffic to A'
        }
      >
        {isTerminal ? (controllerState === 'promoted' ? 'Promoted' : 'Rolled back') : halted ? 'Halted' : 'Halt canary'}
      </Button>

      {confirming && (
        <Modal open={true} onClose={closeHaltConfirm} maxWidth={420}>
          <Stack gap="md" className="px-4.5 py-4">
            <SectionLabel as="h3" className="text-[14px] font-semibold text-text-primary normal-case tracking-normal">
              Halt canary?
            </SectionLabel>
            <MetaLine
              tone="secondary"
              className="leading-normal"
              items={['Pins 100% of traffic to version A and freezes the controller. The current '
                + 'experiment will pause until you manually resume it.']}
            />
            <Inline gap="sm" justify="end" wrap={false}>
              <Button variant="secondary" size="sm" onClick={closeHaltConfirm} disabled={submitting}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={onConfirm} disabled={submitting}>
                {submitting ? 'Halting…' : 'Halt'}
              </Button>
            </Inline>
          </Stack>
        </Modal>
      )}
    </>
  );
}








