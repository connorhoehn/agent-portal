import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, DetailHeader, FormField, Inline, InlineAlert, InlinePlaceholder, Input, SectionLabel, SkeletonCard, Stack } from '@connorhoehnslalom/ui-components/shared';
import { InferenceSettings, type InferenceSettingsValue } from './InferenceSettings';
import { LineNumberedTextarea } from './LineNumberedTextarea';
import { TemplateHighlighted } from './TemplateHighlighted';
import {
  DEFAULT_MAX_TOKENS,
  buildInferenceConfig,
  normalizeMaxTokens,
  versionLabel,
} from './promptFormat';
import {
  publishVersion,
  saveDraft,
  usePromptVersionDetail,
} from '../../../components/canary/usePromptLibrary.js';
import type { Selection } from './types';
import { T } from '../Text';

/** Side-by-side baseline / challenger editor. Saves to DRAFT or publishes a
 *  numbered version. */
export function EditPanel({
  selection,
  onCancel,
  onPublished,
  onDraftSaved,
}: {
  selection: Selection;
  onCancel: () => void;
  onPublished: (newVersion: string, newArn: string) => void;
  onDraftSaved: () => void;
}) {
  const { detail, loading } = usePromptVersionDetail(selection.promptId, selection.version);


  const baselineText = detail?.variant?.templateText ?? '';
  const baselineModelId = detail?.variant?.modelId ?? '';
  const baselineInf = detail?.variant?.inferenceConfig;

  const [challengerText, setChallengerText] = useState('');
  const [inference, setInference] = useState<InferenceSettingsValue>({
    temperature: '', maxTokens: DEFAULT_MAX_TOKENS, modelId: '',
  });
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // Switching modes REPLACES the "Edit / new version" button with this panel,
  // so focus would land on <body> both ways: the editor claims it on mount
  // (autoFocus below), and leaving hands it back to the trigger by its stable
  // data attribute — the button is a fresh node by then, so a captured ref
  // would point at a detached one (same fix as EstimateDrawer.handleClose).
  const close = useCallback(() => {
    onCancel();
    requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>('[data-prompt-edit-trigger]');
      trigger?.focus();
    });
  }, [onCancel]);

  // Escape leaves the editor, the way it leaves every other panel in the app.
  // Ignored while saving: a half-published version is not a thing to abandon
  // on a keystroke.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || saving) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, saving]);

  useEffect(() => {
    if (!detail) return;
    setChallengerText(detail.variant?.templateText ?? '');
    setInference({
      modelId: detail.variant?.modelId ?? '',
      temperature: detail.variant?.inferenceConfig?.temperature !== undefined
        ? String(detail.variant.inferenceConfig.temperature)
        : '',
      maxTokens: normalizeMaxTokens(detail.variant?.inferenceConfig?.maxTokens),
    });
  }, [detail]);

  /** Publishing is save-then-publish: Bedrock numbers whatever is in DRAFT, so
   *  the draft write is not an optimisation, it is how a version gets its text. */
  async function persist(publish: boolean): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSuccessMsg(null);
    try {
      await saveDraft(
        selection.promptId,
        selection.promptName,
        challengerText,
        inference.modelId || undefined,
        buildInferenceConfig(inference.temperature, inference.maxTokens),
      );
      if (!publish) {
        setSuccessMsg('Saved to DRAFT');
        onDraftSaved();
        return;
      }
      const result = await publishVersion(selection.promptId, description || undefined);
      setSuccessMsg(`Published as v${result.version}`);
      onPublished(result.version, result.arn);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Stack gap="md" className="p-6">
        <SkeletonCard height={28} width={240} />
        <SkeletonCard height={300} />
      </Stack>
    );
  }

  const from = versionLabel(selection.version);
  const canSave = !saving && challengerText.trim().length > 0;

  return (
    <Stack gap="lg" className="flex-1 overflow-auto p-6">
      <Stack gap="none" className="border-b border-border pb-4">
        <DetailHeader
          as="h2"
          title={<T className="font-mono">{selection.promptName}</T>}
          description={`Creating new version from ${from}`}
          aside={<Button variant="secondary" onClick={close} disabled={saving}>Cancel</Button>}
          asideWidth={120}
        />
      </Stack>

      <Stack gap="md" className="min-h-[280px] flex-1 md:flex-row">
        <Stack gap="xs" className="min-w-0 flex-1">
          <SectionLabel>Baseline — {from}</SectionLabel>
          <Card padding="none" className="flex-1 overflow-auto bg-surface-panel">
            {baselineText
              ? <TemplateHighlighted text={baselineText} />
              : <InlinePlaceholder size="sm" className="px-6 py-5 font-mono italic">(empty)</InlinePlaceholder>}
          </Card>
          {(baselineModelId || baselineInf) && (
            <Inline gap="xs">
              {baselineModelId && <Chip tone="neutral" size="xs" mono>{baselineModelId}</Chip>}
              {baselineInf?.temperature !== undefined && <Chip tone="neutral" size="xs" mono>temp {baselineInf.temperature}</Chip>}
              {baselineInf?.maxTokens !== undefined && <Chip tone="neutral" size="xs" mono>{baselineInf.maxTokens} tok</Chip>}
            </Inline>
          )}
        </Stack>

        <Stack gap="xs" className="min-w-0 flex-1">
          <SectionLabel>New version</SectionLabel>
          <LineNumberedTextarea
            autoFocus
            value={challengerText}
            onChange={setChallengerText}
            placeholder="Edit the prompt template here…"
          />
        </Stack>
      </Stack>

      <InferenceSettings
        title="Inference settings (new version)"
        value={inference}
        onChange={patch => setInference(prev => ({ ...prev, ...patch }))}
        disabled={saving}
        temperatureFallback={baselineInf?.temperature ?? undefined}
      />

      <Stack gap="md" className="flex-none border-t border-border pt-1">
        <FormField label="What changed?">
          {({ labelId: _labelId, ...field }) => (
            <Input
              {...field}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. 'More concise, removed redundant instructions'"
              disabled={saving}
            />
          )}
        </FormField>

        {successMsg && <InlineAlert tone="success">{successMsg}</InlineAlert>}
        {saveError && <InlineAlert tone="error">{saveError}</InlineAlert>}

        <Inline gap="sm" justify="end">
          <Button
            variant="secondary"
            onClick={() => { void persist(false); }}
            disabled={!canSave}
            title="Overwrite DRAFT without creating a numbered version"
          >
            Save draft
          </Button>
          <Button variant="primary" onClick={() => { void persist(true); }} disabled={!canSave}>
            {saving ? 'Publishing…' : 'Publish new version →'}
          </Button>
        </Inline>
      </Stack>
    </Stack>
  );
}
