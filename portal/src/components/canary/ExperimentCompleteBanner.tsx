// ExperimentCompleteBanner — sticky top-of-body banner shown when experimentState === 'terminal'.
// Rendered by CanaryPage; reads controllerState from the canary store.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Spinner } from '@connorhoehnslalom/ui-components/shared';
import { useCanaryStore } from './canaryStore.js';
import { resetCanaryExperiment } from './usePromptLibrary.js';

export interface ExperimentCompleteBannerProps {
  onReset: () => void;
}

export function ExperimentCompleteBanner({ onReset }: ExperimentCompleteBannerProps): React.ReactElement {
  const controllerState = useCanaryStore((s) => s.controllerState);
  const subjectBArn = useCanaryStore((s) => s.subjectBArn);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const isPromoted = controllerState === 'promoted';

  async function handlePinAsBaseline(): Promise<void> {
    setPinning(true);
    setPinError(null);
    try {
      const res = await fetch('/api/observability/canary/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject_a_arn: subjectBArn,
          subject_b_arn: '',
          initial_weight_b: 0,
        }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(msg || `HTTP ${res.status}`);
      }
      await resetCanaryExperiment();
      onReset();
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    } finally {
      setPinning(false);
    }
  }

  async function handleStartNew(): Promise<void> {
    try {
      await resetCanaryExperiment();
      onReset();
    } catch {
      // ignore — store resets regardless
    }
  }

  const bannerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    fontSize: 13,
    flexShrink: 0,
    background: isPromoted ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
    borderBottom: isPromoted ? '1px solid var(--color-success-border)' : '1px solid var(--color-danger-border)',
  };

  const leftTextStyle: CSSProperties = {
    fontWeight: 600,
    color: isPromoted ? 'var(--color-success)' : 'var(--color-danger)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };

  const actionsStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };

  const primaryBtnStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    padding: '5px 14px',
    borderRadius: 5,
    border: 'none',
    background: 'var(--color-success)',
    color: 'var(--color-surface)',
    cursor: pinning ? 'not-allowed' : 'pointer',
    opacity: pinning ? 0.7 : 1,
    fontFamily: 'inherit',
  };

  const secondaryBtnStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    padding: '5px 14px',
    borderRadius: 5,
    border: '1px solid var(--color-border, #e2e8f0)',
    background: 'transparent',
    color: 'var(--color-text-secondary, #475569)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  return (
    <div style={bannerStyle}>
      <div style={leftTextStyle}>
        {isPromoted
          ? '✓ Experiment complete — Version B promoted to 100% traffic'
          : '✕ Experiment ended — Version A retained, B rolled back'}
      </div>
      <div style={actionsStyle}>
        {pinError && (
          <span style={{ fontSize: 11, color: 'var(--color-danger)' }} title={pinError}>
            Error — see console
          </span>
        )}
        {isPromoted && (
          <button
            style={primaryBtnStyle}
            onClick={() => { void handlePinAsBaseline(); }}
            disabled={pinning}
          >
            {pinning && (
              <span style={{ marginRight: 6, verticalAlign: 'middle', display: 'inline-block' }}>
                <Spinner size="sm" color="var(--color-surface)" />
              </span>
            )}
            {pinning ? 'Pinning…' : 'Pin as new baseline A'}
          </button>
        )}
        <button
          style={secondaryBtnStyle}
          onClick={() => { void handleStartNew(); }}
          disabled={pinning}
        >
          Start new experiment
        </button>
      </div>
    </div>
  );
}
