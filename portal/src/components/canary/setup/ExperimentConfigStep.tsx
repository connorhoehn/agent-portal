// ExperimentConfigStep — Step 3 of the canary setup wizard.
// Summary of both versions and the launch control.

import { useState, useId } from 'react';
import {
  Button, Card, Inline, InlineAlert, MetaLine, SectionLabel, Slider, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { startCanaryExperiment } from '../usePromptLibrary.js';

export interface ExperimentConfigStepProps {
  promptName: string;
  subjectAArn: string;
  subjectAVersion: string;
  subjectBArn: string;
  subjectBVersion: string;
  onStarted: () => void;
  onBack: () => void;
}

function versionLabel(v: string): string {
  return v === 'DRAFT' ? 'Draft' : `Version ${v}`;
}

function truncateArn(arn: string, maxLen = 40): string {
  if (arn.length <= maxLen) return arn;
  return arn.slice(0, maxLen) + '…';
}

export function ExperimentConfigStep({
  promptName,
  subjectAArn,
  subjectAVersion,
  subjectBArn,
  subjectBVersion,
  onStarted,
  onBack,
}: ExperimentConfigStepProps): React.ReactElement {
  const [initialWeight, setInitialWeight] = useState(10);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  async function handleStart(): Promise<void> {
    setStarting(true);
    setStartError(null);
    try {
      await startCanaryExperiment(subjectAArn, subjectBArn, initialWeight);
      onStarted();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Stack gap="none" className="gap-6">
      {/* Summary */}
      <Stack gap="none">
        <SectionLabel className="mb-2">Experiment summary</SectionLabel>
        <Card className="px-4 py-3">
          <Inline gap="none" align="stretch" wrap={false}>
            {/* Baseline A */}
            <Stack gap="none" className="flex-1 min-w-0">
              {/* the A/B accents are literal brand colours, matched to the
                  version picker and the score panels */}
              <SectionLabel as="div" className="mb-1 text-[#3b82f6]">
                Baseline A
              </SectionLabel>
              <Inline as="div" gap="none" className="text-[13px] font-semibold text-text-primary truncate">
                {promptName}
              </Inline>
              <MetaLine size="xs" tone="secondary" items={[versionLabel(subjectAVersion)]} />
              <Inline as="div" gap="none" title={subjectAArn} className="text-[10px] font-mono text-text-tertiary truncate">
                {truncateArn(subjectAArn)}
              </Inline>
            </Stack>

            {/* VS divider */}
            <Inline gap="none" justify="center" className="px-4 self-stretch">
              <Inline as="span" gap="none" className="text-[11px] font-bold text-text-tertiary self-center">
                VS
              </Inline>
            </Inline>

            {/* Challenger B */}
            <Stack gap="none" className="flex-1 min-w-0">
              <SectionLabel as="div" className="mb-1 text-[#a855f7]">
                Challenger B
              </SectionLabel>
              <Inline as="div" gap="none" className="text-[13px] font-semibold text-text-primary truncate">
                {promptName}
              </Inline>
              <MetaLine size="xs" tone="secondary" items={[versionLabel(subjectBVersion)]} />
              <Inline as="div" gap="none" title={subjectBArn} className="text-[10px] font-mono text-text-tertiary truncate">
                {truncateArn(subjectBArn)}
              </Inline>
            </Stack>
          </Inline>
        </Card>
      </Stack>

      {/* Traffic slider */}
      <Stack gap="none">
        <SectionLabel className="mb-2">Initial traffic split</SectionLabel>
        <Inline gap="sm" wrap={false}>
          {/* A plain span, not a <label htmlFor>: Slider exposes no `id`, so
              there is nothing to point `for` at. Its `aria-label` carries the
              accessible name instead. Filed in ui-components-queue.md. */}
          <Inline as="span" gap="none" className="text-[12px] text-text-secondary shrink-0">
            Initial B traffic
          </Inline>
          {/* Slider became reachable from /shared in 2.241.0 — before that it
              was root-barrel only, which is why this was a raw range input
              with a hand-set accentColor. */}
          <Slider
            min={1}
            max={50}
            value={initialWeight}
            onChange={setInitialWeight}
            aria-label="Initial challenger (B) traffic percentage"
            className="flex-1"
          />
          <Inline as="span" gap="none" className="text-[13px] font-semibold tabular-nums text-text-primary w-10 text-right">
            {initialWeight}%
          </Inline>
        </Inline>
        <MetaLine
          size="xs"
          className="mt-1.5 leading-normal"
          items={[`The controller will auto-adjust based on judge scores. `
            + `A receives ${100 - initialWeight}% of traffic initially.`]}
        />
      </Stack>

      {/* Start button */}
      <Stack gap="sm">
        <Button variant="primary" disabled={starting} onClick={() => { void handleStart(); }}>
          {starting ? 'Starting…' : 'Start experiment'}
        </Button>

        {startError && <InlineAlert tone="error">{startError}</InlineAlert>}

        <Button variant="secondary" disabled={starting} onClick={onBack}>Back</Button>
      </Stack>
    </Stack>
  );
}

