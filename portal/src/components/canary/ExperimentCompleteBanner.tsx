// ExperimentCompleteBanner — sticky top-of-body banner shown when experimentState === 'terminal'.
// Rendered by CanaryPage; reads controllerState from the canary store.

import { useState } from 'react';
import { Banner, Button, Inline, Spinner, T } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
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
  // Pinning and restarting POST /api/observability/canary/start (ManageCanary).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageCanary');

  const isPromoted = controllerState === 'promoted';

  async function handlePinAsBaseline(): Promise<void> {
    setPinning(true);
    setPinError(null);
    try {
      const res = await fetch('/api/observability/canary/start', {
        method: 'POST',
        credentials: 'include',
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

  return (
    <Banner
      variant={isPromoted ? 'success' : 'error'}
      title={
        isPromoted
          ? '✓ Experiment complete — Version B promoted to 100% traffic'
          : '✕ Experiment ended — Version A retained, B rolled back'
      }
    >
      <Inline gap="sm" wrap={false}>
        {pinError && (
          <T size="xs" className="text-danger" title={pinError}>
            Error — see console
          </T>
        )}
        {canManage && (
          <>
            {isPromoted && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => { void handlePinAsBaseline(); }}
                disabled={pinning}
              >
                {pinning && (
                  <Inline as="span" gap="none" className="mr-1.5 align-middle">
                    <Spinner size="sm" color="var(--color-surface)" />
                  </Inline>
                )}
                {pinning ? 'Pinning…' : 'Pin as new baseline A'}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { void handleStartNew(); }}
              disabled={pinning}
            >
              Start new experiment
            </Button>
          </>
        )}
      </Inline>
    </Banner>
  );
}
