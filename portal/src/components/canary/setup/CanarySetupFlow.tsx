// CanarySetupFlow — Wizard orchestrator for the canary experiment setup.
// Manages state across all steps: library → versions → (editor?) → config.

import { useState } from 'react';
import { Button, Card, Inline, SectionLabel, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import type { PromptLibraryEntry } from '../types.js';
import { PromptLibraryStep } from './PromptLibraryStep.js';
import { VersionPickerStep } from './VersionPickerStep.js';
import { PromptEditorStep } from './PromptEditorStep.js';
import { ExperimentConfigStep } from './ExperimentConfigStep.js';

export interface CanarySetupFlowProps {
  onStarted: () => void;
}

type SetupStep = 'library' | 'versions' | 'editor' | 'config';

interface SetupState {
  step: SetupStep;
  selectedPrompt: PromptLibraryEntry | null;
  versionA: string | null;
  versionB: string | null;
  // After editor publishes or uses DRAFT
  subjectAArn: string;
  subjectBArn: string;
  subjectAVersion: string;
  subjectBVersion: string;
}

const STEP_INDICES: Record<SetupStep, number> = {
  library: 0,
  versions: 1,
  editor: 1, // editor counts as the same "dot" as versions
  config: 2,
};

const STEP_LABELS = ['Choose prompt', 'Pick versions', 'Configure'];

function CheckIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <polyline points="1.5,5.5 4,8 8.5,2" stroke="var(--color-surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface StepIndicatorProps {
  currentStep: SetupStep;
}

function StepIndicator({ currentStep }: StepIndicatorProps): React.ReactElement {
  const activeIndex = STEP_INDICES[currentStep];

  return (
    <Inline gap="none" wrap={false} aria-label="Setup progress">
      {STEP_LABELS.map((label, i) => {
        const completed = i < activeIndex;
        const active = i === activeIndex;
        const reached = completed || active;

        return (
          <Inline
            key={label}
            gap="none"
            wrap={false}
            className={i < STEP_LABELS.length - 1 ? 'flex-1' : undefined}
          >
            <Stack gap="none" align="center" className="gap-1">
              <Inline
                gap="none"
                justify="center"
                wrap={false}
                className={[
                  'w-6 h-6 rounded-full transition-all duration-200',
                  reached ? 'bg-primary' : 'bg-bg border-2 border-border',
                ].join(' ')}
              >
                {completed ? <CheckIcon /> : (
                  <Inline
                    as="span"
                    gap="none"
                    className={`text-xs font-bold ${active ? 'text-white' : 'text-text-tertiary'}`}
                  >
                    {i + 1}
                  </Inline>
                )}
              </Inline>
              <Inline
                as="span"
                gap="none"
                className={[
                  'text-xs whitespace-nowrap',
                  active ? 'font-semibold text-primary'
                    : completed ? 'text-text-secondary' : 'text-text-tertiary',
                ].join(' ')}
              >
                {label}
              </Inline>
            </Stack>
            {i < STEP_LABELS.length - 1 && (
              // mb-[22px] lifts the connector to the dot's centre line: 24px
              // dot + 4px gap + ~14px label, halved.
              <Inline
                gap="none"
                aria-hidden
                className={[
                  'flex-1 h-0.5 rounded-sm mx-2 mb-[22px] transition-colors duration-200',
                  i < activeIndex ? 'bg-primary' : 'bg-border',
                ].join(' ')}
              />
            )}
          </Inline>
        );
      })}
    </Inline>
  );
}

export function CanarySetupFlow({ onStarted }: CanarySetupFlowProps): React.ReactElement {
  const [state, setState] = useState<SetupState>({
    step: 'library',
    selectedPrompt: null,
    versionA: null,
    versionB: null,
    subjectAArn: '',
    subjectBArn: '',
    subjectAVersion: '',
    subjectBVersion: '',
  });

  // Build version ARNs from the prompt ARN + version
  function buildVersionArn(baseArn: string, version: string): string {
    if (version === 'DRAFT') return baseArn;
    // Bedrock ARN format: arn:aws:bedrock:region:account:prompt/ID:version
    if (baseArn.includes(':')) {
      // Strip existing version suffix if present
      const withoutVersion = baseArn.replace(/:\d+$/, '');
      return `${withoutVersion}:${version}`;
    }
    return `${baseArn}:${version}`;
  }

  function goToVersions(prompt: PromptLibraryEntry): void {
    setState((s) => ({ ...s, step: 'versions', selectedPrompt: prompt }));
  }

  function goToEditor(): void {
    setState((s) => ({ ...s, step: 'editor' }));
  }

  function goBackToVersions(): void {
    setState((s) => ({ ...s, step: 'versions' }));
  }

  function goToConfig(aArn: string, aVersion: string, bArn: string, bVersion: string): void {
    setState((s) => ({
      ...s,
      step: 'config',
      subjectAArn: aArn,
      subjectAVersion: aVersion,
      subjectBArn: bArn,
      subjectBVersion: bVersion,
    }));
  }

  function handleVersionsNext(): void {
    const { selectedPrompt, versionA, versionB } = state;
    if (!selectedPrompt || !versionA || !versionB) return;
    const aArn = buildVersionArn(selectedPrompt.arn, versionA);
    const bArn = buildVersionArn(selectedPrompt.arn, versionB);
    goToConfig(aArn, versionA, bArn, versionB);
  }

  function handlePublished(newArn: string, newVersion: string): void {
    const { selectedPrompt, versionA } = state;
    if (!selectedPrompt || !versionA) return;
    const aArn = buildVersionArn(selectedPrompt.arn, versionA);
    goToConfig(aArn, versionA, newArn, newVersion);
  }

  function handleUseDraft(draftArn: string): void {
    const { selectedPrompt, versionA } = state;
    if (!selectedPrompt || !versionA) return;
    const aArn = buildVersionArn(selectedPrompt.arn, versionA);
    goToConfig(aArn, versionA, draftArn, 'DRAFT');
  }

  const versionsNextEnabled = state.versionA !== null && state.versionB !== null;

  return (
    <Inline gap="none" justify="center" align="start" wrap={false} className="min-h-full px-4 py-8 box-border">
      <Card padding="none" className="w-full max-w-[860px]">
        {/* Header */}
        <Stack gap="none" className="px-6 pt-6 pb-4 border-b border-border">
          <SectionLabel as="h2" className="text-sm font-semibold text-text-primary normal-case tracking-normal mb-1.5">
            New canary experiment
          </SectionLabel>
          <T size="sm" tone="secondary" className="leading-normal">
            Compare two prompt versions head-to-head. The controller automatically adjusts
            traffic based on judge scores.
          </T>
        </Stack>

        {/* Step indicator */}
        <Stack gap="none" className="px-6 pb-5">
          <StepIndicator currentStep={state.step} />
        </Stack>

        {/* Step content */}
        <Stack gap="none" className="p-6">
          {state.step === 'library' && (
            <PromptLibraryStep
              selected={state.selectedPrompt}
              onSelect={goToVersions}
            />
          )}

          {(state.step === 'versions') && state.selectedPrompt && (
            <Stack gap="none" className="gap-5">
              <VersionPickerStep
                promptId={state.selectedPrompt.id}
                promptName={state.selectedPrompt.name}
                selectedVersionA={state.versionA}
                selectedVersionB={state.versionB}
                onSelectA={(v) => setState((s) => ({ ...s, versionA: v }))}
                onSelectB={(v) => setState((s) => ({ ...s, versionB: v }))}
                onEditFromA={goToEditor}
              />
              <Inline gap="sm" justify="between" wrap={false} className="pt-3 border-t border-border">
                <Button variant="secondary" size="sm" onClick={() => setState((s) => ({ ...s, step: 'library' }))}>
                  Back
                </Button>
                {/* Button owns its own disabled styling; the old code hand-rolled
                    opacity 0.45 + not-allowed onto a spread of the enabled style. */}
                <Button variant="primary" size="sm" disabled={!versionsNextEnabled} onClick={handleVersionsNext}>
                  Next: Configure
                </Button>
              </Inline>
            </Stack>
          )}

          {state.step === 'editor' && state.selectedPrompt && state.versionA && (
            <PromptEditorStep
              promptId={state.selectedPrompt.id}
              promptArn={state.selectedPrompt.arn}
              promptName={state.selectedPrompt.name}
              versionA={state.versionA}
              onBack={goBackToVersions}
              onPublished={handlePublished}
              onUseDraft={handleUseDraft}
            />
          )}

          {state.step === 'config' && state.selectedPrompt && (
            <ExperimentConfigStep
              promptName={state.selectedPrompt.name}
              subjectAArn={state.subjectAArn}
              subjectAVersion={state.subjectAVersion}
              subjectBArn={state.subjectBArn}
              subjectBVersion={state.subjectBVersion}
              onBack={goBackToVersions}
              onStarted={onStarted}
            />
          )}
        </Stack>
      </Card>
    </Inline>
  );
}

