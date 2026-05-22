// CanarySetupFlow — Wizard orchestrator for the canary experiment setup.
// Manages state across all steps: library → versions → (editor?) → config.

import { useState } from 'react';
import type { CSSProperties } from 'react';
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
    <div style={stepIndicatorWrapStyle} aria-label="Setup progress">
      {STEP_LABELS.map((label, i) => {
        const completed = i < activeIndex;
        const active = i === activeIndex;

        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: i < STEP_LABELS.length - 1 ? 1 : undefined }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: completed || active
                    ? 'var(--color-primary, #6366f1)'
                    : 'var(--color-bg, #f8fafc)',
                  border: completed || active
                    ? 'none'
                    : '2px solid var(--color-border, #e2e8f0)',
                  transition: 'all 0.2s',
                }}
              >
                {completed ? (
                  <CheckIcon />
                ) : (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: active ? '#fff' : 'var(--color-text-tertiary, #94a3b8)',
                  }}>
                    {i + 1}
                  </span>
                )}
              </div>
              <span style={{
                fontSize: 11,
                fontWeight: active ? 600 : 400,
                color: active
                  ? 'var(--color-primary, #6366f1)'
                  : completed
                  ? 'var(--color-text-secondary, #475569)'
                  : 'var(--color-text-tertiary, #94a3b8)',
                whiteSpace: 'nowrap',
              }}>
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div style={{
                ...connectorStyle,
                background: i < activeIndex
                  ? 'var(--color-primary, #6366f1)'
                  : 'var(--color-border, #e2e8f0)',
              }} />
            )}
          </div>
        );
      })}
    </div>
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
    <div style={outerStyle}>
      <div style={cardStyle}>
        {/* Header */}
        <div style={cardHeaderStyle}>
          <h2 style={titleStyle}>New canary experiment</h2>
          <p style={subtitleStyle}>
            Compare two prompt versions head-to-head. The controller automatically adjusts
            traffic based on judge scores.
          </p>
        </div>

        {/* Step indicator */}
        <div style={{ padding: '0 24px 20px' }}>
          <StepIndicator currentStep={state.step} />
        </div>

        {/* Step content */}
        <div style={contentStyle}>
          {state.step === 'library' && (
            <PromptLibraryStep
              selected={state.selectedPrompt}
              onSelect={goToVersions}
            />
          )}

          {(state.step === 'versions') && state.selectedPrompt && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <VersionPickerStep
                promptId={state.selectedPrompt.id}
                promptName={state.selectedPrompt.name}
                selectedVersionA={state.versionA}
                selectedVersionB={state.versionB}
                onSelectA={(v) => setState((s) => ({ ...s, versionA: v }))}
                onSelectB={(v) => setState((s) => ({ ...s, versionB: v }))}
                onEditFromA={goToEditor}
              />
              <div style={stepNavStyle}>
                <button
                  type="button"
                  onClick={() => setState((s) => ({ ...s, step: 'library' }))}
                  style={backBtnStyle}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleVersionsNext}
                  disabled={!versionsNextEnabled}
                  style={versionsNextEnabled ? primaryBtnStyle : { ...primaryBtnStyle, opacity: 0.45, cursor: 'not-allowed' }}
                >
                  Next: Configure
                </button>
              </div>
            </div>
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
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const outerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  minHeight: '100%',
  padding: '32px 16px',
  boxSizing: 'border-box',
};

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 860,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  overflow: 'hidden',
};

const cardHeaderStyle: CSSProperties = {
  padding: '24px 24px 16px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
};

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: 'var(--color-text-primary, #0f172a)',
  margin: '0 0 6px',
};

const subtitleStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #475569)',
  margin: 0,
  lineHeight: 1.5,
};

const contentStyle: CSSProperties = {
  padding: 24,
};

const stepIndicatorWrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
};

const connectorStyle: CSSProperties = {
  flex: 1,
  height: 2,
  borderRadius: 1,
  margin: '0 8px',
  marginBottom: 22, // align with dot center (24px dot + 4px gap + ~14px label / 2)
  transition: 'background 0.2s',
};

const stepNavStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingTop: 12,
  borderTop: '1px solid var(--color-border, #e2e8f0)',
};

const backBtnStyle: CSSProperties = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 500,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const primaryBtnStyle: CSSProperties = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  borderRadius: 4,
  background: 'var(--color-primary, #6366f1)',
  color: 'var(--color-surface)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
