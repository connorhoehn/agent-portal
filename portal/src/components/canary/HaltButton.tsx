// HaltButton — confirms before pinning the canary to 100% A and freezing the
// controller. Optimistic local update; if the API call fails we revert and
// surface the error via useToast().

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Modal, useToast } from '@connorhoehnslalom/ui-components/shared';
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
      <button
        type="button"
        onClick={openHaltConfirm}
        disabled={halted || isTerminal}
        style={halted || isTerminal ? haltedBtnStyle : haltBtnStyle}
        title={
          isTerminal
            ? `Experiment complete (${controllerState === 'promoted' ? 'promoted' : 'rolled back'})`
            : halted
            ? 'Already halted'
            : 'Halt canary — pin all traffic to A'
        }
      >
        {isTerminal ? (controllerState === 'promoted' ? 'Promoted' : 'Rolled back') : halted ? 'Halted' : 'Halt canary'}
      </button>

      {confirming && (
        <Modal open={true} onClose={closeHaltConfirm} maxWidth={420}>
          <div style={modalBodyStyle}>
            <h3 style={modalTitleStyle}>Halt canary?</h3>
            <p style={modalBodyTextStyle}>
              Pins 100% of traffic to version A and freezes the controller. The current
              experiment will pause until you manually resume it.
            </p>
            <div style={modalActionsStyle}>
              <button
                type="button"
                onClick={closeHaltConfirm}
                style={secondaryBtnStyle}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={submitting}
                style={confirmBtnStyle}
              >
                {submitting ? 'Halting…' : 'Halt'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

const haltBtnStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid var(--color-danger)',
  borderRadius: 4,
  background: 'var(--color-danger)',
  color: 'var(--color-surface)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const haltedBtnStyle: CSSProperties = {
  ...haltBtnStyle,
  background: 'var(--color-text-tertiary)',
  borderColor: 'var(--color-text-tertiary)',
  cursor: 'not-allowed',
};

const modalBodyStyle: CSSProperties = {
  padding: '16px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const modalTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
  color: 'var(--color-text-primary, #0f172a)',
};

const modalBodyTextStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary, #475569)',
  margin: 0,
  lineHeight: 1.5,
};

const modalActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const secondaryBtnStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const confirmBtnStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid var(--color-danger)',
  borderRadius: 4,
  background: 'var(--color-danger)',
  color: 'var(--color-surface)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
