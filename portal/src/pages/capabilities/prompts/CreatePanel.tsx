import { useState } from 'react';
import { Button, Card, Chip, DetailHeader, FilterChip, FormField, FormRow, Inline, InlineAlert, Input, SectionLabel, Stack, Textarea, T } from '@connorhoehn/ui-components/shared';
import { InferenceSettings, type InferenceSettingsValue } from './InferenceSettings';
import { STARTER_TEMPLATES } from './starterTemplates';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_ID,
  enforceNamePrefix,
  extractVariables,
  isValidNewPrompt,
} from './promptFormat';
import { createPrompt } from '../../../components/canary/usePromptLibrary.js';

/** New-prompt form. Creates a DRAFT in the Bedrock Prompt Library; publishing a
 *  numbered version is a separate step in EditPanel. */
export function CreatePanel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string, arn: string, name: string) => void;
}) {
  const [name, setName] = useState('orgiq-');
  const [description, setDescription] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [inference, setInference] = useState<InferenceSettingsValue>({
    temperature: '', maxTokens: DEFAULT_MAX_TOKENS, modelId: DEFAULT_MODEL_ID,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const previewVars = extractVariables(templateText);
  const canCreate = isValidNewPrompt(name, templateText) && !saving;

  async function create(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      // maxTokens is always sent here (unlike EditPanel, which may inherit from
      // a baseline) because a brand-new prompt has nothing to inherit from.
      const inferenceConfig: { temperature?: number; maxTokens?: number } = {
        maxTokens: parseInt(inference.maxTokens, 10),
      };
      if (inference.temperature !== '') inferenceConfig.temperature = parseFloat(inference.temperature);

      const result = await createPrompt({
        name: name.trim(),
        templateText,
        modelId: inference.modelId.trim() || DEFAULT_MODEL_ID,
        inferenceConfig,
        description: description.trim() || undefined,
      });
      onCreated(result.id, result.arn, result.name);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="lg" className="flex-1 overflow-auto p-6">
      <Stack gap="none" className="border-b border-border pb-4">
        <DetailHeader
          as="h2"
          title="New prompt"
          description="Creates a DRAFT in Bedrock Prompt Library"
          aside={<Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>}
          asideWidth={110}
        />
      </Stack>

      <Stack gap="md" className="flex-1">
        <FormRow stackBelow="md">
          <FormField label="Prompt name" required>
            {({ labelId: _labelId, ...field }) => (
              <Input
                {...field}
                mono
                value={name}
                // The org prefix is not editable — deleting into it snaps back
                // rather than creating a prompt nobody can find later.
                onChange={e => setName(enforceNamePrefix(e.target.value))}
                placeholder="orgiq-my-prompt"
                disabled={saving}
                autoFocus
              />
            )}
          </FormField>
          <FormField label="Description" hint="Optional" className="flex-[2]">
            {({ labelId: _labelId, ...field }) => (
              <Input
                {...field}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What does this prompt do?"
                disabled={saving}
              />
            )}
          </FormField>
        </FormRow>

        <Stack gap="sm">
          <Inline gap="sm" justify="between">
            <SectionLabel>Template *</SectionLabel>
            <Inline gap="xs" justify="end">
              <T size="xs" className="text-text-tertiary">Start from</T>
              {STARTER_TEMPLATES.map(t => (
                <FilterChip
                  key={t.label}
                  size="xs"
                  active={templateText === t.template}
                  onClick={() => setTemplateText(t.template)}
                  disabled={saving}
                >
                  <span title={t.hint}>{t.label}</span>
                </FilterChip>
              ))}
              {templateText && (
                <Button variant="ghost" size="sm" onClick={() => setTemplateText('')} disabled={saving}>
                  Clear ✕
                </Button>
              )}
            </Inline>
          </Inline>
          <Textarea
            value={templateText}
            onChange={e => setTemplateText(e.target.value)}
            placeholder={'Write your prompt template here.\n\nUse {{variable_name}} for dynamic slots that callers fill in at runtime.\n\nExample:\nYou are an expert evaluator.\nAssess whether {{person_name}} is a strong fit for {{topic}}.\nTheir background: {{summary}}'}
            spellCheck={false}
            disabled={saving}
            aria-label="Prompt template"
            className="min-h-[200px] font-mono text-xs leading-relaxed"
          />
        </Stack>

        {previewVars.length > 0 && (
          <Card padding="sm" className="bg-info-bg">
            <Inline gap="xs">
              <SectionLabel>Detected variables</SectionLabel>
              {previewVars.map(v => <Chip key={v} tone="info" size="xs" mono>{v}</Chip>)}
            </Inline>
          </Card>
        )}

        <InferenceSettings
          title="Inference settings"
          value={inference}
          onChange={patch => setInference(prev => ({ ...prev, ...patch }))}
          disabled={saving}
        />
      </Stack>

      <Stack gap="md" className="flex-none border-t border-border pt-1">
        {saveError && <InlineAlert tone="error">{saveError}</InlineAlert>}
        <Inline gap="sm" justify="end">
          <Button variant="primary" onClick={() => { void create(); }} disabled={!canCreate}>
            {saving ? 'Creating…' : 'Create prompt →'}
          </Button>
        </Inline>
      </Stack>
    </Stack>
  );
}
