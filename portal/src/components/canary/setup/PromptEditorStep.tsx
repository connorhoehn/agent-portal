// PromptEditorStep — Step 2b of the canary setup wizard.
// Full-width editor for creating the challenger prompt by editing from baseline A.

import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { usePromptVersionDetail, saveDraft, publishVersion } from '../usePromptLibrary.js';

export interface PromptEditorStepProps {
  promptId: string;
  promptArn: string; // base ARN without version suffix
  promptName: string;
  versionA: string;
  onBack: () => void;
  onPublished: (newArn: string, newVersion: string) => void;
  onUseDraft: (draftArn: string) => void;
}

// Render template text with {{variables}} highlighted in purple.
function TemplateHighlighted({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/({{[^}]+}})/g);
  return (
    <pre style={preStyle}>
      {parts.map((part, i) => {
        if (/^{{[^}]+}}$/.test(part)) {
          return (
            <span key={i} style={{ color: 'var(--color-optimize)' }}>
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </pre>
  );
}

export function PromptEditorStep({
  promptId,
  promptArn,
  promptName,
  versionA,
  onBack,
  onPublished,
  onUseDraft,
}: PromptEditorStepProps): React.ReactElement {
  const { detail, loading, error: loadError } = usePromptVersionDetail(promptId, versionA);

  const baselineText = detail?.variant?.templateText ?? '';
  const baselineModelId = detail?.variant?.modelId ?? '';
  const baselineInference = detail?.variant?.inferenceConfig;

  const [challengerText, setChallengerText] = useState('');
  const [temperature, setTemperature] = useState<string>('');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [modelId, setModelId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Populate fields once baseline loads
  useEffect(() => {
    if (detail) {
      setChallengerText(detail.variant?.templateText ?? '');
      setModelId(detail.variant?.modelId ?? '');
      setTemperature(
        detail.variant?.inferenceConfig?.temperature !== undefined
          ? String(detail.variant.inferenceConfig.temperature)
          : '',
      );
      setMaxTokens(
        detail.variant?.inferenceConfig?.maxTokens !== undefined
          ? String(detail.variant.inferenceConfig.maxTokens)
          : '',
      );
    }
  }, [detail]);

  async function handleSaveAndPublish(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const inferenceConfig: { temperature?: number; maxTokens?: number } = {};
      if (temperature !== '') inferenceConfig.temperature = parseFloat(temperature);
      if (maxTokens !== '') inferenceConfig.maxTokens = parseInt(maxTokens, 10);

      await saveDraft(
        promptId,
        promptName,
        challengerText,
        modelId || undefined,
        Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined,
      );
      const result = await publishVersion(promptId, description || undefined);
      onPublished(result.arn, result.version);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleUseDraft(): void {
    onUseDraft(promptArn);
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={skeletonStyle} />
        <div style={{ ...skeletonStyle, height: 200 }} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={errorBoxStyle}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-danger)' }}>
          Failed to load baseline template: {loadError}
        </p>
        <button type="button" onClick={onBack} style={secondaryBtnStyle}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16 }}>
      {/* Two-pane editor */}
      <div style={panesStyle}>
        {/* Left — Baseline (A) readonly */}
        <div style={paneStyle}>
          <div style={sectionHeaderStyle}>Baseline (A) — Version {versionA === 'DRAFT' ? 'Draft' : versionA}</div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 4, border: '1px solid var(--color-border, #e2e8f0)', background: 'var(--color-bg, #f8fafc)' }}>
            {baselineText ? (
              <TemplateHighlighted text={baselineText} />
            ) : (
              <pre style={{ ...preStyle, color: 'var(--color-text-tertiary, #94a3b8)', fontStyle: 'italic' }}>
                (no template text)
              </pre>
            )}
          </div>
          {/* Baseline inference info */}
          {(baselineModelId || baselineInference) && (
            <div style={inferenceInfoStyle}>
              {baselineModelId && (
                <span style={inferenceChipStyle} title="Model ID">{baselineModelId}</span>
              )}
              {baselineInference?.temperature !== undefined && (
                <span style={inferenceChipStyle}>temp {baselineInference.temperature}</span>
              )}
              {baselineInference?.maxTokens !== undefined && (
                <span style={inferenceChipStyle}>max {baselineInference.maxTokens} tokens</span>
              )}
            </div>
          )}
        </div>

        {/* Right — Challenger (B) editable */}
        <div style={paneStyle}>
          <div style={sectionHeaderStyle}>Challenger (B) — new version</div>
          <textarea
            value={challengerText}
            onChange={(e) => setChallengerText(e.target.value)}
            style={textareaStyle}
            placeholder="Edit the prompt template here…"
            spellCheck={false}
            aria-label="Challenger prompt template"
          />
        </div>
      </div>

      {/* Inference config row */}
      <div style={inferenceRowStyle}>
        <label style={fieldLabelStyle}>
          Temperature
          <input
            type="number"
            min={0}
            max={1}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder={baselineInference?.temperature !== undefined ? String(baselineInference.temperature) : '0.7'}
            style={smallInputStyle}
          />
        </label>
        <label style={fieldLabelStyle}>
          Max tokens
          <input
            type="number"
            min={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder={baselineInference?.maxTokens !== undefined ? String(baselineInference.maxTokens) : ''}
            style={smallInputStyle}
          />
        </label>
        <label style={{ ...fieldLabelStyle, flex: 2 }}>
          Model ID
          <input
            type="text"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="amazon.nova-pro-v1:0"
            style={{ ...smallInputStyle, fontFamily: 'monospace' }}
          />
        </label>
      </div>

      {/* Action bar */}
      <div style={actionBarStyle}>
        <button type="button" onClick={onBack} style={backBtnStyle} disabled={saving}>
          Back to versions
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What changed? e.g. 'More concise instructions'"
            style={{ ...smallInputStyle, width: '100%', boxSizing: 'border-box' }}
            disabled={saving}
            aria-label="Version description (what changed)"
          />
        </div>

        <button
          type="button"
          onClick={() => { void handleUseDraft(); }}
          style={secondaryBtnStyle}
          disabled={saving}
          title="Use the DRAFT version without publishing a numbered version"
        >
          Use DRAFT without publishing
        </button>

        <button
          type="button"
          onClick={() => { void handleSaveAndPublish(); }}
          style={saving ? { ...primaryBtnStyle, opacity: 0.7, cursor: 'not-allowed' } : primaryBtnStyle}
          disabled={saving || !challengerText.trim()}
        >
          {saving ? 'Saving…' : 'Save to Prompt Library as new version'}
        </button>
      </div>

      {saveError && (
        <div style={saveErrorStyle}>
          {saveError}
        </div>
      )}
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
  marginBottom: 8,
};

const panesStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  flex: 1,
  minHeight: 300,
};

const paneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const preStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.5,
  padding: 12,
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const textareaStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.5,
  padding: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  resize: 'none',
  width: '100%',
  flex: 1,
  background: 'var(--color-bg, #f8fafc)',
  boxSizing: 'border-box',
  minHeight: 200,
  fontWeight: 400,
  color: 'var(--color-text-primary, #0f172a)',
  outline: 'none',
};

const inferenceInfoStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const inferenceChipStyle: CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 3,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontFamily: 'monospace',
};

const inferenceRowStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-end',
  flexWrap: 'wrap',
};

const fieldLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-tertiary, #94a3b8)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  flex: 1,
};

const smallInputStyle: CSSProperties = {
  padding: '5px 8px',
  fontSize: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'var(--color-surface)',
  fontFamily: 'inherit',
  outline: 'none',
};

const actionBarStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  paddingTop: 12,
  borderTop: '1px solid var(--color-border, #e2e8f0)',
  flexWrap: 'wrap',
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
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const secondaryBtnStyle: CSSProperties = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 500,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
  whiteSpace: 'nowrap',
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
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const skeletonStyle: CSSProperties = {
  height: 40,
  borderRadius: 4,
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
};

const errorBoxStyle: CSSProperties = {
  padding: '12px 14px',
  background: 'var(--color-danger-bg)',
  border: '1px solid var(--color-danger-border)',
  borderRadius: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const saveErrorStyle: CSSProperties = {
  padding: '8px 12px',
  background: 'var(--color-danger-bg)',
  border: '1px solid var(--color-danger-border)',
  borderRadius: 4,
  fontSize: 12,
  color: 'var(--color-danger)',
};
