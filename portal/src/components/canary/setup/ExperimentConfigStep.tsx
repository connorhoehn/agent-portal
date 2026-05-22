// ExperimentConfigStep — Step 3 of the canary setup wizard.
// Summary of both versions and the launch control.

import { useState, useId } from 'react';
import type { CSSProperties } from 'react';
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
  const trafficSliderId = useId();

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Summary */}
      <div>
        <div style={sectionHeaderStyle}>Experiment summary</div>
        <div style={summaryCardStyle}>
          {/* Baseline A */}
          <div style={summaryColStyle}>
            <div style={{ ...sideLabelStyle, color: '#3b82f6' }}>Baseline A</div>
            <div style={summaryNameStyle}>{promptName}</div>
            <div style={summaryVersionStyle}>{versionLabel(subjectAVersion)}</div>
            <div style={summaryArnStyle} title={subjectAArn}>
              {truncateArn(subjectAArn)}
            </div>
          </div>

          {/* VS divider */}
          <div style={vsDividerStyle}>
            <div style={vsTextStyle}>VS</div>
          </div>

          {/* Challenger B */}
          <div style={summaryColStyle}>
            <div style={{ ...sideLabelStyle, color: '#a855f7' }}>Challenger B</div>
            <div style={summaryNameStyle}>{promptName}</div>
            <div style={summaryVersionStyle}>{versionLabel(subjectBVersion)}</div>
            <div style={summaryArnStyle} title={subjectBArn}>
              {truncateArn(subjectBArn)}
            </div>
          </div>
        </div>
      </div>

      {/* Traffic slider */}
      <div>
        <div style={sectionHeaderStyle}>Initial traffic split</div>
        <div style={sliderRowStyle}>
          <label htmlFor={trafficSliderId} style={sliderLabelStyle}>Initial B traffic</label>
          <input
            id={trafficSliderId}
            type="range"
            min={1}
            max={50}
            value={initialWeight}
            onChange={(e) => setInitialWeight(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--color-primary, #6366f1)', cursor: 'pointer' }}
            aria-label="Initial challenger (B) traffic percentage"
          />
          <span style={sliderValueStyle}>{initialWeight}%</span>
        </div>
        <p style={helperTextStyle}>
          The controller will auto-adjust based on judge scores.
          A receives {100 - initialWeight}% of traffic initially.
        </p>
      </div>

      {/* Start button */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          onClick={() => { void handleStart(); }}
          disabled={starting}
          style={starting ? { ...startBtnStyle, opacity: 0.7, cursor: 'not-allowed' } : startBtnStyle}
        >
          {starting ? 'Starting…' : 'Start experiment'}
        </button>

        {startError && (
          <div style={errorBoxStyle}>{startError}</div>
        )}

        <button
          type="button"
          onClick={onBack}
          disabled={starting}
          style={backBtnStyle}
        >
          Back
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sectionHeaderStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginBottom: 12,
};

const summaryCardStyle: CSSProperties = {
  display: 'flex',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  overflow: 'hidden',
};

const summaryColStyle: CSSProperties = {
  flex: 1,
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const sideLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 4,
};

const summaryNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-primary, #0f172a)',
};

const summaryVersionStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #475569)',
};

const summaryArnStyle: CSSProperties = {
  fontSize: 11,
  fontFamily: 'monospace',
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginTop: 4,
  wordBreak: 'break-all',
};

const vsDividerStyle: CSSProperties = {
  width: 1,
  background: 'var(--color-border, #e2e8f0)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  flexShrink: 0,
};

const vsTextStyle: CSSProperties = {
  position: 'absolute',
  background: '#fff',
  padding: '4px 6px',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--color-text-tertiary, #94a3b8)',
  letterSpacing: '0.05em',
};

const sliderRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const sliderLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--color-text-secondary, #475569)',
  flexShrink: 0,
};

const sliderValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--color-primary, #6366f1)',
  minWidth: 36,
  textAlign: 'right',
};

const helperTextStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
  margin: '8px 0 0',
  lineHeight: 1.5,
};

const startBtnStyle: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  fontSize: 14,
  fontWeight: 700,
  border: 'none',
  borderRadius: 6,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: '0.02em',
};

const backBtnStyle: CSSProperties = {
  width: '100%',
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

const errorBoxStyle: CSSProperties = {
  padding: '8px 12px',
  background: '#fee2e2',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  fontSize: 12,
  color: '#991b1b',
};
