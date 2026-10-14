// PromptEditorStep — Step 2b of the canary setup wizard.
// Full-width editor for creating the challenger prompt by editing from baseline A.

import { useState, useEffect } from 'react';
import {
  Button, Chip, FormField, Inline, InlineAlert, Input, SectionLabel,
  SkeletonCard, Stack, Textarea, T,
} from '@connorhoehnslalom/ui-components/shared';
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
    // `as="pre"` keeps the whitespace semantics a template needs without a
    // styled raw <pre>. CodeBlock is the obvious alternative but it takes a
    // plain string — this renders {{variables}} as highlighted children.
    <Stack as="pre" gap="none" className="m-0 p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-text-primary">
      {parts.map((part, i) => {
        if (/^{{[^}]+}}$/.test(part)) {
          return (
            <Inline as="span" key={i} gap="none" className="text-[var(--color-optimize)]">
              {part}
            </Inline>
          );
        }
        // No className, so this bare span is not a styled raw element — it is
        // just a keyed text node between the highlighted ones.
        return <span key={i}>{part}</span>;
      })}
    </Stack>
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
      <Stack gap="sm">
        <SkeletonCard />
        <SkeletonCard height={200} />
      </Stack>
    );
  }

  if (loadError) {
    return (
      <InlineAlert tone="error">
        Failed to load baseline template: {loadError}
        <Stack gap="none" className="mt-2 items-start">
          <Button variant="secondary" size="sm" onClick={onBack}>Back</Button>
        </Stack>
      </InlineAlert>
    );
  }

  return (
    <Stack gap="none" className="h-full gap-4">
      {/* Two-pane editor */}
      <Inline gap="md" align="stretch" wrap={false} className="flex-1 min-h-0">
        {/* Left — Baseline (A) readonly */}
        <Stack gap="none" className="flex-1 min-w-0">
          <SectionLabel className="mb-1.5">
            Baseline (A) — Version {versionA === 'DRAFT' ? 'Draft' : versionA}
          </SectionLabel>
          <Stack gap="none" className="flex-1 min-h-0 overflow-auto rounded border border-border bg-bg">
            {baselineText ? (
              <TemplateHighlighted text={baselineText} />
            ) : (
              <T size="xs" tone="tertiary" className="p-3 font-mono italic">
                (no template text)
              </T>
            )}
          </Stack>
          {/* Baseline inference info */}
          {(baselineModelId || baselineInference) && (
            <Inline gap="xs" wrap className="mt-1.5">
              {baselineModelId && <Chip tone="neutral" size="xs" mono title="Model ID">{baselineModelId}</Chip>}
              {baselineInference?.temperature !== undefined && (
                <Chip tone="neutral" size="xs">temp {baselineInference.temperature}</Chip>
              )}
              {baselineInference?.maxTokens !== undefined && (
                <Chip tone="neutral" size="xs">max {baselineInference.maxTokens} tokens</Chip>
              )}
            </Inline>
          )}
        </Stack>

        {/* Right — Challenger (B) editable */}
        <Stack gap="none" className="flex-1 min-w-0">
          <SectionLabel className="mb-1.5">Challenger (B) — new version</SectionLabel>
          <Textarea
            value={challengerText}
            onChange={(e) => setChallengerText(e.target.value)}
            placeholder="Edit the prompt template here…"
            spellCheck={false}
            aria-label="Challenger prompt template"
            className="flex-1 min-h-0 font-mono text-xs resize-none"
          />
        </Stack>
      </Inline>

      {/* Inference config row */}
      <Inline gap="sm" align="end" wrap>
        {/* `labelId` dropped from each bag — FormField hands it over but it is
            not a DOM prop. */}
        <FormField label="Temperature" className="flex-1 min-w-0">
          {({ labelId: _l, ...w }) => (
            <Input
              {...w}
              type="number"
              size="sm"
              min={0}
              max={1}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder={baselineInference?.temperature !== undefined ? String(baselineInference.temperature) : '0.7'}
            />
          )}
        </FormField>
        <FormField label="Max tokens" className="flex-1 min-w-0">
          {({ labelId: _l, ...w }) => (
            <Input
              {...w}
              type="number"
              size="sm"
              min={1}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder={baselineInference?.maxTokens !== undefined ? String(baselineInference.maxTokens) : ''}
            />
          )}
        </FormField>
        <FormField label="Model ID" className="flex-[2] min-w-0">
          {({ labelId: _l, ...w }) => (
            <Input
              {...w}
              type="text"
              size="sm"
              mono
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="amazon.nova-pro-v1:0"
            />
          )}
        </FormField>
      </Inline>

      {/* Action bar */}
      <Inline gap="sm" wrap className="pt-3 border-t border-border">
        <Button variant="secondary" size="sm" onClick={onBack} disabled={saving}>
          Back to versions
        </Button>

        <Inline gap="none" className="flex-1 min-w-0">
          <Input
            type="text"
            size="sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What changed? e.g. 'More concise instructions'"
            disabled={saving}
            aria-label="Version description (what changed)"
            className="w-full"
          />
        </Inline>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => { void handleUseDraft(); }}
          disabled={saving}
          title="Use the DRAFT version without publishing a numbered version"
        >
          Use DRAFT without publishing
        </Button>

        <Button
          variant="primary"
          size="sm"
          onClick={() => { void handleSaveAndPublish(); }}
          disabled={saving || !challengerText.trim()}
        >
          {saving ? 'Saving…' : 'Save to Prompt Library as new version'}
        </Button>
      </Inline>

      {saveError && <InlineAlert tone="error">{saveError}</InlineAlert>}
    </Stack>
  );
}

